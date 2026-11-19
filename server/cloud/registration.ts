import fs from 'node:fs';
import { CloudError, type CloudUser } from './store.js';

// The service credential can only create identities. It is never sent to a
// browser/node, and cannot rotate or take over an existing Junction identity.
export function junctionProvisioner(port: number, tokenFile: string) {
  const serviceToken = fs.readFileSync(tokenFile, 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(serviceToken)) throw new Error('Invalid Junction provisioning credential');
  return async (account: CloudUser) => {
    try {
      const token = fs.readFileSync(account.junction_token_file, 'utf8').trim();
      const response = await fetch(`http://127.0.0.1:${port}/internal/users/${account.id}`, {
        method:'PUT', redirect:'error', signal:AbortSignal.timeout(8000),
        headers:{Authorization:'Bearer '+serviceToken, 'Content-Type':'application/json'},
        body:JSON.stringify({token, display_name:account.username}),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Provisioning failed'); }
      const identity = await response.json() as {user_id?:string};
      if (identity.user_id !== account.id) throw new Error('Identity mismatch');
    } catch {
      throw new CloudError(503, '账号初始化暂未完成，请稍后使用相同账号和密码重试注册。');
    }
  };
}
