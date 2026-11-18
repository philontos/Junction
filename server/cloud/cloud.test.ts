import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { CloudStore } from './store.js';
import { createGateway } from './gateway.js';
import { startNodeTunnel } from './node.js';
import { permitsNodeRequest } from '../http/nodeguard.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(condition:()=>boolean) { for(let i=0;i<100;i++){if(condition())return;await pause(50);}throw new Error('Condition timed out'); }
async function listen(server:http.Server) { server.listen(0,'127.0.0.1');await once(server,'listening');return (server.address() as any).port as number; }
function temp(t:any) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'switchyard-cloud-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir; }

test('credentials: one-use activation/pairing, expiry, ownership, hashed storage and revocation', t=>{
  const dir=temp(t),store=new CloudStore(dir);t.after(()=>store.db.close());
  const activation=store.activation('alice','/private/alice.token');
  assert.throws(()=>store.activate(activation,'short'),/12/);
  const session=store.activate(activation,'long-test-password');
  assert.equal(store.session(session.token)?.id,'alice');
  assert.throws(()=>store.activate(activation,'long-test-password'));
  assert.throws(()=>store.login('alice','wrong'));
  assert.equal(store.login('alice','long-test-password').user_id,'alice');
  const pairing=store.pair('alice');
  const node=store.enroll(pairing,'aaaa1111','Laptop');
  assert.throws(()=>store.enroll(pairing,'bbbb1111','Another'));
  assert.equal(store.deviceByToken(node.device_token)?.user_id,'alice');
  assert.equal(store.device(node.device_id,'bob'),undefined);
  assert.throws(()=>store.revoke(node.device_id,'bob'));
  const duplicate=store.pair('alice');assert.throws(()=>store.enroll(duplicate,'aaaa1111','Duplicate'),/已绑定/);
  store.revoke(node.device_id,'alice');assert.equal(store.deviceByToken(node.device_token),undefined);
  assert.ok(store.enroll(duplicate,'aaaa1111','Rebound'));
  const expired=store.pair('alice');store.db.prepare('UPDATE pairings SET expires=0').run();assert.throws(()=>store.enroll(expired,'cccc1111','Expired'));
  store.logout(session.token);assert.equal(store.session(session.token),undefined);
  const disk=JSON.stringify(store.db.prepare('SELECT * FROM users').all())+JSON.stringify(store.db.prepare('SELECT * FROM devices').all());
  assert.ok(!disk.includes('long-test-password'));assert.ok(!disk.includes(node.device_token));
  assert.equal(fs.statSync(path.join(dir,'gateway.sqlite3')).mode&0o777,0o600);
});

test('cloud-managed loopback listener refuses direct browser origins and rebinding',()=>{
  const request=(headers:any)=>({headers}) as http.IncomingMessage;
  assert.equal(permitsNodeRequest(request({host:'localhost'}),true),true);
  assert.equal(permitsNodeRequest(request({host:'127.0.0.1:4500'}),true),true);
  assert.equal(permitsNodeRequest(request({host:'evil.example'}),true),false);
  assert.equal(permitsNodeRequest(request({host:'localhost',origin:'https://evil.example'}),true),false);
  assert.equal(permitsNodeRequest(request({host:'existing-lan-host',origin:'http://existing-lan-host'}),false),true);
});

test('gateway relays HTTP, progress and terminal to the owned, URL-pinned node; reconnect and revoke', {timeout:30000}, async t=>{
  const dir=temp(t),junctionToken=crypto.randomBytes(32).toString('hex');
  const tokenFile=path.join(dir,'junction.token');fs.writeFileSync(tokenFile,junctionToken);
  const junction=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({user_id:'alice',authorized:req.headers.authorization==='Bearer '+junctionToken,path:req.url}));});
  const junctionPort=await listen(junction);t.after(()=>junction.close());
  async function local(name:string) {
    let calls=0;
    const server=http.createServer(async(req,res)=>{
      calls++;res.setHeader('Content-Type','application/json');
      if(req.url==='/api/progress'){res.write('{"step":1}\n');setTimeout(()=>res.end('{"step":2}\n'),80);return;}
      const chunks:Buffer[]=[];for await(const c of req)chunks.push(c as Buffer);
      res.end(JSON.stringify({name,path:req.url,cookie:req.headers.cookie,origin:req.headers.origin,size:Buffer.concat(chunks).length}));
    });
    const ws=new WebSocketServer({server,path:'/pty'});ws.on('connection',s=>s.on('message',msg=>s.send(name+':'+msg.toString())));
    const port=await listen(server);t.after(()=>{for(const c of ws.clients)c.terminate();ws.close();server.closeAllConnections();server.close();});
    return {port,calls:()=>calls};
  }
  const a=await local('A'),b=await local('B');
  const origin='http://127.0.0.1';
  const gateway=createGateway({root,data:path.join(dir,'db'),origin,junctionPort});
  const port=await listen(gateway.server),url='http://127.0.0.1:'+port;
  t.after(()=>gateway.close());
  async function request(route:string,token='',body?:any,withOrigin=true) {
    return fetch(url+route,{method:body===undefined?'GET':'POST',headers:{...(token?{cookie:'sw_session='+token}:{}),...(withOrigin?{Origin:origin}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(6000)});
  }
  const activation=gateway.store.activation('alice',tokenFile);
  const activated=await request('/hub/activate','',{code:activation,password:'test-long-password'});
  assert.equal(activated.status,200);const session=activated.headers.get('set-cookie')!.match(/sw_session=([^;]+)/)![1];
  assert.equal((await request('/hub/devices')).status,401);
  const pairing=await (await request('/hub/pairings',session,{})).json() as any;
  const na=await (await request('/hub/enroll','',{code:pairing.code,instance_id:'aaaaaaaa',name:'A'})).json() as any;
  const nb=gateway.store.enroll(gateway.store.pair('alice'),'bbbbbbbb','B');
  const other=gateway.store.activate(gateway.store.activation('bob',tokenFile),'test-other-password');
  const tunnelA=startNodeTunnel(url,na.device_token,a.port),tunnelB=startNodeTunnel(url,nb.device_token,b.port);
  t.after(()=>{tunnelA.close();tunnelB.close();});
  await until(()=>gateway.broker.nodes.size===2);
  const route='/nodes/'+na.device_id;
  assert.equal((await request(route+'/api/test',other.token)).status,404);
  assert.equal((await request(route+'/api/test',session,{},false)).status,403);
  assert.equal((await request('/v1/me')).status,401);
  const identity=await fetch(url+'/v1/me',{headers:{Authorization:'Bearer '+na.device_token}});
  assert.deepEqual(await identity.json(),{user_id:'alice',authorized:true,path:'/v1/me'});
  const forwarded=await request(route+'/api/test?value=1',session);
  assert.equal(forwarded.status,200);assert.deepEqual(await forwarded.json(),{name:'A',path:'/api/test?value=1',size:0});
  const second=await request('/nodes/'+nb.device_id+'/api/test',session);assert.equal((await second.json() as any).name,'B');
  const again=await request(route+'/api/test',session);assert.equal((await again.json() as any).name,'A');
  const large=await request(route+'/api/upload',session,{data:'x'.repeat(3*1024*1024)});assert.equal((await large.json() as any).size,3*1024*1024+11);
  const progress=await request(route+'/api/progress',session);const reader=progress.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value),'{"step":1}\n');
  assert.equal(new TextDecoder().decode((await reader.read()).value),'{"step":2}\n');
  const page=await request('/workspace/'+na.device_id+'/',session);assert.match(await page.text(),new RegExp('content="/nodes/'+na.device_id+'"'));
  const terminal=new WebSocket(url.replace('http','ws')+route+'/pty?session=test',{headers:{Cookie:'sw_session='+session,Origin:origin}});
  t.after(()=>terminal.terminate());await once(terminal,'open');terminal.send('\0resize:100:32');
  assert.equal((await once(terminal,'message'))[0].toString(),'A:\0resize:100:32');
  terminal.close();await once(terminal,'close');
  const calls=a.calls();tunnelA.close();await until(()=>!gateway.broker.nodes.has(na.device_id));
  assert.equal((await request(route+'/api/test',session)).status,503);assert.equal(a.calls(),calls);
  const resumed=startNodeTunnel(url,na.device_token,a.port);t.after(()=>resumed.close());await until(()=>gateway.broker.nodes.has(na.device_id));
  assert.equal((await request(route+'/api/test',session)).status,200);
  gateway.broker.disconnect(na.device_id);await until(()=>gateway.broker.nodes.has(na.device_id));
  assert.equal((await request(route+'/api/test',session)).status,200);
  const revoke=await fetch(url+'/hub/devices/'+na.device_id,{method:'DELETE',headers:{Cookie:'sw_session='+session,Origin:origin}});
  assert.equal(revoke.status,200);await until(()=>!gateway.broker.nodes.has(na.device_id));
  assert.equal((await request(route+'/api/test',session)).status,404);
  assert.equal((await fetch(url+'/v1/me',{headers:{Authorization:'Bearer '+na.device_token}})).status,401);
});
