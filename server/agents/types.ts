import type { CommandRunner, Runner } from "../fleet/runner.js";
import type { Task } from "../core/db.js";

export type AgentKind = "claude" | "codex" | "kimi" | "pi";

export interface LaunchOpts {
  prompt?: string | null;
  model?: string | null;
  resume?: boolean;
  sessionId?: string;
  sessionDir?: string;
  sessionFile?: string;
  binary?: string;
  claudeSettings?: string;
  addDirs?: string[];
  workspaceInstructions?: string | null;
  kimiAgentFile?: string | null;
}

export type Entry =
  | { t: "user"; text: string }
  | { t: "assistant"; text: string }
  | { t: "thinking"; text: string }
  | { t: "tool_call"; id: string; name: string; arg: string; detail: string }
  | { t: "tool_result"; id: string; ok: boolean; output: string };

export interface LocatedSession { file: string; source: string }
export interface SessionLookup { runner: Runner; task: Task; refresh?: boolean; archive?: boolean }
export interface LaunchContext {
  runner: CommandRunner & { dataDir?: string };
  session: string;
  cwd: string;
  opts: LaunchOpts;
}
export interface ImagePasteAdapter {
  storageDir: string;
  gitExcludePattern: string;
  inputText(imagePath: string): string;
}

/** Explicit local adapters; archives can never install or execute adapters. */
export interface AgentAdapter {
  id: AgentKind;
  name: string;
  version: number;
  /** Null means native sharing is not implemented, even if the CLI can run. */
  nativeFormat: string | null;
  installCommand?: string;
  writableGitDirs?: boolean;
  initialPrompt?: "afterReady";
  launch(opts: LaunchOpts): string[];
  prepareLaunch?(context: LaunchContext): Promise<Partial<LaunchOpts>>;
  waitUntilReady?(runner: CommandRunner, session: string): Promise<void>;
  /** Exact directory-task binding. Pi binds by its private session directory. */
  directoryResumeId?(runner: Runner, task: Task): Promise<string | null>;
  locate(context: SessionLookup): Promise<LocatedSession | null>;
  parseLine(record: any): Entry[];
  parseUserLine?(record: any): Entry[];
  userOnlyMode?: "codex-user-message-v1";
  imagePaste: ImagePasteAdapter;
}
