import fs from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";

export interface PreparationItem {
  id: string;
  kind: "context" | "workspace" | "reference" | "environment" | "agent";
  title: string;
  status: "ready" | "missing" | "unknown" | "different" | "not_applicable";
  message: string;
  alias?: string;
  repo_url?: string;
  branch?: string | null;
  commit?: string | null;
  path?: string;
}
export interface ContinuationReport {
  schema_version: "junction.continuation/1";
  task_id: number;
  context_id: string;
  revision_id: string;
  recorded_at: string;
  mode: "repo" | "directory";
  agent: string;
  launch: "preparing" | "started" | "failed";
  cwd: string;
  items: PreparationItem[];
}
export function reportSummary(report: ContinuationReport | null) {
  if (!report) return undefined;
  return { launch: report.launch, mode: report.mode, issues: report.items.filter(i => !["ready", "not_applicable"].includes(i.status)).length };
}
export function readContinuationReport(db: Database.Database, id: number): ContinuationReport | null {
  const row = db.prepare("SELECT report_json FROM task_continuations WHERE task_id=?").get(id) as { report_json: string } | undefined;
  return row ? JSON.parse(row.report_json) : null;
}
export async function saveContinuationReport(db: Database.Database, dataDir: string, report: ContinuationReport) {
  const content = JSON.stringify(report, null, 2) + "\n";
  db.prepare("INSERT INTO task_continuations(task_id,report_json) VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET report_json=excluded.report_json")
    .run(report.task_id, content);
  const dir = path.join(dataDir, "tasks", String(report.task_id));
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const destination = path.join(dir, "continuation.json");
  const temporary = destination + ".tmp";
  await fs.writeFile(temporary, content, { mode: 0o600 });
  await fs.rename(temporary, destination);
}
export function preparationError(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/(https?:\/\/)[^\s/]+@/g, "$1[redacted]@")
    .replace(/([?&](?:token|key|access_token)=)[^&\s]+/gi, "$1[redacted]").slice(0, 1200);
}
