export interface EnvironmentGroup { coverage: string; items: any[]; reason?: string; [key: string]: any }
export interface EnvironmentManifest {
  schema_version: string;
  captured_at: string;
  collector: { name: string; version: string };
  scope: { cwd: string; probe_context: string; project_files: string };
  groups: Record<string, EnvironmentGroup>;
}
export const ENVIRONMENT_EXTENSION: string;
export function emptyEnvironment(cwd: string, reason?: string): EnvironmentManifest;
export function collectEnvironment(options: { cwd: string; agent: string; raw?: Buffer; workspaceExtension?: string | null }): Promise<EnvironmentManifest>;
export function environmentSummary(environment: unknown): any;
export function boundEnvironment(environment: EnvironmentManifest, otherExtensions: Record<string, any>): EnvironmentManifest;
export function checkEnvironment(environment: unknown, options: { cwd: string; groups?: string[] }): Promise<any>;
export function environmentFingerprint(environment: EnvironmentManifest): string;
