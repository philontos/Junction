import fs from 'node:fs';
import path from 'node:path';
import { CloudStore } from './store.js';
const [command,user,tokenFile,output]=process.argv.slice(2);
const store=new CloudStore(process.env.SWITCHYARD_CLOUD_DATA || '/srv/switchyard-cloud/data');
try {
  if(command==='activate' && user && tokenFile && output){
    if(fs.existsSync(output))throw new Error('Output already exists');
    if(!/^[A-Za-z0-9_-]{20,256}$/.test(fs.readFileSync(tokenFile,'utf8').trim()))throw new Error('Invalid Junction credential');
    const token=store.activation(user,path.resolve(tokenFile));
    fs.writeFileSync(output,token+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({user,activation_file:output,expires_in:86400}));
  }else if(command==='backup' && user){
    if(fs.existsSync(user))throw new Error('Backup already exists');
    await store.db.backup(user);fs.chmodSync(user,0o600);console.log(JSON.stringify({backup:user}));
  }else throw new Error('Usage: admin.ts activate USER JUNCTION_TOKEN_FILE OUTPUT | backup OUTPUT');
}finally{store.db.close();}
