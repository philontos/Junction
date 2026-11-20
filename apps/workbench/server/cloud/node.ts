import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import WebSocket, { createWebSocketStream } from 'ws';
import { createLocalWorkspace, listenLocalWorkspace, type LocalAccessRequest, type LocalAccessResult } from './local-workspace.js';
import { cloudSocketOptions, configureCloudNetwork } from './network.js';

export function startNodeTunnel(server: string, token: string, port: number, onState = (_state: string, _error?: string) => {}, localAccess?: (request: LocalAccessRequest) => LocalAccessResult, localOrigin?: string, outboundInterface = '') {
  const origin=new URL(server);
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1','localhost'].includes(origin.hostname))) throw new Error('HTTPS required');
  const base=origin.origin.replace(/^http/,'ws');
  let stopped=false,control:WebSocket|undefined,retry:NodeJS.Timeout|undefined,delay=1000;
  const streams=new Set<WebSocket>();
  const errorCode = (error: any) => /^[A-Z][A-Z0-9_]{1,63}$/.test(error?.code || '') ? error.code : /timed out/i.test(error?.message || '') ? 'CONNECT_TIMEOUT' : 'CONNECTION_FAILED';
  const reconnect = () => {
    if (!stopped) { retry=setTimeout(connect,delay+Math.random()*500);delay=Math.min(delay*2,30000); }
  };
  function connect() {
    if(stopped)return;
    let socketOptions;
    try { socketOptions=cloudSocketOptions(outboundInterface); }
    catch (error) { onState('offline',errorCode(error)); reconnect(); return; }
    const ws=control=new WebSocket(base+'/relay/control',{...socketOptions,headers:{Authorization:'Bearer '+token},handshakeTimeout:15000,maxPayload:8192,perMessageDeflate:false});
    let lastError: string | undefined;
    let heartbeat=Date.now();
    const watch=setInterval(()=>{if(Date.now()-heartbeat>65000)ws.terminate();},15000);watch.unref();
    ws.on('ping',()=>{heartbeat=Date.now();});
    ws.on('error',error=>{lastError=errorCode(error);});
    ws.on('message',raw=>{
      let m:any;try{m=JSON.parse(raw.toString());}catch{ws.close(1008,'Invalid protocol');return;}
      if(m.type==='ready' && m.protocol==='switchyard-tunnel/1'){
        delay=1000;onState('online');
        if(localAccess && m.capabilities?.includes('local-workspace/1'))ws.send(JSON.stringify({type:'capabilities',features:['local-workspace/1', ...(localOrigin ? ['local-discovery/1'] : [])],local_origin:localOrigin}));
        return;
      }
      if(m.type==='local-access' && localAccess && /^[0-9a-f-]{36}$/.test(m.id)) {
        try { ws.send(JSON.stringify({type:'local-access-result',id:m.id,result:localAccess(m.user)})); }
        catch { ws.send(JSON.stringify({type:'local-access-result',id:m.id,error:true})); }
        return;
      }
      if(m.type!=='connect' || !/^[0-9a-f-]{36}$/.test(m.id) || streams.size>=48){ws.close(1008,'Invalid stream request');return;}
      let channel: WebSocket;
      try { channel=new WebSocket(base+'/relay/stream?id='+m.id,{...cloudSocketOptions(outboundInterface),headers:{Authorization:'Bearer '+token},handshakeTimeout:15000,maxPayload:1024*1024,perMessageDeflate:false}); }
      catch { return; } // A temporarily missing interface must not crash the node.
      streams.add(channel);channel.on('error',()=>{});channel.on('close',()=>streams.delete(channel));
      channel.on('open',()=>{
        // The cloud can only reach this process's fixed loopback Switchyard,
        // never an arbitrary host, file, or port supplied in a command.
        const tcp=net.connect(port,'127.0.0.1');
        const tunnel=createWebSocketStream(channel,{highWaterMark:64*1024});
        const close=()=>{tcp.destroy();tunnel.destroy();};
        tcp.on('error',close);tunnel.on('error',close);tcp.on('close',()=>tunnel.destroy());tunnel.on('close',()=>tcp.destroy());
        tcp.pipe(tunnel);tunnel.pipe(tcp);
      });
    });
    ws.on('close',()=>{
      clearInterval(watch);for(const stream of streams)stream.terminate();streams.clear();
      if (!stopped) { onState('offline',lastError); reconnect(); }
    });
  }
  connect();
  return {close(){stopped=true;clearTimeout(retry);control?.terminate();for(const stream of streams)stream.terminate();}};
}

async function daemon(configPath:string) {
  const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
  const dir=path.dirname(configPath), lock=path.join(dir,'daemon.lock');
  const networkFile=path.join(dir,'network.json');
  const network=fs.existsSync(networkFile) ? JSON.parse(fs.readFileSync(networkFile,'utf8')) : {};
  const outboundInterface=typeof network.outbound_interface==='string' ? network.outbound_interface.trim() : '';
  if (outboundInterface) configureCloudNetwork(config.server,outboundInterface);
  if(fs.existsSync(lock)){
    const pid=Number(fs.readFileSync(lock,'utf8'));
    if(Number.isSafeInteger(pid)&&pid>0){try{process.kill(pid,0);throw new Error('Node already running');}catch(e:any){if(e.code!=='ESRCH')throw e;}}
    fs.unlinkSync(lock);
  }
  fs.writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
  const listener=net.createServer();await new Promise<void>(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const port=(listener.address() as net.AddressInfo).port;await new Promise<void>(resolve=>listener.close(()=>resolve()));
  const child=spawn(process.execPath,['--import','tsx','server/index.ts'],{cwd:root,stdio:['ignore','inherit','inherit'],env:{...process.env,
    HOST:'127.0.0.1',HOSTS:'127.0.0.1',PORT:String(port),TASK_DISPATCHER_DATA_DIR:path.join(dir,'data'),SWITCHYARD_CLOUD_MANAGED:'1',
    SWITCHYARD_JUNCTION_CONFIG:path.join(dir,'junction.json'),
    ...(typeof config.workspace_root === 'string' ? {JUNCTION_WORKSPACE_ROOT:config.workspace_root} : {}),
    SWITCHYARD_CLOUD_NETWORK_ORIGIN:config.server,SWITCHYARD_CLOUD_NETWORK_INTERFACE:outboundInterface}});
  let stopping=false,tunnel:ReturnType<typeof startNodeTunnel>|undefined,local:ReturnType<typeof createLocalWorkspace>|undefined;
  const stop=()=>{if(stopping)return;stopping=true;tunnel?.close();local?.close();child.kill('SIGTERM');};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
  process.on('exit',()=>{try{fs.unlinkSync(lock);}catch{}});
  child.on('error',()=>{console.error('Local Switchyard failed to start');process.exitCode=1;stop();});
  child.on('exit',()=>{tunnel?.close();local?.close();process.exit(stopping?0:1);});
  let ready=false;
  for(let i=0;i<120 && !stopping;i++){
    try{const r=await fetch(`http://127.0.0.1:${port}/api/junction/connection`,{signal:AbortSignal.timeout(1000)});if(r.ok){ready=true;break;}}catch{}
    await new Promise(r=>setTimeout(r,250));
  }
  if(!ready){stop();throw new Error('Local Switchyard startup timeout');}
  let localPort:number|undefined;
  try {
    local=createLocalWorkspace({root,cloudOrigin:config.server,deviceId:config.device_id,deviceName:os.hostname(),deviceToken:config.device_token,upstreamPort:port});
    localPort=await listenLocalWorkspace(local.server,path.join(dir,'local-workspace-port'));
  }catch(error){local?.close();local=undefined;console.error('Local workspace unavailable:',(error as Error).message);}
  const startedAt=Date.now();
  const runtime=(state:string,error?:string)=>{
    const file=path.join(dir,'runtime.json'),temporary=file+'.'+process.pid;
    fs.writeFileSync(temporary,JSON.stringify({port,local_port:localPort,pid:process.pid,device_id:config.device_id,root,state,error,started_at:startedAt,updated_at:Date.now()}),{mode:0o600});
    fs.renameSync(temporary,file);
  };
  runtime('connecting');
  tunnel=startNodeTunnel(config.server,config.device_token,port,(state,error)=>{runtime(state,error);console.log(new Date().toISOString()+' node '+state+(error?' '+error:''));},local ? request=>local!.issue(request) : undefined,local?.origin(),outboundInterface);
}
if(process.argv[1] && fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url)) {
  const file=process.argv[2];if(!file)throw new Error('Usage: node.ts CONFIG');
  daemon(path.resolve(file)).catch(error=>{console.error(error.message);process.exit(1);});
}
