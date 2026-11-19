import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { ENVIRONMENT_EXTENSION, environmentSummary, checkEnvironment } from "./environment-runtime.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
const data = read("normalized.json");
const environment = data.extensions?.[ENVIRONMENT_EXTENSION];
const [command = "info", arg = "", size = "10"] = process.argv.slice(2);
let result;
if (command === "info") {
  result = { ...data, records: undefined, session: { ...data.session, messages: undefined, turns: undefined },
    message_count: data.session.messages.length, turn_count: data.session.turns.length,
    extensions: { ...data.extensions, [ENVIRONMENT_EXTENSION]: undefined }, environment: environmentSummary(environment) };
} else if (command === "environment") {
  if (arg && !Object.hasOwn(environment?.groups || {}, arg)) throw new Error("Environment group not recorded");
  result = arg ? environment.groups[arg] : environmentSummary(environment);
} else if (command === "check-environment") {
  // Pin checks to THIS handoff's worktree, never to a historical absolute path.
  const manifest = read("manifest.json");
  const cwd = manifest.working_directory || path.resolve(directory, "../..");
  result = await checkEnvironment(environment, { cwd, ...(arg ? { groups: arg.split(",") } : {}) });
  result.context_id = manifest.context_id;
  result.revision_id = manifest.revision_id;
  result.check_id = crypto.randomUUID();
  const temporary = path.join(directory, ".check-" + result.check_id);
  try {
    fs.writeFileSync(temporary, JSON.stringify(result, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, path.join(directory, "environment-check.json"));
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
} else if (command === "message") result = data.session.messages.find(m => m.id === arg) ?? null;
else if (command === "record") result = (data.records || []).find(r => r.id === arg) ?? null;
else if (["messages", "turns", "records"].includes(command)) {
  const offset = Number(arg), limit = Number(size);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("Use offset >= 0 and limit 1..50");
  const items = command === "records" ? (data.records || []) : data.session[command];
  result = { items: items.slice(offset, offset + limit).map(m => command !== "messages" ? m : { ...m, content: undefined, preview: JSON.stringify(m.content).slice(0, 1500) }),
    next_offset: offset + limit < items.length ? offset + limit : null };
} else throw new Error("Usage: node read.mjs info | environment [group] | check-environment [group,group] | messages/turns/records [offset] [limit] | message/record ID");
console.log(JSON.stringify(result, null, 2));
