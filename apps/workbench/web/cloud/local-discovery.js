import { localDevice, localOrigin, rememberLocalDevice, forgetLocalDevice } from './device-routing.js';

let cached;
async function permissionBlocked() {
  for (const name of ['loopback-network', 'local-network-access']) {
    try { return (await navigator.permissions.query({ name })).state !== 'granted'; } catch {}
  }
  return false;
}

// Probe only loopback addresses advertised by this account's connected nodes.
// IDs must match: a port belonging to a different device is not local evidence.
// This is routing discovery, never authentication; login still uses node grants.
export async function discoverLocalDevice(user, items, { retry = false } = {}) {
  const known = localDevice(user);
  if (known && items.some(d => d.id === known.device)) return { local: known, blocked: false };
  if (known) forgetLocalDevice(user, known.device);
  const candidates = items.filter(d => d.online && /^[0-9a-f-]{36}$/.test(d.id) && localOrigin(d.local_origin));
  const signature = JSON.stringify([user, candidates.map(d => [d.id, d.local_origin])]);
  if (!retry && cached?.signature === signature && cached.until > Date.now()) return cached.promise;
  const promise = (async () => {
    await Promise.all(candidates.map(async d => {
      const challenge = crypto.randomUUID();
      try {
        const response = await fetch(d.local_origin + '/local/identity?' + new URLSearchParams({ device: d.id, challenge }), {
          mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error',
          referrerPolicy: 'no-referrer', targetAddressSpace: 'loopback', signal: AbortSignal.timeout(6000),
        });
        if (!response.ok) return;
        const identity = await response.json();
        if (identity.device_id === d.id && identity.challenge === challenge) rememberLocalDevice(user, d.id, d.local_origin);
      } catch { /* Absent listeners and browser permission failures are not proof. */ }
    }));
    const local = localDevice(user);
    return { local, blocked: !local && candidates.length > 0 && await permissionBlocked() };
  })();
  cached = { signature, promise, until: Date.now() + 30000 };
  return promise;
}
