import { api } from './dom.js';

const resources = ['/api/repos', '/api/hosts', '/api/tasks'];
const pending = new Map();

// Start after device routing is confirmed, in parallel with importing main.js.
// Each result is consumed once by the normal loader. Keep it in this document
// only: another account/device can never inherit a stale task snapshot.
export function preloadWorkbenchData() {
  for (const path of resources) {
    if (pending.has(path)) continue;
    const request = api(path, { signal: AbortSignal.timeout(15000) });
    pending.set(path, request);
    request.catch(() => {}); // The consuming loader owns error presentation.
  }
}

export function readWorkbenchData(path, options = {}) {
  const request = pending.get(path);
  if (!request) return api(path, options);
  pending.delete(path);
  return request;
}
