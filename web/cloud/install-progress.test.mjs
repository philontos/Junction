import test from 'node:test';
import assert from 'node:assert/strict';
import { installationView } from './install-progress.js';
const run={step:'tools',status:'running',issue:'none',updated_at:1000,expires:1000000,online:false,device_id:null};
test('installation success requires verified completion and an online device',()=>{
  assert.equal(installationView({...run,online:true,device_id:'old-device'},1000).complete,false);
  assert.equal(installationView({...run,status:'succeeded',step:'complete'},1000).complete,false);
  assert.equal(installationView({...run,status:'succeeded',step:'complete',device_id:'device',online:true},1000).complete,true);
});
test('expired, stalled, interrupted and authorization states have actionable recovery',()=>{
  assert.equal(installationView({...run,expires:900},1000).retry,true);
  assert.match(installationView({...run,expires:900},1000).detail,/已完成/);
  assert.equal(installationView(run,200000).retry,true);
  assert.match(installationView({...run,status:'paused',issue:'interrupted'},1000).detail,/继续/);
  const permission=installationView({...run,status:'waiting',issue:'permission'},1000);
  assert.match(permission.detail,/本机管理员/);assert.equal(permission.retry,false);
});
