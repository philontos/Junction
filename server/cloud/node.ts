import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import WebSocket, { createWebSocketStream } from 'ws';

export function startNodeTunnel(server: string, token: string, port: number, onState = (_state: string) => {}) {
  const origin=new URL(server);
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1','localhost'].includes(origin.hostname))) throw new Error('HTTPS required');
  const base=origin.origin.replace(/^http/,'ws');
  let stopped=false,control:WebSocket|undefined,retry:NodeJS.Timeout|undefined,delay=1000;
  const streams=new Set<WebSocket>();
  function connect() {
    if(stopped)return;
    const ws=control=new WebSocket(base+'/relay/control',{headers:{Authorization:'Bearer '+token},handshakeTimeout:15000,maxPayload:8192,perMessageDeflate:false});
    let heartbeat=Date.now();
    const watch=setInterval(()=>{if(Date.now()-heartbeat>65000)ws.terminate();},15000);watch.unref();
    ws.on('ping',()=>{heartbeat=Date.now();});
    ws.on('error',()=>{});
    ws.on('message',raw=>{
      let m:any;try{m=JSON.parse(raw.toString());}catch{ws.close(1008,'Invalid protocol');return;}
      if(m.type==='ready' && m.protocol==='switchyard-tunnel/1'){delay=1000;onState('online');return;}
      if(m.type!=='connect' || !/^[0-9a-f-]{36}$/.test(m.id) || streams.size>=48){ws.close(1008,'Invalid stream request');return;}
      const channel=new WebSocket(base+'/relay/stream?id='+m.id,{headers:{Authorization:'Bearer '+token},handshakeTimeout:15000,maxPayload:1024*1024,perMessageDeflate:false});
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
      clearInterval(watch);for(const stream of streams)stream.terminate();streams.clear();onState('offline');
      if(!stopped){retry=setTimeout(connect,delay+Math.random()*500);delay=Math.min(delay*2,30000);}
    });
  }
  connect();
  return {close(){stopped=true;clearTimeout(retry);control?.terminate();for(const stream of streams)stream.terminate();}};
}

async function daemon(configPath:string) {
  const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
  const dir=path.dirname(configPath), lock=path.join(dir,'daemon.lock');
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
    SWITCHYARD_JUNCTION_CONFIG:path.join(dir,'junction.json')}});
  let stopping=false,tunnel:ReturnType<typeof startNodeTunnel>|undefined;
  const stop=()=>{if(stopping)return;stopping=true;tunnel?.close();child.kill('SIGTERM');};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
  process.on('exit',()=>{try{fs.unlinkSync(lock);}catch{}});
  child.on('error',()=>{console.error('Local Switchyard failed to start');process.exitCode=1;stop();});
  child.on('exit',()=>{tunnel?.close();process.exit(stopping?0:1);});
  let ready=false;
  for(let i=0;i<120 && !stopping;i++){
    try{const r=await fetch(`http://127.0.0.1:${port}/api/junction/connection`,{signal:AbortSignal.timeout(1000)});if(r.ok){ready=true;break;}}catch{}
    await new Promise(r=>setTimeout(r,250));
  }
  if(!ready){stop();throw new Error('Local Switchyard startup timeout');}
  fs.writeFileSync(path.join(dir,'runtime.json'),JSON.stringify({port,pid:process.pid,device_id:config.device_id}),{mode:0o600});
  tunnel=startNodeTunnel(config.server,config.device_token,port,state=>console.log(new Date().toISOString()+' node '+state));
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const file=process.argv[2];if(!file)throw new Error('Usage: node.ts CONFIG');
  daemon(path.resolve(file)).catch(error=>{console.error(error.message);process.exit(1);});
}
