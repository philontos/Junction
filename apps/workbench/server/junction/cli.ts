import path from "node:path";
import { db } from "../core/db.js";
import { DATA_DIR } from "../core/paths.js";
import { getOwnedTask } from "../core/ownership.js";
import { localRunner } from "../fleet/runner.js";
import { readConfig, JunctionClient } from "./client.js";
import { checkShare } from "./preflight.js";
import { readContinuationReport } from "./report.js";
import { continueContext } from "./continuation.js";

export async function runContextCommand(args: string[], progress: (message: string) => void = () => {}) {
  const [action, id, ...rest] = args;
  if (action === "check" || action === "report") {
    if (!/^\d+$/.test(id || "") || rest.some(a => a !== "--json")) throw new Error(`Usage: tdsp context ${action} <task-id> [--json]`);
    const task = getOwnedTask(db, Number(id));
    if (!task) throw new Error("Task not found on this node");
    if (action === "check") return checkShare(localRunner, task);
    const report = readContinuationReport(db, task.id);
    if (!report) throw new Error("This task has no preparation report");
    return report;
  }
  if (action === "continue" && id) {
    const flags: Record<string, string> = {};
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--json") continue;
      if (!["--revision", "--agent", "--account", "--instructions", "--title"].includes(rest[i]) || rest[i + 1] === undefined) throw new Error(`Unknown or incomplete option: ${rest[i]}`);
      flags[rest[i].slice(2)] = rest[++i];
    }
    if (!flags.revision || !flags.agent) throw new Error("Use --revision <revision-id> --agent <agent>");
    const client = new JunctionClient(readConfig(process.env.SWITCHYARD_JUNCTION_CONFIG || path.join(DATA_DIR, "junction.json")), flags.account);
    return continueContext({ context_id: id, revision_id: flags.revision, agent: flags.agent, workspace_mode: "context",
      prompt: flags.instructions, title: flags.title }, client, (_stage, message) => progress(message), AbortSignal.timeout(150_000));
  }
  throw new Error("Usage: tdsp context <check TASK | report TASK | continue CONTEXT --revision REVISION --agent AGENT> [--json]");
}
