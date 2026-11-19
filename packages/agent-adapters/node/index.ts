import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { kimiAdapter } from "./kimi.js";
import { piAdapter } from "./pi.js";
import type { AgentAdapter, AgentKind, LaunchOpts } from "./types.js";
export type { AgentKind, AgentAdapter, LaunchOpts } from "./types.js";

const adapters: Record<AgentKind, AgentAdapter> = { claude: claudeAdapter, codex: codexAdapter, kimi: kimiAdapter, pi: piAdapter };
export const AGENT_KINDS = Object.keys(adapters) as AgentKind[];
export const isAgentKind = (value: unknown): value is AgentKind => typeof value === "string" && Object.hasOwn(adapters, value);
export const asAgentKind = (value: unknown): AgentKind => isAgentKind(value) ? value : "claude";
export function agentAdapter(agent: AgentKind): AgentAdapter { return adapters[agent]; }
export function agentArgv(agent: AgentKind, opts: LaunchOpts = {}): string[] { return agentAdapter(agent).launch(opts); }
export function agentCatalog() {
  return Object.values(adapters).map(({ id, name, version, nativeFormat }) => ({ id, name, version, native_format: nativeFormat, sharing: !!nativeFormat }));
}
export function canShareAgent(agent: unknown): boolean { return isAgentKind(agent) && !!adapters[agent].nativeFormat; }
