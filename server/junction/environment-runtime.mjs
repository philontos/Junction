// Portable, dependency-free environment capture/checking. This exact module is
// copied into handoffs; historical commands and paths are never executed.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const ENVIRONMENT_EXTENSION = "junction.environment/1";
const exec = promisify(execFile);
const GROUPS = ["system", "workspace", "runtimes", "dependencies", "agent", "tools", "skills", "variables", "services", "resources", "access"];
const FILES = ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", ".nvmrc", ".node-version",
  "pyproject.toml", "requirements.txt", "uv.lock", "poetry.lock", ".python-version", "go.mod", "Cargo.toml", "Cargo.lock",
  "Dockerfile", "compose.yaml", "docker-compose.yml", ".devcontainer/devcontainer.json"];
const RUNTIMES = { node: "node", python: "python3" };
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const label = value => typeof value === "string" && /^[\w.@:/+-]{1,128}$/.test(value) ? value : null;
const source = (kind, extra = {}) => ({ kind, ...extra });
const item = (id, status, value, evidence, extra = {}) => ({ id, observed: { status, value, source: evidence }, ...extra });
const group = (coverage = "not_collected", reason = "collector_not_implemented") => ({ coverage, items: [], ...(reason ? { reason } : {}) });

export function emptyEnvironment(cwd, reason = "capture_failed") {
  return {
    schema_version: ENVIRONMENT_EXTENSION, captured_at: new Date().toISOString(),
    collector: { name: "switchyard", version: "1" },
    scope: { cwd, probe_context: "switchyard_process", project_files: "known_root_files" },
    groups: Object.fromEntries(GROUPS.map(key => [key, group("not_collected", reason)])),
  };
}

// Only fixed project paths are read. Reject escaping symlinks, non-files, and
// growing/oversized inputs. Do not follow any path obtained from the transcript.
async function projectFile(cwd, relative, signal) {
  if (signal?.aborted) throw new Error("deadline");
  let root;
  try { root = await fs.realpath(cwd); } catch { throw new Error("workspace_unavailable"); }
  const resolved = await fs.realpath(path.join(root, relative));
  if (!inside(root, resolved)) throw new Error("outside_workspace");
  const handle = await fs.open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("not_regular_file");
    if (stat.size > 2 * 1024 * 1024) throw new Error("file_too_large");
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      if (signal?.aborted) throw new Error("deadline");
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("file_changed");
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

function failure(error) {
  if (error?.code === "ENOENT") return "missing";
  if (error?.killed || error?.name === "AbortError" || error?.message === "deadline") return "timeout";
  if (["workspace_unavailable", "outside_workspace", "not_regular_file", "file_too_large", "file_changed"].includes(error?.message)) return error.message;
  return "unreadable";
}

async function executable(name, cwd) {
  const root = await fs.realpath(cwd);
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    // Never execute project-local wrappers found through '.' or node_modules.
    if (!path.isAbsolute(dir) || inside(path.resolve(cwd), path.resolve(dir))) continue;
    try {
      const file = await fs.realpath(path.join(dir, name));
      if (inside(root, file)) continue;
      await fs.access(file, constants.X_OK);
      if ((await fs.stat(file)).isFile()) return file;
    } catch { /* next PATH entry */ }
  }
  return null;
}

async function probeVersion(name, cwd, signal) {
  try {
    const binary = await executable(name, cwd);
    if (!binary) return { status: "missing", value: null, reason: "not_on_path" };
    const result = await exec(binary, ["--version"], { cwd, timeout: 1200, killSignal: "SIGKILL", maxBuffer: 2048, signal });
    const version = (result.stdout + result.stderr).match(/\b\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?\b/)?.[0];
    return version ? { status: "present", value: { version } } : { status: "unknown", value: null, reason: "unrecognized_version" };
  } catch (error) { return { status: "unknown", value: null, reason: failure(error) }; }
}

function add(group, entry, limit = 12) {
  if (group.items.some(existing => existing.id === entry.id)) return;
  if (group.items.length >= limit) { group.reason = "item_limit"; return; }
  group.items.push(entry);
}

function taskEvidence(raw, provider, cwd, groups) {
  groups.tools = group("partial", "native_calls_and_literal_command_names");
  groups.skills = group("partial", "explicit_skill_references_only");
  groups.resources = group("partial", "explicit_file_references_only");
  groups.services = group("partial", "explicit_ssh_references_only");
  groups.access = group("not_collected", "authentication_not_checked");
  const maxBytes = 8 * 1024 * 1024;
  const text = raw.subarray(0, maxBytes).toString("utf8");
  const lines = text.split("\n");
  let version = null;
  function call(name, args, evidence) {
    if (!label(name)) return;
    add(groups.tools, item(name, "unknown", { name, invoked: true }, evidence));
    if (name === "Skill" && label(args?.skill)) add(groups.skills, item(args.skill, "unknown", { name: args.skill }, evidence));
    const file = args?.file_path ?? args?.path;
    if (["Read", "read_file", "view_image"].includes(name) && typeof file === "string" && file.length < 512 && !/[\x00-\x1f]/.test(file)) {
      if (/(^|[/\\])(?:\.env(?:\.|$)|\.ssh|auth\.json|credentials)/i.test(file)) return;
      if (file.endsWith("/SKILL.md")) {
        const name = label(path.basename(path.dirname(file)));
        if (name) add(groups.skills, item(name, "unknown", { name, reference: file }, evidence));
      } else if (!file.includes("/.tdsp/")) {
        const reference = path.isAbsolute(file) && inside(cwd, file) ? path.relative(cwd, file) : file;
        add(groups.resources, item(reference, "unknown", { reference, included: false }, evidence), 8);
      }
    }
    const command = args?.command ?? args?.cmd;
    // A literal executable name is useful evidence; do not retain its arguments
    // or try to interpret scripts, shell expansions, pipelines, or Code Mode.
    const cli = typeof command === "string" ? /^\s*([a-zA-Z][\w.+-]{0,63})(?:\s|$)/.exec(command)?.[1] : null;
    if (cli && ["Bash", "bash", "exec_command", "shell_command"].includes(name)) {
      add(groups.tools, item(`cli:${cli}`, "unknown", { kind: "cli", name: cli, invoked: true }, evidence));
    }
    // Recognize only a literal, argument-free SSH alias position. Never retain
    // command lines, flags, environment values or inline credentials.
    const alias = typeof command === "string" ? /^\s*ssh\s+([a-zA-Z][\w.-]{0,63})(?:\s|$)/.exec(command)?.[1] : null;
    if (alias) {
      groups.services.coverage = "partial"; groups.services.reason = "log_reference_only";
      add(groups.services, item(`ssh:${alias}`, "unknown", { kind: "ssh", alias }, evidence), 6);
      groups.access.coverage = "partial"; groups.access.reason = "authentication_not_checked";
      add(groups.access, item(`ssh:${alias}`, "unknown", { capability: "ssh:connect", resource_ref: `ssh:${alias}` }, evidence), 6);
    }
  }
  for (let index = 0; index < Math.min(lines.length, 10_000); index++) {
    if (lines[index].length > 1024 * 1024) { groups.tools.reason = "oversized_log_record"; continue; }
    let entry; try { entry = JSON.parse(lines[index]); } catch { continue; }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const evidence = source("log_record", { line: index + 1 });
    // Unknown historical times stay unknown, rather than inheriting capture time.
    evidence.observed_at = typeof entry.timestamp === "string" && entry.timestamp.length <= 64 && /(?:Z|[+-]\d{2}:\d{2})$/.test(entry.timestamp)
      && Number.isFinite(Date.parse(entry.timestamp)) ? new Date(entry.timestamp).toISOString() : null;
    if (provider === "claude") {
      if (typeof entry.version === "string" && entry.version.length <= 64 && /^\d+\.\d+\.\d+[\w.+-]*$/.test(entry.version)) version = item(provider, "present", { name: provider, version: entry.version }, evidence);
      for (const block of Array.isArray(entry.message?.content) ? entry.message.content : []) {
        if (block?.type === "tool_use") call(block.name, block.input, evidence);
      }
    } else if (provider === "codex") {
      const payload = entry.payload;
      if (entry.type === "session_meta" && typeof payload?.cli_version === "string" && payload.cli_version.length <= 64 && /^\d+\.\d+\.\d+[\w.+-]*$/.test(payload.cli_version)) version = item(provider, "present", { name: provider, version: payload.cli_version }, evidence);
      if (entry.type === "response_item" && ["function_call", "custom_tool_call"].includes(payload?.type)) {
        let args = payload.arguments;
        if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = null; } }
        call(payload.name, args, evidence);
      }
    }
  }
  if (raw.length > maxBytes || lines.length > 10_000) {
    for (const key of ["tools", "skills", "resources"]) groups[key].reason = "log_scan_limit";
  }
  groups.agent = group("partial", version ? "historical_version" : "version_not_recorded");
  groups.agent.items.push(version || item(provider, "unknown", { name: provider }, source("task_metadata")));
}

async function capture(options, signal) {
  const { cwd, agent, raw = Buffer.alloc(0), workspaceExtension = null } = options;
  const result = emptyEnvironment(cwd, "collector_not_implemented"), groups = result.groups;
  groups.system = { coverage: "collected", items: [item("host", "present", {
    platform: os.platform(), release: os.release(), arch: os.arch(), configured_shell: path.basename(process.env.SHELL || "") || null,
  }, source("local_probe"))] };
  groups.workspace = { coverage: workspaceExtension === "switchyard.workspace/1" ? "collected" : "partial", items: [], reference: workspaceExtension };
  taskEvidence(raw, agent, cwd, groups);
  try { if (!(await fs.stat(cwd)).isDirectory()) throw new Error("workspace_unavailable"); }
  catch {
    for (const key of ["runtimes", "dependencies", "variables"]) groups[key] = group("not_collected", "workspace_unavailable");
    return result;
  }
  groups.runtimes = group("collected", null);
  groups.dependencies = group("collected", null);
  groups.variables = group("partial", "example_file_names_only");
  const jobs = [
    ...Object.entries(RUNTIMES).map(async ([id, binary]) => {
      const observed = await probeVersion(binary, cwd, signal);
      groups.runtimes.items.push({ id, observed: { ...observed, source: source("local_probe") } });
      if (observed.status === "unknown") groups.runtimes.coverage = "partial";
    }),
    ...FILES.map(async name => {
      try {
        const bytes = await projectFile(cwd, name, signal);
        const entry = item(name, "present", { path: name, sha256: hash(bytes), bytes: bytes.length }, source("project_file", { reference: name }));
        if (name === "package.json") {
          try {
            const pkg = JSON.parse(bytes.toString("utf8"));
            const engines = Object.fromEntries(Object.entries(pkg.engines || {}).filter(([key, value]) =>
              ["node", "npm", "pnpm", "yarn"].includes(key) && typeof value === "string" && /^[\w.*<>=|^~ /+-]{1,100}$/.test(value)));
            if (Object.keys(engines).length) entry.observed.value.engines = engines;
          } catch { groups.dependencies.coverage = "partial"; entry.observed.reason = "invalid_package_json"; }
        }
        groups.dependencies.items.push(entry);
      } catch (error) {
        if (failure(error) !== "missing") {
          groups.dependencies.coverage = "partial";
          const entry = item(name, "unknown", null, source("project_file", { reference: name }));
          entry.observed.reason = failure(error);
          groups.dependencies.items.push(entry);
        }
      }
    }),
    (async () => {
      try {
        const bytes = await projectFile(cwd, ".env.example", signal);
        for (const line of bytes.toString("utf8").split("\n")) {
          const name = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]{0,63})\s*=/.exec(line)?.[1];
          if (name) add(groups.variables, item(name, "unknown", { name }, source("project_file", { reference: ".env.example" })), 12);
        }
      } catch (error) { groups.variables.reason = failure(error) === "missing" ? "no_example_file" : failure(error); }
    })(),
  ];
  await Promise.allSettled(jobs);
  for (const value of Object.values(groups)) value.items.sort((a, b) => a.id.localeCompare(b.id, "en"));
  return result;
}

export async function collectEnvironment(options) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      capture(options, controller.signal),
      new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(emptyEnvironment(options.cwd, "capture_timeout")); }, 2500); }),
    ]);
  } catch { return emptyEnvironment(options.cwd); }
  finally { clearTimeout(timer); }
}

export function environmentSummary(environment) {
  if (!environment) return { status: "not_recorded", groups: {} };
  if (environment.schema_version !== ENVIRONMENT_EXTENSION || !environment.groups) return { status: "unsupported", groups: {} };
  return { status: "recorded", captured_at: environment.captured_at, scope: environment.scope,
    groups: Object.fromEntries(Object.entries(environment.groups).map(([key, group]) => [key, {
      coverage: group.coverage, count: Array.isArray(group.items) ? group.items.length : 0, reason: group.reason,
    }])) };
}

// Match Python's ensure_ascii/default separators, and bound the encoded URL too.
function encodedSize(value) {
  const json = JSON.stringify(value).replace(/[\u007f-\uffff]/g, char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
  return json.length + (json.match(/[:,]/g)?.length || 0);
}
export function boundEnvironment(environment, otherExtensions) {
  const copy = structuredClone(environment);
  const fits = () => {
    const extensions = { ...otherExtensions, [ENVIRONMENT_EXTENSION]: copy };
    return encodedSize(extensions) <= 7800 && new URLSearchParams({ extensions: JSON.stringify(extensions) }).toString().length <= 11_000;
  };
  for (const key of ["resources", "tools", "skills", "variables", "dependencies", "services", "access", "runtimes", "agent"]) {
    const group = copy.groups[key];
    while (!fits() && group.items.length) {
      group.items.pop(); group.coverage = "partial"; group.reason = "metadata_size_limit";
      group.omitted_count = (group.omitted_count || 0) + 1;
    }
  }
  return fits() ? copy : emptyEnvironment("", "metadata_size_limit");
}

export async function checkEnvironment(environment, { cwd, groups = ["system", "runtimes", "dependencies"] } = {}) {
  if (!environment || environment.schema_version !== ENVIRONMENT_EXTENSION) return { status: environment ? "unsupported" : "not_recorded", items: [] };
  const selected = [...new Set(groups)];
  if (selected.some(name => !GROUPS.includes(name))) throw new Error("Unknown environment group");
  const report = { schema_version: "junction.environment-check/1", checked_at: new Date().toISOString(), cwd,
    probe_context: "checker_process", source_captured_at: environment.captured_at, groups: selected, items: [] };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const tasks = [];
    for (const name of selected) {
      const group = environment.groups?.[name];
      if (!group?.items?.length) {
        report.items.push({ group: name, status: group?.coverage === "not_applicable" ? "not_applicable" : "unknown", reason: group?.reason || "no_recorded_items" });
        continue;
      }
      for (const entry of group.items.slice(0, 50)) tasks.push((async () => {
        const check = { group: name, id: entry.id, status: "unknown", requirement: entry.requirement?.level || "unknown", reason: "manual_check_required" };
        if (entry.observed?.status !== "present") { check.reason = "source_availability_unknown"; return check; }
        const previous = entry.observed.value;
        let current;
        if (name === "system" && entry.id === "host") current = { status: "present", value: { platform: os.platform(), arch: os.arch() } };
        else if (name === "runtimes" && Object.hasOwn(RUNTIMES, entry.id)) current = await probeVersion(RUNTIMES[entry.id], cwd, controller.signal);
        else if (name === "dependencies" && FILES.includes(entry.id)) {
          try { const bytes = await projectFile(cwd, entry.id, controller.signal); current = { status: "present", value: { sha256: hash(bytes) } }; }
          catch (error) { current = { status: failure(error) === "missing" ? "missing" : "unknown", value: null, reason: failure(error) }; }
        }
        if (!current) return check;
        check.current = current;
        check.status = current.status === "missing" ? "missing" : current.status === "unknown" ? "unknown"
          : Object.entries(current.value).every(([key, value]) => previous?.[key] === value) ? "same" : "different";
        check.reason = current.reason || "observations_compared_not_compatibility";
        return check;
      })());
    }
    const checks = await Promise.allSettled(tasks);
    report.items.push(...checks.map(result => result.status === "fulfilled" ? result.value : { status: "unknown", reason: "check_failed" }));
    return report;
  } finally { clearTimeout(timer); }
}

export function environmentFingerprint(environment) {
  const copy = structuredClone(environment);
  delete copy.captured_at;
  return hash(JSON.stringify(copy));
}
