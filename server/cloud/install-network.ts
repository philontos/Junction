// Retry only idempotent setup requests. Enrollment supplies a durable local
// credential and uses identity recovery instead of blindly repeating a write.
export async function requestGateway(origin:string, route:string, options:RequestInit={}, attempts=3,
  io:{fetch?:typeof fetch;delay?:(ms:number)=>Promise<void>;retry?:(attempt:number)=>void}={}) {
  const request=io.fetch || fetch, delay=io.delay || (ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  for(let attempt=0;attempt<attempts;attempt++) {
    try {
      const response=await request(origin+route,{...options,signal:AbortSignal.timeout(15000)});
      if(response.status<500 && response.status!==429)return response;
      await response.body?.cancel();
      if(attempt===attempts-1)throw new Error('云端暂时不可用，请稍后重新执行安装命令。');
    }catch(error){if(attempt===attempts-1)throw error;}
    if(io.retry)io.retry(attempt+1);else console.log(`  网络暂时不可用，正在重试（${attempt+1}/${attempts-1}）…`);
    await delay(1000*(attempt+1));
  }
  throw new Error('云端连接失败。');
}
