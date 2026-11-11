import fs from "node:fs";

export class JunctionError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export interface Account { id: string; label: string; token_file: string }
export interface JunctionConfig { url: string; accounts: Account[]; default_account: string }
export function readConfig(file: string): JunctionConfig {
  if (!fs.existsSync(file)) throw new JunctionError(503, "Junction 未配置；请设置 SWITCHYARD_JUNCTION_CONFIG。");
  const c = JSON.parse(fs.readFileSync(file, "utf8"));
  const u = new URL(c.url);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== "/") {
    throw new JunctionError(503, "Junction URL 必须是 HTTP(S) 服务地址，不含凭据或路径。");
  }
  if (!Array.isArray(c.accounts) || !c.accounts.length || c.accounts.some((a: Account) =>
    !/^[a-zA-Z0-9_-]{1,64}$/.test(a.id) || typeof a.token_file !== "string" || typeof a.label !== "string") ||
    new Set(c.accounts.map((a: Account) => a.id)).size !== c.accounts.length ||
    !c.accounts.some((a: Account) => a.id === c.default_account)) {
    throw new JunctionError(503, "Junction 账号配置无效。");
  }
  return { ...c, url: u.origin };
}
export class JunctionClient {
  readonly account: Account;
  constructor(readonly config: JunctionConfig, account?: string, private fetcher: typeof fetch = fetch) {
    const selected = config.accounts.find(a => a.id === (account || config.default_account));
    if (!selected) throw new JunctionError(400, "未知的 Junction 账号。");
    this.account = selected;
  }
  async request(route: string, init: RequestInit = {}): Promise<any> {
    if (!route.startsWith("/v1/") || route.includes("\\") || route.includes("..")) throw new Error("Invalid Junction route");
    const token = fs.readFileSync(this.account.token_file, "utf8").trim();
    if (!token || token.length > 4096 || /[\r\n]/.test(token)) throw new JunctionError(503, "Junction 令牌文件无效。");
    let response: Response;
    try {
      response = await this.fetcher(this.config.url + route, { ...init, redirect: "error", signal: AbortSignal.timeout(60_000),
        headers: { ...init.headers, Authorization: `Bearer ${token}` } });
    } catch { throw new JunctionError(502, "无法连接 Junction，请检查服务是否在线。"); }
    const body = response.status === 204 ? null : await response.json();
    if (!response.ok) throw new JunctionError(response.status, body?.error?.detail || "Junction 请求失败。");
    return body;
  }
  async *pages(base: string, resource: string) {
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page = await this.request(`${base}/${resource}?` + new URLSearchParams(cursor ? { cursor } : {}));
      if (!Array.isArray(page.items)) throw new JunctionError(502, "Junction 分页响应无效。");
      yield page.items;
      cursor = page.next_cursor;
      if (cursor && seen.has(cursor)) throw new JunctionError(502, "Junction 分页游标重复。");
      if (cursor) seen.add(cursor);
    } while (cursor);
  }
  async snapshot(contextId: string, revisionId: string) {
    const base = revisionPath(contextId, revisionId);
    const meta = await this.request(base);
    const normalized = structuredClone(meta.revision.normalized);
    if (normalized.schema_version !== "junction.context/1") throw new JunctionError(409, "不支持此 Context 格式版本。");
    normalized.session.turns = [];
    normalized.session.messages = [];
    normalized.diagnostics = [];
    for await (const items of this.pages(base, "turns")) normalized.session.turns.push(...items);
    for await (const items of this.pages(base, "diagnostics")) normalized.diagnostics.push(...items);
    let chars = 0;
    for await (const items of this.pages(base, "messages")) {
      for (const msg of items) {
        if (msg.content_truncated) {
          let offset: number | null = 0;
          let content = "";
          do {
            const chunk = await this.request(`${base}/messages/${encodeURIComponent(msg.id)}/content?offset=${offset}`);
            content += chunk.text;
            if (content.length > 64 * 1024 * 1024 || (chunk.next_offset !== null && chunk.next_offset <= offset!)) {
              throw new JunctionError(502, "Junction 内容分块无效或过大。");
            }
            offset = chunk.next_offset;
          } while (offset !== null);
          msg.content = JSON.parse(content);
        }
        for (const key of ["content_truncated", "content_chars", "content_preview", "content_url"]) delete msg[key];
        chars += JSON.stringify(msg).length;
        if (chars > 96 * 1024 * 1024) throw new JunctionError(413, "Context 过大，无法导入当前工作区。");
        normalized.session.messages.push(msg);
      }
    }
    if (normalized.session.messages.length !== meta.revision.message_count || normalized.session.turns.length !== meta.revision.turn_count) {
      throw new JunctionError(502, "Context 下载不完整。");
    }
    return { meta, normalized };
  }
}
export function revisionPath(cid: string, rid: string) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(cid) || !uuid.test(rid)) throw new JunctionError(400, "Context / revision ID 无效。");
  return `/v1/contexts/${cid}/revisions/${rid}`;
}
