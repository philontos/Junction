import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const secret = () => crypto.randomBytes(32).toString('base64url');
export const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
export interface CloudUser { id: string; username: string; password: string | null; junction_token_file: string; provisioned: number }
export interface CloudDevice { id: string; user_id: string; instance_id: string; name: string; created_at: number; revoked_at: number | null }
export const installSteps = ['check','runtime','tools','download','dependencies','start','complete'] as const;
export const installIssues = ['none','network','permission','tools','download','integrity','dependencies','binding','service','interrupted','unsupported','unknown'] as const;
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
    this.db.prepare('UPDATE installations SET step=?,status=?,issue=?,updated_at=? WHERE id=?').run(step,status,issue,Date.now(),row.id);
  }
  attachInstallation(code: string, device: CloudDevice) {
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
