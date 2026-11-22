import { api } from "./dom.js";

// Compatibility with nodes released before adapter discovery existed.
const legacy = [
  { id: "claude", name: "Claude Code", sharing: true },
  { id: "codex", name: "Codex", sharing: true },
  { id: "kimi", name: "Kimi Code", sharing: false },
];
const catalogs = new Map(), pending = new Map();
export const agentCatalog = (hostId = null) => catalogs.get(hostId) || legacy;
export const agentName = id => agentCatalog().find(a => a.id === id)?.name || ({ pi: 'Pi' })[id] || id || "Agent";
export const canShareAgent = id => !!agentCatalog().find(a => a.id === id)?.sharing;

export async function loadAgentCatalog(hostId = null) {
  if (catalogs.has(hostId)) return catalogs.get(hostId);
  if (pending.has(hostId)) return pending.get(hostId);
  const request = (async () => {
    let options;
    try { options = await api(hostId == null ? "/api/tasks/options" : `/api/nodes/${hostId}/tasks/options`); }
    catch (e) { if (e.status !== 404) throw e; }
    const items = options?.agents;
    const catalog = Array.isArray(items) && items.length && items.every(a => a && /^[a-z][a-z0-9_-]*$/.test(a.id) && typeof a.name === "string") ? items : legacy;
    catalogs.set(hostId, catalog);
    return catalog;
  })();
  pending.set(hostId, request);
  try { return await request; } finally { pending.delete(hostId); }
}

export async function requireAgent(id, hostId = null) {
  const catalog = await loadAgentCatalog(hostId);
  if (!catalog.some(a => a.id === id)) throw new Error(I18N.lang === "zh"
    ? "此设备尚不支持该 Agent，请先更新设备节点。已有任务会保留。"
    : "Update this device's node to use this agent. Existing tasks are kept.");
}
