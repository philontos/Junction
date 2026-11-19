import type { Runner } from "./types.js";

export const OUT_CAP = 6000;   // truncate a single tool output to keep the payload sane
export const IN_CAP = 2000;    // truncate a tool's expanded input detail
export const oneLine = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);
export const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "\n…（已截断）" : s);
export const tryParse = (s: string) => { try { return JSON.parse(s); } catch { return null; } };

// Best one-liner for a tool call's summary row: the command / file / pattern it acts on.
export function toolArg(input: unknown): string {
  const o = typeof input === "string" ? tryParse(input) : input;
  if (o && typeof o === "object") {
    const rec = o as Record<string, unknown>;
    for (const k of ["command", "cmd", "file_path", "path", "pattern", "url", "query", "description"]) {
      if (typeof rec[k] === "string") return oneLine(rec[k] as string, 140);
    }
    for (const k of Object.keys(rec)) if (typeof rec[k] === "string") return oneLine(rec[k] as string, 140);
    return "";
  }
  return typeof input === "string" ? oneLine(input, 140) : "";
}
export function toolDetail(input: unknown): string {
  if (input == null) return "";
  const s = typeof input === "string" ? (tryParse(input) ? JSON.stringify(JSON.parse(input as string), null, 2) : input) : JSON.stringify(input, null, 2);
  return cap(s, IN_CAP);
}

// Claude tool_result.content is a string or an array of {type,text|...} blocks.
export function claudeContentStr(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : (x?.type === "text" ? x.text : x?.type === "image" ? "[image]" : ""))).join("");
  return c == null ? "" : JSON.stringify(c);
}

// Kimi ContentPart arrays use text/think plus media containers. Read mode does
// not render binary media inline, but retaining a marker keeps an image-only
// prompt or tool result visible in the conversation.
export function kimiContentStr(c: unknown): string {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return c == null ? "" : JSON.stringify(c);
  return c.map((x) => {
    if (typeof x === "string") return x;
    if (x?.type === "text" && typeof x.text === "string") return x.text;
    if (x?.type === "think" && typeof x.think === "string") return x.think;
    if (x?.imageUrl || x?.image_url || x?.type === "image") return "[image]";
    if (x?.audioUrl || x?.audio_url || x?.type === "audio") return "[audio]";
    return "";
  }).join("");
}

// Only accept the task binding in native instruction/config records. A copied
// transcript or user message mentioning another task must not claim its session.
export function hasTaskBinding(prefix: string, marker: string): boolean {
  return prefix.split("\n").some(line => {
    try {
      const record = JSON.parse(line);
      const p = record.payload;
      const instruction = record.type === "response_item" && p?.role === "developer" ? p.content
        : record.type === "session_meta" ? p?.developer_instructions
        : record.type === "config.update" ? record.systemPrompt : undefined;
      return instruction != null && JSON.stringify(instruction).includes(marker);
    } catch { return false; }
  });
}
export async function matchesTask(runner: Runner, file: string, marker: string) {
  const prefix = await runner.exec("head", ["-c", "2097152", file]).catch(() => "");
  return hasTaskBinding(prefix, marker);
}
export const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
export const ere = (s: string) => s.replace(/[.[\]{}()*+?^$|\\]/g, "\\$&");

export const hasText = (s?: string | null): s is string => !!s && !!s.trim();
export const addDirArgs = (dirs?: string[]) => (dirs ?? []).flatMap((d) => hasText(d) ? ["--add-dir", d.trim()] : []);
export const claudeAddDirArgs = (dirs?: string[]) => {
  const clean = (dirs ?? []).filter(hasText).map((dir) => dir.trim());
  return clean.length ? ["--add-dir", ...clean] : [];
};
