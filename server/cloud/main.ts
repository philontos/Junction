import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway } from './gateway.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const origin=process.env.SWITCHYARD_CLOUD_ORIGIN;
if(!origin)throw new Error('SWITCHYARD_CLOUD_ORIGIN is required');
const gateway=createGateway({root,data:process.env.SWITCHYARD_CLOUD_DATA || '/srv/switchyard-cloud/data',origin,
  junctionPort:Number(process.env.SWITCHYARD_JUNCTION_PORT || 8767),bundle:process.env.SWITCHYARD_NODE_BUNDLE});
gateway.server.listen(Number(process.env.PORT || 8780),'127.0.0.1',()=>console.log('Switchyard cloud ready'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{gateway.close();setTimeout(()=>process.exit(0),1000).unref();});
