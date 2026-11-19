import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { requestGateway } from './install-network.js';

const [origin, directory] = process.argv.slice(2);
if (!origin || new URL(origin).protocol !== 'https:' || !directory || !path.isAbsolute(directory)) throw new Error('Invalid installation target');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = path.resolve(directory), configFile = path.join(dir, 'node.json');
const xml = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
function save(file: string, data: string) {
  const temporary = file + '.' + crypto.randomBytes(6).toString('hex');
  fs.writeFileSync(temporary, data, {mode:0o600,flag:'wx'}); fs.renameSync(temporary,file);
}
function run(command: string, args: string[], optional = false) {
  const result = spawnSync(command, args, {encoding:'utf8'});
  if (!optional && (result.error || result.status !== 0)) throw new Error(`${command} 失败：${result.stderr || result.error?.message}`);
}
async function install() {
const code = fs.readFileSync(0, 'utf8').trim();
fs.mkdirSync(path.join(dir, 'data'), {recursive:true,mode:0o700});
const identityFile = path.join(dir, 'data/controller-id');
let instance: string;
if (fs.existsSync(identityFile)) instance = fs.readFileSync(identityFile,'utf8').trim();
else { instance = crypto.randomBytes(4).toString('hex'); save(identityFile,instance+'\n'); }
const claim=await requestGateway(origin,'/hub/installations/claim',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,instance_id:instance})});
if(!claim.ok)throw new Error((await claim.json() as any).error || '安装码无效，请在网页重新生成命令。');
let config: any;
async function identity(token:string) {
  const response=await requestGateway(origin,'/hub/node',{headers:{Authorization:'Bearer '+token}});
  if(response.status===401)return undefined;
  if(!response.ok)throw new Error('暂时无法核对设备身份，请检查网络后重试。');
  return await response.json() as any;
}
async function progress(status:string,step='start',attempts=3) {
  const response=await requestGateway(origin,'/hub/installations/progress',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.device_token},
    body:JSON.stringify({code,instance_id:instance,step,status,issue:'none'})},attempts);
  if(!response.ok)throw new Error((await response.json() as any).error || '无法确认安装状态，请重试。');
}
if (fs.existsSync(configFile)) {
  config = JSON.parse(fs.readFileSync(configFile,'utf8'));
  if (config.server !== origin) throw new Error('现有节点属于另一个云服务。');
  const current=await identity(config.device_token);
  if(!current)config=undefined;
  else {config={...config,...current};save(configFile,JSON.stringify(config,null,2)+'\n');}
}
if (!config) {
  // Persist a random credential BEFORE enrolling. If the response is lost,
  // the next attempt can recover the committed identity without making a
  // duplicate device or storing plaintext credentials on the cloud.
  const pendingFile=path.join(dir,'enrollment.json');
  let pending=fs.existsSync(pendingFile) ? JSON.parse(fs.readFileSync(pendingFile,'utf8')) : undefined;
  if(!pending || pending.server!==origin || pending.instance_id!==instance) {
    pending={server:origin,instance_id:instance,device_token:crypto.randomBytes(32).toString('base64url')};
    save(pendingFile,JSON.stringify(pending)+'\n');
  }
  const recovered=await identity(pending.device_token);
  if(recovered)config={...recovered,device_token:pending.device_token,server:origin,schema_version:1};
  else {
  // A prior pending credential may have been revoked. A 401 confirms it is
  // not an active identity; rotate it before starting a fresh enrollment.
  pending.device_token=crypto.randomBytes(32).toString('base64url');save(pendingFile,JSON.stringify(pending)+'\n');
  try {
    const result = await requestGateway(origin,'/hub/enroll',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({code,instance_id:instance,name:os.hostname(),device_token:pending.device_token})},1);
    const body = await result.json() as any;
    if (!result.ok) throw new Error(body.error || '绑定失败');
    config = {...body,server:origin,schema_version:1};
  }catch(error){
    const confirmed=await identity(pending.device_token);
    if(!confirmed)throw error;
    config={...confirmed,device_token:pending.device_token,server:origin,schema_version:1};
  }
  }
  save(configFile,JSON.stringify(config,null,2)+'\n');
  fs.unlinkSync(pendingFile);
}
if(config.instance_id!==instance)throw new Error('设备标识与现有配置不一致，请保留节点目录并联系维护者。');
await progress('running');
const tokenFile=path.join(dir,'device.token');save(tokenFile,config.device_token+'\n');
save(path.join(dir,'junction.json'),JSON.stringify({url:origin,default_account:'device',accounts:[{id:'device',label:config.user_id,token_file:tokenFile}]},null,2)+'\n');
// Separate profile and service label: no existing Switchyard installation or
// task namespace is adopted, stopped, or overwritten.
const id=crypto.createHash('sha256').update(origin).digest('hex').slice(0,16);
const label='app.switchyard.node.'+id;
const runtimePath=[path.dirname(process.execPath),path.join(os.homedir(),'.local/bin'),path.join(os.homedir(),'.kimi-code/bin'),'/opt/homebrew/bin','/usr/local/bin',process.env.PATH || '/usr/bin:/bin'].join(':');
console.log('  启动后台节点…');
const startTime=Date.now();
if (process.platform === 'darwin') {
  const file=path.join(os.homedir(),'Library/LaunchAgents',label+'.plist');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const args=[process.execPath,'--import','tsx',path.join(root,'server/cloud/node.ts'),configFile];
  save(file,`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map(a=>'<string>'+xml(a)+'</string>').join('')}</array>
<key>WorkingDirectory</key><string>${xml(root)}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(runtimePath)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer><key>Umask</key><integer>63</integer><key>AbandonProcessGroup</key><true/>
<key>StandardOutPath</key><string>${xml(path.join(dir,'node.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(dir,'node.log'))}</string>
</dict></plist>`);
  const domain='gui/'+process.getuid!();
  run('launchctl',['bootout',domain+'/'+label],true);
  // bootout can return before launchd has finished removing the old job.
  // Bootstrap only this node's label, retrying that short asynchronous teardown.
  let failure='';
  for(let attempt=0;attempt<20;attempt++) {
    const result=spawnSync('launchctl',['bootstrap',domain,file],{encoding:'utf8'});
    if(!result.error && result.status===0){failure='';break;}
    failure=result.stderr || result.error?.message || 'unknown launchctl error';
    await new Promise(resolve=>setTimeout(resolve,300));
  }
  if(failure)throw new Error('无法启动本机节点：'+failure);
} else if (process.platform === 'linux') {
  const quote=(s:string)=>'"'+s.replaceAll('%','%%').replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('\n','\\n')+'"';
  const file=path.join(os.homedir(),'.config/systemd/user',label+'.service');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  save(file,`[Unit]\nDescription=Switchyard local node\nAfter=network.target\n[Service]\nWorkingDirectory=${quote(root)}\nExecStart=${[process.execPath,'--import','tsx',path.join(root,'server/cloud/node.ts'),configFile].map(quote).join(' ')}\nEnvironment=${quote('PATH='+runtimePath)}\nRestart=always\nRestartSec=15\nUMask=0077\nKillMode=process\n[Install]\nWantedBy=default.target\n`);
  run('systemctl',['--user','daemon-reload']);run('systemctl',['--user','enable',label+'.service']);run('systemctl',['--user','restart',label+'.service']);
} else throw new Error('当前支持 macOS 和 Linux。');
console.log('  等待本机服务和云端连接验证…');
let ready=false;
const deadline=Date.now()+90000;
while(Date.now()<deadline) {
  try {
    const runtime=JSON.parse(fs.readFileSync(path.join(dir,'runtime.json'),'utf8'));
    if(runtime.device_id===config.device_id && runtime.root===root && runtime.started_at>=startTime && runtime.state==='online'){
      process.kill(runtime.pid,0);
      const response=await fetch(`http://127.0.0.1:${runtime.port}/api/junction/connection`,{signal:AbortSignal.timeout(1500)});
      if(response.ok){await progress('succeeded','complete',1);ready=true;break;}
    }
  }catch{}
  await new Promise(resolve=>setTimeout(resolve,1000));
}
if(!ready)throw new Error(`节点尚未完成上线验证。后台会自动重连；可查看 ${path.join(dir,'node.log')}，或重新执行安装命令。`);
console.log(`  ✓ 本机服务可用，云端已确认设备在线\n节点目录：${dir}\n后台服务：${label}`);
}
install().catch(error=>{
  const message=error instanceof TypeError && /fetch/i.test(error.message) ? '网络连接失败，请检查网络后重新执行；已完成的安装和绑定会保留。' : error.message;
  console.error('安装未完成：'+message);process.exitCode=1;
});
