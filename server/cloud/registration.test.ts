import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { CloudStore, digest, secret } from './store.js';
import { createGateway } from './gateway.js';

const root=path.resolve(import.meta.dirname,'../..');
function temp(t:any) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'switchyard-register-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir; }
async function listen(server:http.Server) {server.listen(0,'127.0.0.1');await once(server,'listening');return (server.address() as any).port as number;}

test('registration reserves a stable identity, securely resumes and keeps credentials private',t=>{
  const store=new CloudStore(temp(t));t.after(()=>store.db.close());
  assert.throws(()=>store.reserveRegistration('../bad','long-test-password'));
  assert.throws(()=>store.reserveRegistration('alice','short'));
  const alice=store.reserveRegistration(' Alice ','long-test-password');
  assert.match(alice.id,/^[0-9a-f-]{36}$/);assert.equal(alice.username,'alice');assert.notEqual(alice.id,'alice');
  assert.notEqual(alice.password,'long-test-password');
  assert.equal(fs.statSync(alice.junction_token_file).mode&0o777,0o600);
  assert.throws(()=>store.login('alice','long-test-password'),/尚未完成/);
  assert.throws(()=>store.newSession(alice.id),/尚未就绪/);
  assert.throws(()=>store.reserveRegistration('ALICE','different-password'),/已被使用/);
  assert.equal(store.reserveRegistration('ALICE','long-test-password').id,alice.id);
  const session=store.completeRegistration(alice.id);
  assert.equal(store.session(session.token)?.username,'alice');
  assert.equal(store.login('ALICE','long-test-password').user_id,alice.id);
  assert.throws(()=>store.reserveRegistration('alice','long-test-password'),/已被使用/);
  const bob=store.reserveRegistration('bob','b'.repeat(256));store.completeRegistration(bob.id);
  assert.throws(()=>store.login('bob','b'.repeat(257)),/不正确/);
  assert.notEqual(fs.readFileSync(alice.junction_token_file,'utf8'),fs.readFileSync(bob.junction_token_file,'utf8'));
  const node=store.enroll(store.pair(alice.id),'abcd1234','Alice laptop');
  assert.equal(store.device(node.device_id,bob.id),undefined);
  const reset=store.activation('alice',alice.junction_token_file);
  store.activate(reset,'new-long-password');
  assert.equal(store.session(session.token),undefined);
  assert.equal(store.deviceByToken(node.device_token)?.user_id,alice.id);
  assert.equal(store.login('alice','new-long-password').user_id,alice.id);
});

test('schema 2 migration preserves existing IDs, passwords, sessions and credential paths',t=>{
  const dir=temp(t),db=new Database(path.join(dir,'gateway.sqlite3'));
  const salt='0123456789abcdef',password='existing-password',session=secret();
  db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,password TEXT,junction_token_file TEXT NOT NULL); CREATE TABLE sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL); PRAGMA user_version=2;');
  db.prepare('INSERT INTO users VALUES (?,?,?)').run('legacy',salt+':'+crypto.scryptSync(password,salt,32).toString('hex'),'/private/legacy.token');
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(session),'legacy',Date.now()+60000);db.close();
  const store=new CloudStore(dir);t.after(()=>store.db.close());
  assert.equal(store.db.pragma('user_version',{simple:true}),3);
  assert.equal(store.session(session)?.id,'legacy');assert.equal(store.session(session)?.username,'legacy');
  assert.equal(store.login('LEGACY',password).user_id,'legacy');
  assert.equal(store.user('legacy')?.junction_token_file,'/private/legacy.token');
  assert.throws(()=>store.reserveRegistration('legacy','new-password-123'),/已被使用/);
});

test('HTTP signup waits for Junction, retries the same identity and enforces isolation and limits',async t=>{
  const dir=temp(t),serviceToken=secret(),tokenFile=path.join(dir,'provision.token');fs.writeFileSync(tokenFile,serviceToken);
  const provisioned=new Map<string,any>();let failOnce=true;
  const junction=http.createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk as Buffer);
    const body=JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(req.headers.authorization,'Bearer '+serviceToken);assert.equal(req.method,'PUT');
    const id=req.url!.split('/').pop()!;
    if(provisioned.has(id))assert.deepEqual(body,provisioned.get(id));else provisioned.set(id,body);
    if(failOnce){failOnce=false;res.writeHead(503);res.end();return;}
    res.setHeader('content-type','application/json');res.end(JSON.stringify({user_id:id}));
  });
  const junctionPort=await listen(junction);t.after(()=>junction.close());
  const origin='https://cloud.example',gateway=createGateway({root,data:path.join(dir,'data'),origin,junctionPort,registrationTokenFile:tokenFile});
  const port=await listen(gateway.server);t.after(()=>gateway.close());
  const request=(route:string,body?:any,cookie='',ip='alice',requestOrigin=origin)=>fetch(`http://127.0.0.1:${port}/hub/`+route,{method:body===undefined?'GET':'POST',headers:{Origin:requestOrigin,'Content-Type':'application/json','x-real-ip':ip,Cookie:cookie},body:body===undefined?undefined:JSON.stringify(body)});
  assert.equal((await (await request('session')).json() as any).registration_open,true);
  const body={user:'alice',password:'long-test-password'};
  assert.equal((await request('register',body,'','alice','https://evil.example')).status,403);
  const failed=await request('register',body);assert.equal(failed.status,503);assert.equal(failed.headers.get('set-cookie'),null);
  assert.equal((await request('login',body)).status,409);
  const result=await request('register',body);assert.equal(result.status,201);
  const cookie=result.headers.get('set-cookie')!;assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);
  const account=await result.json() as any;assert.deepEqual(Object.keys(account).sort(),['user_id','username']);
  assert.equal(account.username,'alice');assert.equal(provisioned.size,1);
  assert.equal((await (await request('session',undefined,cookie)).json() as any).user_id,account.user_id);
  assert.deepEqual(await (await request('devices',undefined,cookie)).json(),{items:[]});
  const pair=await (await request('pairings',{},cookie)).json() as any;assert.ok(pair.code);
  const bob=await request('register',{user:'bob',password:'other-test-password'},'','bob');assert.equal(bob.status,201);
  const bobCookie=bob.headers.get('set-cookie')!;
  assert.equal((await request('installations/'+pair.installation_id,undefined,bobCookie)).status,404);
  assert.equal(provisioned.size,2);
  assert.equal((await request('register',body)).status,409);
  for(let i=0;i<5;i++)assert.equal((await request('register',{user:'bad',password:'short'},'','limited')).status,400);
  assert.equal((await request('register',body,'','limited')).status,429);
  assert.equal((await fetch(`http://127.0.0.1:${port}/internal/users/${account.user_id}`)).status,404);
});

test('registration is closed by default while existing accounts can log in',async t=>{
  const gateway=createGateway({root,data:temp(t),origin:'http://localhost',junctionPort:1});
  const port=await listen(gateway.server);t.after(()=>gateway.close());
  gateway.store.activate(gateway.store.activation('alice','/private/alice.token'),'long-test-password');
  const url=`http://127.0.0.1:${port}/hub/`;
  assert.equal((await (await fetch(url+'session')).json() as any).registration_open,false);
  const args={method:'POST',headers:{Origin:'http://localhost','Content-Type':'application/json'},body:JSON.stringify({user:'alice',password:'long-test-password'})};
  assert.equal((await fetch(url+'register',args)).status,403);
  assert.equal((await fetch(url+'login',args)).status,200);
});
