import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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
const code = fs.readFileSync(0, 'utf8').trim();
fs.mkdirSync(path.join(dir, 'data'), {recursive:true,mode:0o700});
const identityFile = path.join(dir, 'data/controller-id');
let instance: string;
if (fs.existsSync(identityFile)) instance = fs.readFileSync(identityFile,'utf8').trim();
else { instance = crypto.randomBytes(4).toString('hex'); save(identityFile,instance+'\n'); }
let config: any;
if (fs.existsSync(configFile)) {
  config = JSON.parse(fs.readFileSync(configFile,'utf8'));
  if (config.server !== origin) throw new Error('现有节点属于另一个云服务。');
  const check = await fetch(origin+'/v1/me',{headers:{Authorization:'Bearer '+config.device_token},signal:AbortSignal.timeout(15000)});
  if (check.status === 401) config = undefined;
  else if (!check.ok) throw new Error('无法核对现有绑定，请稍后重试。');
}
if (!config) {
  const result = await fetch(origin+'/hub/enroll',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({code,instance_id:instance,name:os.hostname()}),signal:AbortSignal.timeout(15000)});
  const body = await result.json() as any;
  if (!result.ok) throw new Error(body.error || '绑定失败');
  config = {...body,server:origin,schema_version:1}; save(configFile,JSON.stringify(config,null,2)+'\n');
}
const tokenFile=path.join(dir,'device.token');save(tokenFile,config.device_token+'\n');
save(path.join(dir,'junction.json'),JSON.stringify({url:origin,default_account:'device',accounts:[{id:'device',label:config.user_id,token_file:tokenFile}]},null,2)+'\n');
// Separate profile and service label: no existing Switchyard installation or
// task namespace is adopted, stopped, or overwritten.
const id=crypto.createHash('sha256').update(origin).digest('hex').slice(0,16);
const label='app.switchyard.node.'+id;
const runtimePath=[path.dirname(process.execPath),path.join(os.homedir(),'.local/bin'),path.join(os.homedir(),'.kimi-code/bin'),'/opt/homebrew/bin','/usr/local/bin',process.env.PATH || '/usr/bin:/bin'].join(':');
console.log('[4/4] 启动后台节点…');
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
console.log(`已安装。回到 ${origin}/，等待设备显示在线后进入工作台。`);
console.log(`节点目录：${dir}\n后台服务：${label}\n现有任务和其他 Switchyard 实例保持独立。`);
