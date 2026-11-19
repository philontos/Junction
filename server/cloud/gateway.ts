import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { createServer } from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { CloudError, CloudStore, digest } from './store.js';
import { TunnelBroker } from './tunnel.js';
import { fail, proxyHttp, proxyUpgrade } from './proxy.js';
import { junctionProvisioner } from './registration.js';

export interface GatewayConfig { root: string; data: string; origin: string; junctionPort: number; bundle?: string; registrationTokenFile?: string }
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const bearer = (authorization = '') => /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization)?.[1] || '';
const cookie = (header = '') => /(?:^|;\s*)sw_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(header)?.[1] || '';
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));

export function createGateway(config: GatewayConfig) {
  const origin = new URL(config.origin).origin, secure = origin.startsWith('https:');
  const provision = config.registrationTokenFile ? junctionProvisioner(config.junctionPort,config.registrationTokenFile) : null;
  const store = new CloudStore(config.data), broker = new TunnelBroker();
  const app = express(); app.disable('x-powered-by');
  const server = createServer({ maxHeaderSize: 32 * 1024 }, app);
  server.headersTimeout = 20_000; server.requestTimeout = 180_000;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  const terminals = new Map<Duplex,{session:string;device:string}>();
  const authTimer = setInterval(() => {
    for (const [socket, binding] of terminals) {
      const u=store.session(binding.session);
      if (!u || !store.device(binding.device,u.id)) socket.destroy();
    }
  },20_000); authTimer.unref();
  const limits = new Map<string, { start: number; count: number }>();
  // Only trust this header on the private listener: the packaged nginx
  // overwrites it, and the gateway never listens on a public interface.
  const clientIp = (req: express.Request) => String(req.headers['x-real-ip'] || req.socket.remoteAddress).slice(0,64);
  function rate(key: string, max = 20) {
    const now = Date.now();
    if (limits.size > 10000) for (const [k,v] of limits) if (v.start < now-600000) limits.delete(k);
    if (limits.size > 10000) throw new CloudError(429, '请求过多，请稍后再试。');
    const item = limits.get(key);
    if (!item || item.start < now-600000) { limits.set(key,{start:now,count:1}); return; }
    if (++item.count > max) throw new CloudError(429, '请求过多，请稍后再试。');
  }
  const csrf = (req: express.Request) => {
    if (!['GET','HEAD','OPTIONS'].includes(req.method) && req.headers.origin !== origin) throw new CloudError(403, '请求来源无效，请刷新当前网页。');
  };
  const user = (req: express.Request) => {
    const u = store.session(cookie(req.headers.cookie)); if (!u) throw new CloudError(401, '请先登录。'); return u;
  };
  function session(res: express.Response, token: string) {
    res.setHeader('Set-Cookie', `sw_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${secure ? '; Secure' : ''}`);
  }
  app.use((req,res,next) => {
    res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Cache-Control':'no-store'});
    next();
  });
  app.get('/healthz', (_req,res) => res.json({status:'ok',service:'switchyard-cloud',protocol:'switchyard-tunnel/1'}));
  app.use('/hub', express.json({limit:'8kb'}));
  app.post('/hub/register', async (req,res) => {
    try {
      csrf(req);
      if (!provision) throw new CloudError(403,'暂未开放注册。');
      rate('register:'+clientIp(req),5); rate('register-total',100);
      if (typeof req.body?.user !== 'string' || typeof req.body?.password !== 'string') throw new CloudError(400,'请填写账号和密码。');
      const account = store.reserveRegistration(req.body.user,req.body.password);
      await provision(account);
      const result = store.completeRegistration(account.id);
      session(res,result.token); res.status(201).json({user_id:result.user_id,username:result.username});
    } catch (error) { fail(res,error instanceof CloudError ? error : new CloudError(503,'注册暂时不可用，请稍后重试。')); }
  });
  app.post('/hub/login', (req,res) => {
    csrf(req); rate('login:'+clientIp(req)); rate('login-user:'+String(req.body.user).trim().toLowerCase().slice(0,64),30); rate('login-total',200);
    const result=store.login(String(req.body.user || ''),String(req.body.password || '')); session(res,result.token); res.json({user_id:result.user_id,username:result.username});
  });
  app.post('/hub/activate', (req,res) => {
    csrf(req); rate('activate:'+clientIp(req));
    const result=store.activate(String(req.body.code || ''),String(req.body.password || '')); session(res,result.token); res.json({user_id:result.user_id,username:result.username});
  });
  app.get('/hub/session', (req,res) => { const u=store.session(cookie(req.headers.cookie));res.json({user_id:u?.id || null,username:u?.username || null,registration_open:!!provision}); });
  app.post('/hub/logout', (req,res) => {
    csrf(req); const token=cookie(req.headers.cookie); store.logout(token);
    for (const [socket,binding] of terminals) if(digest(binding.session)===digest(token)) socket.destroy();
    res.setHeader('Set-Cookie',`sw_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`); res.json({ok:true});
  });
  app.get('/hub/devices', (req,res) => res.json({items:store.devices(user(req).id).map(d=>({...d,online:broker.nodes.has(d.id)}))}));
  app.post('/hub/pairings', (req,res) => { csrf(req); const u=user(req); rate('pair:'+u.id);const code=store.pair(u.id);res.json({code,installation_id:digest(code),expires_in:600,origin}); });
  app.get('/hub/installations/:id', (req,res) => {
    const row=store.installation(req.params.id,user(req).id);if(!row)throw new CloudError(404,'安装记录不存在。');
    const device=row.device_id && store.device(row.device_id,row.user_id);
    res.json({id:row.id,step:row.step,status:row.status,issue:row.issue,updated_at:row.updated_at,expires:row.expires,
      device_id:device ? device.id : null,online:!!device && broker.nodes.has(device.id)});
  });
  app.post('/hub/installations/claim', (req,res) => {
    rate('install-claim:'+clientIp(req),120);
    const row=store.claimInstallation(String(req.body.code || ''),String(req.body.instance_id || ''));
    res.json({id:row.id,expires:row.expires});
  });
  app.post('/hub/installations/progress', (req,res) => {
    rate('install-progress:'+clientIp(req),1200);
    const {code,instance_id,step,status,issue}=req.body;
    const device=store.deviceByToken(bearer(req.headers.authorization));
    if(device)store.attachInstallation(String(code || ''),device);
    if(status==='succeeded' && (!device || !broker.nodes.has(device.id)))throw new CloudError(409,'设备尚未通过云端连接验证。');
    store.installationProgress(String(code || ''),String(instance_id || ''),String(step || ''),String(status || ''),String(issue || 'none'));
    res.json({ok:true});
  });
  app.get('/hub/node', (req,res) => {
    const device=store.deviceByToken(bearer(req.headers.authorization));if(!device)throw new CloudError(401,'设备凭证无效。');
    res.json({device_id:device.id,user_id:device.user_id,instance_id:device.instance_id,online:broker.nodes.has(device.id)});
  });
  app.post('/hub/enroll', (req,res) => {
    rate('enroll:'+clientIp(req),60);
    const result=store.enroll(String(req.body.code || ''),String(req.body.instance_id || ''),String(req.body.name || ''),String(req.body.device_token || ''));
    res.json({...result,server:origin,protocol:'switchyard-tunnel/1'});
  });
  app.delete('/hub/devices/:id', (req,res) => {csrf(req);store.revoke(req.params.id,user(req).id);broker.disconnect(req.params.id);res.json({ok:true});});

  // Device credentials are scoped at this gateway. Junction retains its own
  // identity/authorization model; owner credentials never leave the gateway.
  app.use('/v1', (req,res) => {
    const device=store.deviceByToken(bearer(req.headers.authorization));
    if (!device) throw new CloudError(401,'设备凭证无效。');
    const account=store.user(device.user_id)!;
    const token=fs.readFileSync(account.junction_token_file,'utf8').trim();
    proxyHttp(req,res,req.originalUrl,net.connect(config.junctionPort,'127.0.0.1'),{authorization:'Bearer '+token});
  });

  app.use('/nodes', async (req,res) => {
    try {
      const match=new RegExp(`^/(${uuid})(/.*)?$`).exec(req.url);
      if(!match)throw new CloudError(404,'设备路径不存在。');
      const device=store.device(match[1],user(req).id);if(!device)throw new CloudError(404,'设备不存在。');
      const route=match[2] || '/';
      if(!route.startsWith('/api/'))throw new CloudError(404,'接口不存在。');
      csrf(req);
      const length=Number(req.headers['content-length'] || 0);
      if(length>40*1024*1024)throw new CloudError(413,'请求过大。');
      const stream=await broker.open(device.id);
      if(req.aborted || res.destroyed){stream.destroy();return;}
      if(!store.session(cookie(req.headers.cookie)) || !store.device(device.id,user(req).id)){stream.destroy();throw new CloudError(401,'登录或设备绑定已失效。');}
      proxyHttp(req,res,route,stream);
    }catch(error){fail(res,error);}
  });

  // A distinct device in every URL prevents a second browser tab from changing
  // the execution target of an already open task view.
  app.get(new RegExp(`^/workspace/(${uuid})/?$`), (req,res) => {
    const u=store.session(cookie(req.headers.cookie));if(!u){res.redirect('/');return;}
    const device=store.device(req.params[0],u.id);if(!device)throw new CloudError(404,'设备不存在。');
    const prefix='/nodes/'+device.id;
    let html=fs.readFileSync(path.join(config.root,'web/index.html'),'utf8');
    html=html.replace('<head>',`<head><meta name="switchyard-base" content="${prefix}"><link rel="stylesheet" href="/cloud/workspace.css">`);
    html=html.replace('<span style="flex:1"></span>',`<span style="flex:1"></span><a href="/" class="sec cloud-device-link" title="${escape(device.name)} · 切换设备"><span class="cloud-device-name">${escape(device.name)} · 切换设备</span><span class="cloud-device-short">设备</span></a>`);
    res.type('html').send(html);
  });
  app.get('/', (_req,res) => res.sendFile(path.join(config.root,'web/cloud/index.html')));
  app.get('/install.sh', (_req,res) => {
    const script=fs.readFileSync(path.join(config.root,'scripts/cloud-install.sh'),'utf8').replaceAll('__SWITCHYARD_ORIGIN__',origin);
    res.type('text/plain').send(script);
  });
  app.get('/downloads/node.tar.gz', (_req,res) => {
    if(!config.bundle)throw new CloudError(503,'安装包尚未就绪。');res.download(config.bundle,'switchyard-node.tar.gz');
  });
  app.get('/downloads/bundles/:hash.tar.gz', (req,res) => {
    if(!config.bundle || !/^[a-f0-9]{64}$/.test(req.params.hash))throw new CloudError(404,'安装包不存在。');
    const file=path.join(path.dirname(config.bundle),'bundles',req.params.hash+'.tar.gz');
    if(!fs.existsSync(file))throw new CloudError(404,'安装包不存在。');
    res.download(file,'switchyard-node.tar.gz');
  });
  app.get('/downloads/node.sha256', (_req,res) => {
    if(!config.bundle)throw new CloudError(503,'安装包尚未就绪。');res.type('text/plain').send(fs.readFileSync(config.bundle+'.sha256','utf8'));
  });
  app.use('/vendor/highlight',express.static(path.join(config.root,'node_modules/@highlightjs/cdn-assets')));
  app.use(express.static(path.join(config.root,'web'),{index:false,dotfiles:'deny'}));
  app.use((_req,res) => res.status(404).json({error:'页面不存在。'}));
  app.use((error:any,_req:express.Request,res:express.Response,_next:express.NextFunction) => {
    if(error?.type==='entity.too.large'){res.status(413).json({error:'请求过大。'});return;}
    fail(res,error);
  });

  server.on('upgrade', async (req,socket,head) => {
    try {
      const url=new URL(req.url || '/','http://localhost');
      if(url.pathname==='/relay/control' || url.pathname==='/relay/stream') {
        if(req.headers.origin)throw new CloudError(403,'Native nodes only');
        const device=store.deviceByToken(bearer(req.headers.authorization));if(!device)throw new CloudError(401,'Unauthorized');
        const id=url.searchParams.get('id') || '';
        if(url.pathname==='/relay/stream' && !broker.accepts(device.id,id))throw new CloudError(404,'Unknown stream');
        sockets.handleUpgrade(req,socket,head,ws => url.pathname==='/relay/control' ? broker.connect(device.id,ws) : broker.attach(device.id,id,ws));
        return;
      }
      const match=new RegExp(`^/nodes/(${uuid})(/pty)$`).exec(url.pathname);
      const u=store.session(cookie(req.headers.cookie));
      if(!match || !u || req.headers.origin!==origin || !store.device(match[1],u.id))throw new CloudError(403,'Forbidden');
      const stream=await broker.open(match[1]);
      if(socket.destroyed){stream.destroy();return;}
      // Recheck after awaiting the node: a logout/revoke can happen meanwhile.
      if(!store.session(cookie(req.headers.cookie)) || !store.device(match[1],u.id)){stream.destroy();throw new CloudError(403,'Forbidden');}
      terminals.set(socket,{session:cookie(req.headers.cookie),device:match[1]});
      socket.on('close',()=>terminals.delete(socket));
      proxyUpgrade(req,socket,head,'/pty'+url.search,stream);
    }catch(error){socket.end(`HTTP/1.1 ${error instanceof CloudError ? error.status : 502} Error\r\nConnection: close\r\n\r\n`);}
  });
  return {app,server,store,broker,close:()=>{clearInterval(authTimer);for(const socket of terminals.keys())socket.destroy();broker.close();sockets.close();server.close();store.db.close();}};
}
