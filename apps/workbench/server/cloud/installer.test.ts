import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CloudStore, digest } from './store.js';
import { requestGateway } from './install-network.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
function temp(t:any){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'switchyard-installer-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function shell(dir:string, code:string, env:Record<string,string>={}) {
  return spawnSync('/bin/bash',['-c',`source ${quote(path.join(root,'scripts/cloud-install.sh'))}\nNODE_HOME=${quote(dir)}\nINSTALL_DIR=${quote(dir)}\n${code}`],
    {encoding:'utf8',env:{...process.env,...env},timeout:15000});
}
function executable(file:string,source:string){fs.writeFileSync(file,'#!/bin/bash\nset -eu\n'+source,{mode:0o700});}

test('setup retries transient failures, preserves auth errors and never retries enrollment implicitly',async()=>{
  let calls=0;
  const io={fetch:(async()=>{calls++;if(calls===1)throw new TypeError('fetch failed');return new Response('{}',{status:calls===2?503:200});}) as typeof fetch,delay:async()=>{},retry:()=>{}};
  assert.equal((await requestGateway('https://example.test','/hub/node',{},3,io)).status,200);assert.equal(calls,3);
  calls=0;io.fetch=(async()=>{calls++;return new Response('{}',{status:401});}) as typeof fetch;
  assert.equal((await requestGateway('https://example.test','/hub/node',{},3,io)).status,401);assert.equal(calls,1);
  calls=0;io.fetch=(async()=>{calls++;throw new TypeError('fetch failed');}) as typeof fetch;
  await assert.rejects(requestGateway('https://example.test','/hub/enroll',{},1,io));assert.equal(calls,1);
  calls=0;await assert.rejects(requestGateway('https://example.test','/hub/node',{},3,io));assert.equal(calls,3);
});

test('installation claim is device-bound, extends only once, survives restart and preserves enrollment',t=>{
  const dir=temp(t);let store=new CloudStore(dir);t.after(()=>store.db.close());
  store.activate(store.activation('alice','/private/test.token'),'installer-test-password');
  store.activate(store.activation('bob','/private/other.token'),'installer-test-password');
  const code=store.pair('alice'),id=digest(code);
  const pending=store.installation(id,'alice')!;
  assert.equal(pending.status,'pending');assert.equal(store.installation(id,'bob'),undefined);
  const claimed=store.claimInstallation(code,'aaaaaaaa');
  assert.ok(claimed.expires>pending.expires+23*3600000);
  assert.equal(store.claimInstallation(code,'aaaaaaaa').expires,claimed.expires);
  assert.throws(()=>store.claimInstallation(code,'bbbbbbbb'),/另一台/);
  assert.throws(()=>store.installationProgress(code,'bbbbbbbb','tools','running','none'),/过期/);
  assert.throws(()=>store.installationProgress(code,'aaaaaaaa','tools','running','raw secret log'),/无效/);
  store.installationProgress(code,'aaaaaaaa','tools','failed','permission');
  store.db.close();store=new CloudStore(dir);
  assert.equal(store.installation(id,'alice')?.issue,'permission');
  store.claimInstallation(code,'aaaaaaaa');
  assert.throws(()=>store.enroll(code,'bbbbbbbb','wrong'),/另一台/);
  const credential=crypto.randomBytes(32).toString('base64url');
  const enrolled=store.enroll(code,'aaaaaaaa','Laptop',credential);
  // A lost enrollment response can recover via the credential persisted first.
  assert.equal(store.deviceByToken(credential)?.id,enrolled.device_id);
  assert.equal(store.installation(id,'alice')?.device_id,enrolled.device_id);
  assert.throws(()=>store.enroll(code,'aaaaaaaa','duplicate',credential),/已使用/);
  const reinstall=store.pair('alice');store.claimInstallation(reinstall,'aaaaaaaa');
  store.attachInstallation(reinstall,store.deviceByToken(credential)!);
  assert.equal(store.devices('alice').length,1);
  assert.equal(store.installation(digest(reinstall),'alice')?.device_id,enrolled.device_id);
  const foreign=store.pair('bob');store.claimInstallation(foreign,'aaaaaaaa');
  assert.throws(()=>store.attachInstallation(foreign,store.deviceByToken(credential)!),/已绑定其他账号/);
  assert.equal(store.installation(digest(foreign),'bob')?.issue,'account');
  store.installationProgress(foreign,'aaaaaaaa','start','failed','service');
  assert.equal(store.installation(digest(foreign),'bob')?.issue,'account');
  assert.equal(store.deviceByToken(credential)?.user_id,'alice');
  store.db.prepare('UPDATE installations SET expires=0 WHERE id=?').run(digest(reinstall));
  assert.throws(()=>store.claimInstallation(reinstall,'aaaaaaaa'),/过期/);
  assert.throws(()=>store.installationProgress(reinstall,'aaaaaaaa','start','running','none'),/过期/);
});

test('account switch preserves the node and requires fresh proof plus the target account decision',t=>{
  const store=new CloudStore(temp(t));t.after(()=>store.db.close());
  for(const user of ['alice','bob'])store.activate(store.activation(user,'/private/'+user+'.token'),'installer-test-password');
  const device=store.enroll(store.pair('alice'),'aaaaaaaa','Laptop');
  const credential=()=>store.deviceByToken(device.device_token)!;
  const code=store.pair('bob'),id=digest(code),claim=store.claimInstallation(code,'aaaaaaaa');
  assert.throws(()=>store.rebindInstallation(id,'bob'),/绑定信息/);
  assert.equal(store.recordAccountConflict(claim,credential()),true);
  assert.equal(store.accountConflict(id,'bob')?.from_username,'alice');
  assert.equal(store.accountConflict(id,'alice'),undefined);
  assert.throws(()=>store.rebindInstallation(id,'alice'),/不存在/);
  store.keepInstallationAccount(id,'bob');
  assert.equal(credential().user_id,'alice');assert.throws(()=>store.rebindInstallation(id,'bob'),/绑定信息/);
  store.keepInstallationAccount(id,'bob');
  assert.throws(()=>store.attachInstallation(code,credential()),/已处理/);
  assert.equal(store.installation(id,'bob')?.issue,'account_kept');
  assert.throws(()=>store.claimInstallation(code,'aaaaaaaa'),/已处理/);
  const next=store.pair('bob'),nextId=digest(next);
  store.recordAccountConflict(store.claimInstallation(next,'aaaaaaaa'),credential());
  // A different instance cannot register a proof for this device.
  const wrong=store.pair('bob');
  assert.throws(()=>store.recordAccountConflict(store.claimInstallation(wrong,'bbbbbbbb'),credential()),/不匹配/);
  assert.deepEqual(store.rebindInstallation(nextId,'bob'),{device_id:device.device_id,changed:true});
  assert.equal(credential().user_id,'bob');assert.equal(credential().instance_id,'aaaaaaaa');
  assert.equal(store.device(device.device_id,'alice'),undefined);
  assert.deepEqual(store.rebindInstallation(nextId,'bob'),{device_id:device.device_id,changed:false});
  assert.throws(()=>store.keepInstallationAccount(nextId,'bob'),/绑定信息/);
  store.installationProgress(next,'aaaaaaaa','start','failed','service');
  assert.equal(store.installation(nextId,'bob')?.issue,'account_changed');
  const back=store.pair('alice'),backId=digest(back);
  store.recordAccountConflict(store.claimInstallation(back,'aaaaaaaa'),credential());
  store.revoke(device.device_id,'bob');
  assert.equal(store.accountConflict(backId,'alice'),undefined);
  assert.throws(()=>store.rebindInstallation(backId,'alice'),/绑定信息/);
});

test('schema 1 upgrades without changing users, sessions or device credentials',t=>{
  const dir=temp(t);let store=new CloudStore(dir);
  const session=store.activate(store.activation('alice','/private/test.token'),'installer-test-password');
  const device=store.enroll(store.pair('alice'),'aaaaaaaa','Laptop');
  store.db.exec('DROP TABLE installations; PRAGMA user_version=1');store.db.close();
  store=new CloudStore(dir);t.after(()=>store.db.close());
  assert.equal(store.db.pragma('user_version',{simple:true}),3);
  assert.equal(store.session(session.token)?.id,'alice');
  assert.equal(store.deviceByToken(device.device_token)?.id,device.device_id);
  assert.ok(store.claimInstallation(store.pair('alice'),'aaaaaaaa'));
});

test('download resumes an interrupted part, validates before promotion and reuses verified cache',t=>{
  const dir=temp(t),bin=path.join(dir,'bin');fs.mkdirSync(bin);
  const content='complete verified installer fixture',sha=crypto.createHash('sha256').update(content).digest('hex');
  fs.writeFileSync(path.join(dir,'payload'),content);
  executable(path.join(bin,'curl'),`
out=''
while [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then out="$2"; shift; fi; shift; done
printf 'call\n' >> "$MOCK_DIR/calls"
if [ ! -f "$MOCK_DIR/interrupted" ]; then
  head -c 8 "$MOCK_DIR/payload" > "$out"; touch "$MOCK_DIR/interrupted"; exit 18
fi
[ "$(cat "$out")" = 'complete' ] || exit 91
cp "$MOCK_DIR/payload" "$out"
`);
  const env={PATH:bin+':'+process.env.PATH,MOCK_DIR:dir};
  const run=()=>shell(dir,`download https://example.test/fixture ${quote(path.join(dir,'archive'))} ${sha}`,env);
  assert.equal(run().status,18);assert.equal(fs.existsSync(path.join(dir,'archive')),false);
  assert.equal(fs.readFileSync(path.join(dir,'archive.part'),'utf8'),'complete');
  assert.equal(run().status,0);assert.equal(fs.readFileSync(path.join(dir,'archive'),'utf8'),content);
  assert.equal(run().status,0);assert.equal(fs.readFileSync(path.join(dir,'calls'),'utf8').trim().split('\n').length,2);
});

test('checksum failure is rejected and cannot become an installed archive',t=>{
  const dir=temp(t),bin=path.join(dir,'bin');fs.mkdirSync(bin);
  executable(path.join(bin,'curl'),`while [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then printf corrupt > "$2"; break; fi; shift; done`);
  const result=shell(dir,`download https://example.test/fixture ${quote(path.join(dir,'archive'))} ${'a'.repeat(64)}`,{PATH:bin+':'+process.env.PATH});
  assert.notEqual(result.status,0);assert.match(result.stderr,/校验/);
  assert.equal(fs.existsSync(path.join(dir,'archive')),false);assert.equal(fs.existsSync(path.join(dir,'archive.part')),false);
});

test('Linux installs only missing tools, verifies them and skips installation on retry',t=>{
  const dir=temp(t),bin=path.join(dir,'bin');fs.mkdirSync(bin);
  for(const tool of ['git','tmux','zsh','python3','make','c++'])executable(path.join(bin,tool),`[ -f "$MOCK_DIR/${tool}" ]`);
  for(const tool of ['git','zsh','python3','make','c++'])fs.writeFileSync(path.join(dir,tool),'');
  executable(path.join(bin,'apt-get'),`printf '%s\n' "$*" >> "$MOCK_DIR/packages"; case " $* " in *' install '*) touch "$MOCK_DIR/tmux";; esac`);
  const env={PATH:bin+':'+process.env.PATH,MOCK_DIR:dir};
  const script='sudo_ready() { :; }; as_admin() { "$@"; }; install_linux_tools; verify_tools';
  assert.equal(shell(dir,script,env).status,0);
  const installed=fs.readFileSync(path.join(dir,'packages'),'utf8');assert.match(installed,/install -y --no-install-recommends tmux/);assert.doesNotMatch(installed,/install.*git/);
  assert.equal(shell(dir,script,env).status,0);assert.equal(fs.readFileSync(path.join(dir,'packages'),'utf8'),installed);
});

test('a package manager reporting success is insufficient when the binary still fails',t=>{
  const dir=temp(t),bin=path.join(dir,'bin');fs.mkdirSync(bin);
  executable(path.join(bin,'tmux'),'exit 1');executable(path.join(bin,'apt-get'),'exit 0');
  const result=shell(dir,'sudo_ready() { :; }; as_admin() { "$@"; }; install_linux_tools; verify_tools',{PATH:bin+':'+process.env.PATH});
  assert.notEqual(result.status,0);assert.match(result.stderr,/安装后仍无法运行/);
});

test('macOS waits for the system tools, installs only missing formulae and verifies on retry',t=>{
  const dir=temp(t),bin=path.join(dir,'bin');fs.mkdirSync(bin);
  for(const tool of ['git','tmux','zsh','python3','make','c++'])executable(path.join(bin,tool),`[ -f "$MOCK_DIR/${tool}" ]`);
  for(const tool of ['git','zsh','python3','make','c++'])fs.writeFileSync(path.join(dir,tool),'');
  executable(path.join(bin,'xcode-select'),`printf '%s\n' "$*" >> "$MOCK_DIR/system-install";touch "$MOCK_DIR/clt"`);
  executable(path.join(bin,'brew'),`printf '%s\n' "$*" >> "$MOCK_DIR/formulae";touch "$MOCK_DIR/tmux"`);
  const env={PATH:bin+':'+process.env.PATH,MOCK_DIR:dir};
  const script='clt_ok() { [ -f "$MOCK_DIR/clt" ]; }; install_mac_tools; verify_tools';
  assert.equal(shell(dir,script,env).status,0);
  assert.equal(fs.readFileSync(path.join(dir,'formulae'),'utf8'),'install tmux\n');
  assert.equal(shell(dir,script,env).status,0);
  assert.equal(fs.readFileSync(path.join(dir,'formulae'),'utf8'),'install tmux\n');
  assert.equal(fs.readFileSync(path.join(dir,'system-install'),'utf8'),'--install\n');
});

test('installer rejects concurrent execution and recovers a stale process lock',t=>{
  const dir=temp(t);fs.mkdirSync(path.join(dir,'lock'));fs.writeFileSync(path.join(dir,'lock/pid'),String(process.pid));
  assert.notEqual(shell(dir,'lock_install').status,0);
  fs.writeFileSync(path.join(dir,'lock/pid'),'2147483647');
  assert.equal(shell(dir,'lock_install; cleanup').status,0);assert.equal(fs.existsSync(path.join(dir,'lock')),false);
});
test('existing-account conflict stops in preflight before downloads and keeps credentials out of output',t=>{
  const dir=temp(t),bin=path.join(dir,'bin');fs.mkdirSync(bin);
  fs.mkdirSync(path.join(dir,'data'));fs.writeFileSync(path.join(dir,'data/controller-id'),'aaaaaaaa\n');
  const token='a'.repeat(43);fs.writeFileSync(path.join(dir,'device.token'),token+'\n');
  executable(path.join(bin,'curl'),`while [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then printf '{"error":"account conflict"}' > "$2"; shift; fi; shift; done; printf 412`);
  const result=shell(dir,`install_runtime() { echo unexpected-download; exit 99; }; main ${'b'.repeat(24)}`,{PATH:bin+':'+process.env.PATH,SWITCHYARD_NODE_HOME:dir});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/回到网页/);
  assert.doesNotMatch(result.stdout,/unexpected-download/);assert.ok(!result.stdout.includes(token));
  assert.equal(fs.readFileSync(path.join(dir,'device.token'),'utf8'),token+'\n');
  assert.equal(fs.existsSync(path.join(dir,'install/node-headers')),false);
});
