import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const secret = () => crypto.randomBytes(32).toString('base64url');
export const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
export interface CloudUser { id: string; password: string | null; junction_token_file: string }
export interface CloudDevice { id: string; user_id: string; instance_id: string; name: string; created_at: number; revoked_at: number | null }
export class CloudError extends Error { constructor(public status: number, message: string) { super(message); } }

function passwordHash(password: string) {
  if (password.length < 12 || password.length > 256) throw new CloudError(400, '密码需要 12–256 个字符。');
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(password, salt, 32).toString('hex');
}
function passwordMatches(password: string, hash: string | null) {
  const [salt, expected] = (hash || '00000000000000000000000000000000:' + '0'.repeat(64)).split(':');
  const actual = crypto.scryptSync(password.slice(0, 256), salt, 32);
  return crypto.timingSafeEqual(actual, Buffer.from(expected, 'hex')) && hash !== null;
}

export class CloudStore {
  readonly db: Database.Database;
  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new Database(path.join(dir, 'gateway.sqlite3'));
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version > 1) { this.db.close(); throw new Error('Gateway database requires a newer Switchyard'); }
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
      PRAGMA user_version = 1;
    `);
    fs.chmodSync(path.join(dir, 'gateway.sqlite3'), 0o600);
  }
  user(id: string) { return this.db.prepare('SELECT * FROM users WHERE id=?').get(id) as CloudUser | undefined; }
  activation(user: string, tokenFile: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(user) || !path.isAbsolute(tokenFile)) throw new Error('Invalid account');
    const token = secret();
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO users(id,junction_token_file) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET junction_token_file=excluded.junction_token_file').run(user, tokenFile);
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
    const account = this.user(user);
    if (!passwordMatches(password, account?.password ?? null)) throw new CloudError(401, '账号或密码不正确。');
    return this.newSession(user);
  }
  newSession(user: string) {
    const token = secret();
    this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
    this.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(token), user, Date.now() + 7 * 86400_000);
    return { token, user_id: user };
  }
  session(token = '') {
    const row = this.db.prepare('SELECT user_id FROM sessions WHERE hash=? AND expires>?').get(digest(token), Date.now()) as any;
    return row ? this.user(row.user_id) : undefined;
  }
  logout(token: string) { this.db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(token)); }
  pair(user: string) {
    const token = crypto.randomBytes(12).toString('hex');
    this.db.prepare('DELETE FROM pairings WHERE expires<=?').run(Date.now());
    this.db.prepare('INSERT INTO pairings VALUES (?,?,?)').run(digest(token), user, Date.now() + 10 * 60_000);
    return token;
  }
  enroll(code: string, instance: string, name: string) {
    if (!/^[a-z0-9]{8,64}$/.test(instance) || !name.trim() || name.length > 100 || /[\x00-\x1f]/.test(name)) throw new CloudError(400, '设备信息无效。');
    return this.db.transaction(() => {
      const pair = this.db.prepare('SELECT user_id FROM pairings WHERE hash=? AND expires>?').get(digest(code), Date.now()) as any;
      if (!pair) throw new CloudError(401, '安装码已使用或过期，请在网页重新生成。');
      if (this.db.prepare('SELECT 1 FROM devices WHERE user_id=? AND instance_id=? AND revoked_at IS NULL').get(pair.user_id, instance)) {
        throw new CloudError(409, '该节点已绑定；请先在设备列表断开旧绑定。');
      }
      const id = crypto.randomUUID(), token = secret();
      this.db.prepare('INSERT INTO devices VALUES (?,?,?,?,?,?,NULL)').run(id, pair.user_id, instance, name.trim(), digest(token), Date.now());
      this.db.prepare('DELETE FROM pairings WHERE hash=?').run(digest(code));
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
