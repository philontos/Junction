import type { IncomingMessage } from 'node:http';

// Cloud-managed nodes are reached through the authenticated gateway. Reject
// direct browser origins and DNS rebinding on their private loopback listener.
// This does not change standalone Switchyard's existing access mode.
export function permitsNodeRequest(req: IncomingMessage, managed = process.env.SWITCHYARD_CLOUD_MANAGED === '1') {
  if (!managed) return true;
  return !req.headers.origin && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '');
}
