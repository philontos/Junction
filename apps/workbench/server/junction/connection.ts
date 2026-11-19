import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { JunctionError, readConfig, serviceUrl, type JunctionConfig } from "./client.js";

export function connectionInfo(file: string, nodeId: string) {
  if (!fs.existsSync(file)) return { configured: false, node_id: nodeId, url: "" };
  try {
    const config = readConfig(file);
    return { configured: true, node_id: nodeId, url: config.url };
  } catch {
    return { configured: false, node_id: nodeId, url: "", error: "原连接配置无法读取，请重新连接。" };
  }
}

function connectionUrl(value: unknown) {
  const url = serviceUrl(value), parsed = new URL(url), host = parsed.hostname;
  const octets = host.split(".").map(Number);
  const privateV4 = isIP(host) === 4 && (octets[0] === 127 || octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168));
  if (parsed.protocol === "http:" && host !== "localhost" && host !== "[::1]" && !privateV4 &&
      !(isIP(host.slice(1, -1)) === 6 && /^\[f[cd]/i.test(host))) {
    throw new JunctionError(400, "公网 Junction 地址必须使用 HTTPS；HTTP 仅用于本机或内网 IP。");
  }
  return url;
}

function privateFile(file: string, contents: string) {
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, contents); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function syncDir(dir: string) {
  // Directory fsync is not supported on all platforms. File contents are always fsynced.
  let fd: number | undefined;
  try { fd = fs.openSync(dir, "r"); fs.fsyncSync(fd); }
  catch (error) { if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes((error as NodeJS.ErrnoException).code || "")) throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export async function connectJunction(file: string, nodeId: string, input: unknown, fetcher: typeof fetch = fetch) {
  const body = input as { url?: unknown; token?: unknown } | null;
  const url = connectionUrl(body?.url);
  if (typeof body?.token !== "string" || !/^[A-Za-z0-9_-]{20,256}$/.test(body.token.trim())) {
    throw new JunctionError(400, "设备凭证格式无效。");
  }
  const token = body.token.trim();
  let response: Response;
  try {
    response = await fetcher(url + "/v1/me", { redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
  } catch { throw new JunctionError(502, "无法连接 Junction，请检查地址、网络和 HTTPS 证书。当前配置未更改。"); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new JunctionError(response.status === 401 ? 401 : 502,
      response.status === 401 ? "设备凭证无效或已撤销。当前配置未更改。" : "Junction 验证失败。当前配置未更改。");
  }
  let identity: { user_id?: unknown; device_id?: unknown };
  try { identity = await response.json(); }
  catch { throw new JunctionError(502, "此地址未返回有效的 Junction 身份信息。当前配置未更改。"); }
  if (!identity || typeof identity.user_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(identity.user_id)) {
    throw new JunctionError(502, "Junction 身份信息无效。当前配置未更改。");
  }
  if (identity.device_id !== undefined && identity.device_id !== nodeId) {
    throw new JunctionError(409, "此凭证属于其他设备，请使用当前设备 ID 申请凭证。当前配置未更改。");
  }

  // No awaits here: each request reads the last committed configuration before replacing it.
  const parent = path.dirname(path.resolve(file)), secrets = path.join(parent, ".junction-credentials");
  const nonce = randomUUID(), tokenFile = path.join(secrets, nonce + ".token");
  const staging = path.join(parent, ".junction-" + nonce + ".json");
  let committed = false;
  try {
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    fs.mkdirSync(secrets, { mode: 0o700, recursive: true });
    let previous: JunctionConfig | undefined;
    if (fs.existsSync(file)) {
      // Keep an exact private copy for manual rollback, even if the old config was malformed.
      privateFile(path.join(secrets, nonce + ".previous.json"), fs.readFileSync(file, "utf8"));
      try { previous = readConfig(file); } catch { /* replace a broken configuration */ }
    }
    privateFile(tokenFile, token + "\n");
    syncDir(secrets);
    const accounts = previous?.url === url ? previous.accounts.filter(a => a.id !== "device") : [];
    accounts.push({ id: "device", label: identity.user_id, token_file: tokenFile });
    privateFile(staging, JSON.stringify({ url, default_account: "device", accounts }, null, 2) + "\n");
    fs.renameSync(staging, file);
    committed = true;
    syncDir(parent);
  } catch {
    if (!committed) throw new JunctionError(500, "无法保存连接配置，请检查本机目录权限。当前配置未更改。");
    // Rename has committed; do not imply the old configuration is still active.
    console.error("Junction connection saved; configuration directory fsync failed.");
  } finally {
    if (!committed) for (const created of [staging, tokenFile]) {
      try { fs.unlinkSync(created); } catch { /* incomplete new files only */ }
    }
  }
  return { configured: true, url, node_id: nodeId, user_id: identity.user_id,
    ...(identity.device_id ? { device_id: identity.device_id } : {}) };
}
