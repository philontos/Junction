export interface LocalAccessRequest { user_id: string; username: string; task_id?: string }
export interface LocalAccessResult { url: string; expires_in: number }

// Only the authenticated loopback listener may be advertised for discovery.
export function isLocalWorkspaceOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) >= 1024 && value === url.origin;
  } catch { return false; }
}
