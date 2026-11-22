import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createGateway } from './gateway.js';

test('cloud Context reads need no device and retain account visibility, pinned revisions and read-only boundaries', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'junction-context-nav-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const seen: { url: string; auth?: string }[] = [];
  const upstream = http.createServer((req,res) => {
    seen.push({ url: req.url!, auth: req.headers.authorization });
    res.setHeader('content-type','application/json');
    if (req.headers.authorization !== 'Bearer alice-context') { res.statusCode = 404; res.end(JSON.stringify({error:{detail:'Not visible'}})); return; }
    res.end(JSON.stringify({items:[],next_cursor:null}));
  });
  upstream.listen(0,'127.0.0.1'); await once(upstream,'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const gateway = createGateway({ root: path.resolve('apps/workbench'), data: dir, origin: 'http://localhost', junctionPort: (upstream.address() as any).port });
  gateway.server.listen(0,'127.0.0.1'); await once(gateway.server,'listening'); t.after(() => gateway.close());
  const origin = `http://127.0.0.1:${(gateway.server.address() as any).port}`;
  const token = (name: string) => { const file = path.join(dir,name); fs.writeFileSync(file,name+'-context'); return gateway.store.activate(gateway.store.activation(name,file),'fixture-password-123').token; };
  const alice = token('alice'), bob = token('bob');
  const get = (route: string, account?: string, method = 'GET') => fetch(origin+route,{method,headers:account?{Cookie:'sw_session='+account}:{}});
  assert.equal((await get('/hub/context/contexts')).status,401);
  assert.equal((await get('/hub/context/contexts?shared_only=false&cursor=next&limit=12',alice)).status,200);
  assert.deepEqual(seen.at(-1),{url:'/v1/contexts?cursor=next&limit=12&shared_only=true',auth:'Bearer alice-context'});
  assert.equal((await get('/hub/context/contexts',bob)).status,404);
  const base = '/hub/context/contexts/11111111-1111-1111-1111-111111111111/revisions/22222222-2222-2222-2222-222222222222';
  assert.equal((await get(base+'/messages/m3/content?offset=100',alice)).status,200);
  assert.ok(seen.at(-1)!.url.endsWith('/messages/m3/content?offset=100'));
  const before = seen.length;
  for (const [route,method] of [[base+'/raw','GET'],[base+'/grants','GET'],['/hub/context/contexts','POST']]) assert.equal((await get(route,alice,method)).status,404);
  assert.equal(seen.length,before);
  for (const route of ['/', '/contexts', '/devices']) { const html = await (await get(route)).text(); assert.match(html,/context-space/); assert.doesNotMatch(html,/switchyard-wordmark/); }
  assert.equal(gateway.store.devices('alice').length,0);
});
