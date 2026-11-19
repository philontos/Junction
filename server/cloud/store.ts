import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const secret = () => crypto.randomBytes(32).toString('base64url');
export const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
export interface CloudUser { id: string; username: string; password: string | null; junction_token_file: string; provisioned: number }
export interface CloudDevice { id: string; user_id: string; instance_id: string; name: string; created_at: number; revoked_at: number | null }
export const installSteps = ['check','runtime','tools','download','dependencies','start','complete'] as const;
export const installIssues = ['none','network','permission','tools','download','integrity','dependencies','binding','account','account_kept','account_changed','service','interrupted','unsupported','unknown'] as const;
export interface CloudInstallation { id: string; user_id: string; instance_id: string | null; device_id: string | null; step: string; status: string; issue: string; updated_at: number; expires: number }
export class CloudError extends Error { constructor(public status: number, message: string) { super(message); } }

function passwordHash(password: string) {
  if (password.length < 12 || password.length > 256) throw new CloudError(400, '密码需要 12–256 个字符。');
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(password, salt, 32).toString('hex');
}
function passwordMatches(password: string, hash: string | null) {
  const [salt, expected] = (hash || '00000000000000000000000000000000:' + '0'.repeat(64)).split(':');
  const actual = crypto.scryptSync(password.slice(0, 256), salt, 32);
  return crypto.timingSafeEqual(actual, Buffer.from(expected, 'hex')) && hash !== null && password.length <= 256;
}

export class CloudStore {
  readonly db: Database.Database;
  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new Database(path.join(dir, 'gateway.sqlite3'));
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version > 3) { this.db.close(); throw new Error('Gateway database requires a newer Switchyard'); }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, password TEXT, junction_token_file TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS activations(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pairings(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), instance_id TEXT NOT NULL,
        name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);
      CREATE UNIQUE INDEX IF NOT EXISTS device_instance ON devices(user_id, instance_id) WHERE revoked_at IS NULL;
      CREATE TABLE IF NOT EXISTS installations(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        instance_id TEXT, device_id TEXT REFERENCES devices(id), step TEXT NOT NULL, status TEXT NOT NULL,
        issue TEXT NOT NULL, updated_at INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS installation_user ON installations(user_id,updated_at);
      CREATE TABLE IF NOT EXISTS installation_bindings(installation_id TEXT PRIMARY KEY REFERENCES installations(id),
        device_id TEXT NOT NULL REFERENCES devices(id), previous_user_id TEXT NOT NULL REFERENCES users(id), token_hash TEXT NOT NULL);
    `);
    this.db.transaction(() => {
      const columns = this.db.prepare('PRAGMA table_info(users)').all() as {name:string}[];
      if (!columns.some(c => c.name === 'username')) {
        this.db.exec('ALTER TABLE users ADD COLUMN username TEXT; ALTER TABLE users ADD COLUMN provisioned INTEGER NOT NULL DEFAULT 1; UPDATE users SET username=id;');
      }
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS user_login ON users(username COLLATE NOCASE); PRAGMA user_version = 3;');
    })();
    fs.chmodSync(path.join(dir, 'gateway.sqlite3'), 0o600);
  }
  user(id: string) { return this.db.prepare('SELECT * FROM users WHERE id=?').get(id) as CloudUser | undefined; }
  account(username: string) { return this.db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').get(username.trim()) as CloudUser | undefined; }
  reserveRegistration(username: string, password: string) {
    username = username.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(username)) throw new CloudError(400, '账号需为 3–32 位字母、数字、点、下划线或短横线，以字母或数字开头。');
    if (password.length < 12 || password.length > 256) throw new CloudError(400, '密码需要 12–256 个字符。');
    const existing = this.account(username);
    if (existing) {
      if (existing.provisioned || !passwordMatches(password, existing.password)) throw new CloudError(409, '该账号已被使用，请登录或换一个账号。');
      return existing; // Only the original password can resume an interrupted signup.
    }
    const id = crypto.randomUUID(), hash = passwordHash(password);
    const dir = path.join(this.dir, 'user-credentials');
    fs.mkdirSync(dir, {recursive:true, mode:0o700});
    const tokenFile = path.join(dir, id+'.token');
    const fd = fs.openSync(tokenFile, 'wx', 0o600);
    try { fs.writeFileSync(fd, secret()+'\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const directory = fs.openSync(dir, 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    try {
      this.db.prepare('INSERT INTO users(id,username,password,junction_token_file,provisioned) VALUES (?,?,?,?,0)').run(id,username,hash,tokenFile);
    } catch (error) { fs.unlinkSync(tokenFile); throw error; }
    return this.user(id)!;
  }
  completeRegistration(id: string) {
    this.db.prepare('UPDATE users SET provisioned=1 WHERE id=?').run(id);
    return this.newSession(id);
  }
  activation(user: string, tokenFile: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(user) || !path.isAbsolute(tokenFile)) throw new Error('Invalid account');
    const token = secret();
    this.db.transaction(() => {
      const account = this.account(user) || this.user(user);
      if (account && !account.provisioned) throw new CloudError(409, '注册尚未完成，请先使用原密码重试注册。');
      user = account?.id || user;
      this.db.prepare('INSERT INTO users(id,username,junction_token_file) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET junction_token_file=excluded.junction_token_file').run(user,account?.username || user,tokenFile);
      this.db.prepare('DELETE FROM activations WHERE user_id=?').run(user);
      this.db.prepare('INSERT INTO activations VALUES (?,?,?)').run(digest(token), user, Date.now() + 86400_000);
    })();
    return token;
  }
  activate(token: string, password: string) {
    const hash = passwordHash(password);
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT user_id FROM activations WHERE hash=? AND expires>?').get(digest(token), Date.now()) as any;
      if (!row) throw new CloudError(401, '设置链接已失效，请重新获取。');
      this.db.prepare('DELETE FROM activations WHERE user_id=?').run(row.user_id);
      this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.user_id);
      this.db.prepare('UPDATE users SET password=? WHERE id=?').run(hash, row.user_id);
      return this.newSession(row.user_id);
    })();
  }
  login(user: string, password: string) {
    const account = this.account(user);
    if (!passwordMatches(password, account?.password ?? null)) throw new CloudError(401, '账号或密码不正确。');
    if (!account?.provisioned) throw new CloudError(409, '注册尚未完成，请使用相同账号和密码再次注册。');
    return this.newSession(account.id);
  }
  newSession(user: string) {
    const account = this.user(user);
    if (!account?.provisioned) throw new CloudError(403, '账号尚未就绪。');
    const token = secret();
    this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
    this.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(token), user, Date.now() + 7 * 86400_000);
    return { token, user_id: user, username: account.username };
  }
  session(token = '') {
    const row = this.db.prepare('SELECT user_id FROM sessions WHERE hash=? AND expires>?').get(digest(token), Date.now()) as any;
    const account = row ? this.user(row.user_id) : undefined;
    return account?.provisioned ? account : undefined;
  }
  logout(token: string) { this.db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(token)); }
  pair(user: string) {
    const token = crypto.randomBytes(12).toString('hex');
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM pairings WHERE expires<=?').run(Date.now());
      this.db.prepare('DELETE FROM installation_bindings WHERE installation_id IN (SELECT id FROM installations WHERE expires<?)').run(Date.now()-7*86400_000);
      this.db.prepare('DELETE FROM installations WHERE expires<?').run(Date.now()-7*86400_000);
      const expires=Date.now()+10*60_000;
      this.db.prepare('INSERT INTO pairings VALUES (?,?,?)').run(digest(token), user, expires);
      this.db.prepare("INSERT INTO installations VALUES (?,?,NULL,NULL,'check','pending','none',?,?)").run(digest(token),user,Date.now(),expires);
    })();
    return token;
  }
  installation(id: string, user: string) {
    return this.db.prepare('SELECT * FROM installations WHERE id=? AND user_id=?').get(id,user) as CloudInstallation | undefined;
  }
  claimInstallation(code: string, instance: string) {
    if (!/^[a-z0-9]{8,64}$/.test(instance)) throw new CloudError(400,'设备信息无效。');
    return this.db.transaction(() => {
      const row=this.db.prepare('SELECT * FROM installations WHERE id=? AND expires>?').get(digest(code),Date.now()) as CloudInstallation | undefined;
      if(!row)throw new CloudError(401,'安装码已过期，请在网页生成新命令；已安装内容会保留。');
      if(['account_kept','account_changed'].includes(row.issue))throw new CloudError(409,'账号绑定已处理，请从设备列表进入；如需重新安装，请生成新命令。');
      if(row.instance_id && row.instance_id!==instance)throw new CloudError(409,'安装码已由另一台设备使用，请生成新命令。');
      // A code must START within ten minutes. Claiming binds it to one local
      // installation and allows a fixed 24-hour recovery window, never sliding.
      if(!row.instance_id){
        const expires=Date.now()+86400_000;
        this.db.prepare("UPDATE installations SET instance_id=?,status='running',updated_at=?,expires=? WHERE id=?").run(instance,Date.now(),expires,row.id);
        this.db.prepare('UPDATE pairings SET expires=? WHERE hash=?').run(expires,row.id);
      }
      return this.installation(row.id,row.user_id)!;
    })();
  }
  installationProgress(code: string, instance: string, step: string, status: string, issue: string) {
    if(!installSteps.includes(step as any) || !['running','waiting','failed','paused','succeeded'].includes(status) || !installIssues.includes(issue as any)) throw new CloudError(400,'安装状态无效。');
    const row=this.db.prepare('SELECT * FROM installations WHERE id=? AND instance_id=? AND expires>?').get(digest(code),instance,Date.now()) as CloudInstallation | undefined;
    if(!row)throw new CloudError(401,'安装记录已过期，请重新生成安装命令。');
    // Old installers report a generic startup failure after the authenticated
    // account check. Preserve the precise conflict/decision shown by the portal.
    if(row.issue==='account_kept' || row.issue==='account_changed')return;
    if(row.issue==='account' && ['failed','paused'].includes(status) && issue==='service')issue='account';
    this.db.prepare('UPDATE installations SET step=?,status=?,issue=?,updated_at=? WHERE id=?').run(step,status,issue,Date.now(),row.id);
  }
  recordAccountConflict(row: CloudInstallation, device: CloudDevice) {
    return this.db.transaction(() => {
      const live=this.db.prepare('SELECT * FROM devices WHERE id=? AND user_id=? AND revoked_at IS NULL').get(device.id,device.user_id) as (CloudDevice & {token_hash:string}) | undefined;
      const current=this.installation(row.id,row.user_id);
      if(!live || !current || current.expires<=Date.now() || current.instance_id!==live.instance_id)throw new CloudError(403,'安装记录与当前设备不匹配。');
      if(live.user_id===current.user_id)return false;
      if(['account_kept','account_changed'].includes(current.issue))throw new CloudError(409,'账号绑定已处理，请生成新的安装命令。');
      this.db.prepare('INSERT INTO installation_bindings VALUES (?,?,?,?) ON CONFLICT(installation_id) DO UPDATE SET device_id=excluded.device_id,previous_user_id=excluded.previous_user_id,token_hash=excluded.token_hash').run(row.id,live.id,live.user_id,live.token_hash);
      this.db.prepare("UPDATE installations SET status='waiting',issue='account',updated_at=? WHERE id=?").run(Date.now(),row.id);
      return true;
    })();
  }
  accountConflict(id:string,user:string) {
    return this.db.prepare(`SELECT d.id AS device_id,d.name AS device_name,old.username AS from_username,target.username AS to_username
      FROM installation_bindings b JOIN installations i ON i.id=b.installation_id
      JOIN devices d ON d.id=b.device_id JOIN users old ON old.id=d.user_id JOIN users target ON target.id=i.user_id
      WHERE i.id=? AND i.user_id=? AND i.expires>? AND i.issue='account' AND d.revoked_at IS NULL
        AND d.user_id=b.previous_user_id AND d.token_hash=b.token_hash AND d.instance_id=i.instance_id`).get(id,user,Date.now()) as {device_id:string;device_name:string;from_username:string;to_username:string} | undefined;
  }
  keepInstallationAccount(id:string,user:string) {
    this.db.transaction(() => {
      const row=this.installation(id,user);
      if(!row)throw new CloudError(404,'安装记录不存在。');
      if(row.issue==='account_kept')return;
      if(!this.accountConflict(id,user))throw new CloudError(409,'绑定信息已变化或确认已过期，请重新生成并执行安装命令。');
      this.db.prepare('DELETE FROM installation_bindings WHERE installation_id=?').run(id);
      this.db.prepare("UPDATE installations SET status='paused',issue='account_kept',updated_at=? WHERE id=? AND issue='account'").run(Date.now(),id);
      this.db.prepare('DELETE FROM pairings WHERE hash=?').run(id);
    })();
  }
  rebindInstallation(id:string,user:string) {
    return this.db.transaction(() => {
      const row=this.installation(id,user);
      if(!row)throw new CloudError(404,'安装记录不存在。');
      if(row.issue==='account_changed' && row.device_id && this.device(row.device_id,user))return {device_id:row.device_id,changed:false};
      const conflict=this.accountConflict(id,user);
      if(!conflict)throw new CloudError(409,'绑定信息已变化或确认已过期，请重新生成并执行安装命令。');
      if(this.db.prepare('SELECT 1 FROM devices WHERE user_id=? AND instance_id=? AND revoked_at IS NULL AND id<>?').get(user,row.instance_id,conflict.device_id))throw new CloudError(409,'当前账号已有这台设备，请从设备列表进入。');
      // The node credential belongs to the installed node, never to the web
      // browser. Keep it and the device ID so running tasks/connection survive;
      // every browser request is authorized against the new owner immediately.
      this.db.prepare('UPDATE devices SET user_id=? WHERE id=?').run(user,conflict.device_id);
      this.db.prepare("UPDATE installations SET device_id=?,step='complete',status='succeeded',issue='account_changed',updated_at=? WHERE id=?").run(conflict.device_id,Date.now(),id);
      this.db.prepare('DELETE FROM installation_bindings WHERE installation_id=?').run(id);
      this.db.prepare('DELETE FROM pairings WHERE hash=?').run(id);
      return {device_id:conflict.device_id,changed:true};
    })();
  }
  attachInstallation(code: string, device: CloudDevice) {
    const candidate=this.db.prepare('SELECT * FROM installations WHERE id=?').get(digest(code)) as CloudInstallation | undefined;
    if(candidate && this.recordAccountConflict(candidate,device))throw new CloudError(409,'这台设备已绑定其他账号，请回到网页选择保留原绑定或切换账号。');
    return this.db.transaction(() => {
      const row=this.installation(digest(code),device.user_id);
      if(!row || row.instance_id!==device.instance_id || row.expires<=Date.now())throw new CloudError(403,'安装记录与当前设备不匹配。');
      if(row.device_id && row.device_id!==device.id)throw new CloudError(409,'安装记录已绑定另一台设备。');
      this.db.prepare('UPDATE installations SET device_id=?,updated_at=? WHERE id=?').run(device.id,Date.now(),row.id);
      this.db.prepare('DELETE FROM pairings WHERE hash=?').run(row.id);
    })();
  }
  enroll(code: string, instance: string, name: string, suppliedToken = '') {
    if (!/^[a-z0-9]{8,64}$/.test(instance) || !name.trim() || name.length > 100 || /[\x00-\x1f]/.test(name)) throw new CloudError(400, '设备信息无效。');
    if(suppliedToken && !/^[A-Za-z0-9_-]{43}$/.test(suppliedToken))throw new CloudError(400,'设备凭证无效。');
    return this.db.transaction(() => {
      const pair = this.db.prepare('SELECT user_id FROM pairings WHERE hash=? AND expires>?').get(digest(code), Date.now()) as any;
      if (!pair) throw new CloudError(401, '安装码已使用或过期，请在网页重新生成。');
      const installation=this.installation(digest(code),pair.user_id);
      if(installation?.instance_id && installation.instance_id!==instance)throw new CloudError(409,'安装码已由另一台设备使用。');
      if (this.db.prepare('SELECT 1 FROM devices WHERE user_id=? AND instance_id=? AND revoked_at IS NULL').get(pair.user_id, instance)) {
        throw new CloudError(409, '该节点已绑定；请先在设备列表断开旧绑定。');
      }
      const id = crypto.randomUUID(), token = suppliedToken || secret();
      this.db.prepare('INSERT INTO devices VALUES (?,?,?,?,?,?,NULL)').run(id, pair.user_id, instance, name.trim(), digest(token), Date.now());
      this.db.prepare('DELETE FROM pairings WHERE hash=?').run(digest(code));
      if(installation)this.db.prepare('UPDATE installations SET instance_id=?,device_id=?,updated_at=? WHERE id=?').run(instance,id,Date.now(),installation.id);
      return { device_id: id, device_token: token, user_id: pair.user_id, instance_id: instance };
    })();
  }
  devices(user: string) { return this.db.prepare('SELECT id,user_id,instance_id,name,created_at,revoked_at FROM devices WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at').all(user) as CloudDevice[]; }
  device(id: string, user: string) { return this.devices(user).find(d => d.id === id); }
  deviceByToken(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    return this.db.prepare('SELECT id,user_id,instance_id,name,created_at,revoked_at FROM devices WHERE token_hash=? AND revoked_at IS NULL').get(digest(token)) as CloudDevice | undefined;
  }
  revoke(id: string, user: string) {
    const result = this.db.prepare('UPDATE devices SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL').run(Date.now(), id, user);
    if (!result.changes) throw new CloudError(404, '设备不存在。');
  }
}
