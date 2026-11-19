// A control WebSocket asks the node to open one outbound WebSocket per TCP
// stream. HTTP and terminal framing stay with Node/OpenSSH-compatible HTTP
// servers; stream.pipe provides backpressure. Requests are never replayed.
import crypto from 'node:crypto';
import type { Duplex } from 'node:stream';
import WebSocket, { createWebSocketStream } from 'ws';
import { CloudError } from './store.js';
import type { LocalAccessRequest, LocalAccessResult } from '../../../packages/node-transport/local-access.js';

interface Pending { device: string; resolve: (stream: Duplex) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
interface Control { ws: WebSocket; alive: boolean; streams: Set<WebSocket>; pending: Set<string>; local: boolean }
interface Access { device: string; resolve: (result: LocalAccessResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
export class TunnelBroker {
  readonly nodes = new Map<string, Control>();
  readonly pending = new Map<string, Pending>();
  private readonly access = new Map<string, Access>();
  private heartbeat: NodeJS.Timeout;
  constructor() {
    this.heartbeat = setInterval(() => {
      for (const [id, node] of this.nodes) {
        if (!node.alive) { this.disconnect(id); continue; }
        node.alive = false; node.ws.ping();
        for (const stream of node.streams) if (stream.readyState === WebSocket.OPEN) stream.ping();
      }
    }, 20_000);
    this.heartbeat.unref();
  }
  connect(id: string, ws: WebSocket) {
    this.disconnect(id);
    const node: Control = { ws, alive: true, streams: new Set(), pending: new Set(), local: false };
    this.nodes.set(id, node);
    ws.on('pong', () => { node.alive = true; });
    ws.on('error', () => {});
    ws.on('close', () => { if (this.nodes.get(id) === node) this.disconnect(id); });
    // Only a capability advertisement and replies to requested local grants
    // are accepted. Nodes cannot issue gateway commands or select other nodes.
    ws.on('message', raw => {
      let message: any;
      try { message = JSON.parse(raw.toString()); } catch { ws.close(1008, 'Invalid message'); return; }
      if (message.type === 'capabilities' && Array.isArray(message.features)) { node.local = message.features.includes('local-workspace/1'); return; }
      const request = message.type === 'local-access-result' && this.access.get(message.id);
      if (!request || request.device !== id) { ws.close(1008, 'Unexpected control message'); return; }
      clearTimeout(request.timer); this.access.delete(message.id);
      if (message.error) { request.reject(new CloudError(409, '本机工作台暂时不可用，请稍后重试。')); return; }
      try {
        const url = new URL(message.result.url);
        const fragment = new URLSearchParams(url.hash.slice(1));
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/local/open' || url.search || fragment.get('device') !== id || !/^[A-Za-z0-9_-]{43}$/.test(fragment.get('code') || '') || message.result.expires_in !== 60) throw new Error();
        request.resolve({ url: url.href, expires_in: 60 });
      } catch { request.reject(new CloudError(502, '本机工作台返回了无效的地址。')); }
    });
    ws.send(JSON.stringify({ type: 'ready', protocol: 'switchyard-tunnel/1', capabilities: ['local-workspace/1'] }));
  }
  disconnect(id: string) {
    const node = this.nodes.get(id); if (!node) return;
    this.nodes.delete(id);
    for (const key of node.pending) {
      const request = this.pending.get(key); if (!request) continue;
      clearTimeout(request.timer); this.pending.delete(key);
      request.reject(new CloudError(503, '设备连接已断开，请先检查任务状态再重试。'));
    }
    for (const stream of node.streams) stream.terminate();
    for (const [key, request] of this.access) if (request.device === id) {
      clearTimeout(request.timer); this.access.delete(key); request.reject(new CloudError(503, '设备连接已断开。'));
    }
    node.ws.terminate();
  }
  localAvailable(device: string) { return this.nodes.get(device)?.local === true; }
  localAccess(device: string, user: LocalAccessRequest): Promise<LocalAccessResult> {
    const node = this.nodes.get(device);
    if (!node || node.ws.readyState !== WebSocket.OPEN) return Promise.reject(new CloudError(503, '设备离线，请先启动本机节点。'));
    if (!node.local) return Promise.reject(new CloudError(409, '此设备需要更新节点，才能使用本机工作台。'));
    if (this.access.size >= 128) return Promise.reject(new CloudError(429, '请求繁忙，请稍后重试。'));
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { this.access.delete(id); reject(new CloudError(504, '连接本机工作台超时，请重试。')); }, 10000); timer.unref();
      this.access.set(id, { device, resolve, reject, timer });
      node.ws.send(JSON.stringify({ type: 'local-access', id, user }));
    });
  }
  open(device: string): Promise<Duplex> {
    const node = this.nodes.get(device);
    if (!node || node.ws.readyState !== WebSocket.OPEN) return Promise.reject(new CloudError(503, '设备离线，请启动本机节点。'));
    if (node.pending.size + node.streams.size >= 48 || this.pending.size >= 256) return Promise.reject(new CloudError(429, '设备连接繁忙，请稍后再试。'));
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        node.pending.delete(id); this.pending.delete(id); reject(new CloudError(504, '连接本机节点超时。'));
      }, 15_000); timer.unref();
      node.pending.add(id); this.pending.set(id, { device, resolve, reject, timer });
      node.ws.send(JSON.stringify({ type: 'connect', id }));
    });
  }
  accepts(device: string, id: string) { return this.pending.get(id)?.device === device && this.nodes.has(device); }
  attach(device: string, id: string, ws: WebSocket) {
    const request = this.pending.get(id), node = this.nodes.get(device);
    if (!request || request.device !== device || !node) { ws.close(1008, 'Unknown stream'); return; }
    clearTimeout(request.timer); this.pending.delete(id); node.pending.delete(id); node.streams.add(ws);
    ws.on('error', () => {}); ws.on('close', () => node.streams.delete(ws));
    const stream = createWebSocketStream(ws, { highWaterMark: 64 * 1024 });
    stream.on('error', () => {});
    request.resolve(stream);
  }
  close() { clearInterval(this.heartbeat); for (const id of this.nodes.keys()) this.disconnect(id); }
}
