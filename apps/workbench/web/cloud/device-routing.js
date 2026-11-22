// Browser-local routing preference, never an execution credential. Ownership
// and one-use login are still checked by the gateway and the selected node.
import { withContext } from './context-link.js';
const key = user => 'switchyard-local-device:' + user;
const pendingKey = 'switchyard-local-confirmation';
const uuid = value => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
export const localOrigin = value => {
  try { const url = new URL(value); return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !!url.port && value === url.origin; }
  catch { return false; }
};
const remembered = new Map(); // Storage-restricted browsers can still route this page.
export const validTask = value => typeof value === 'string' && /^(?:[1-9]\d*|n[1-9]\d*:[1-9]\d*)$/.test(value);
export function localDevice(user) {
  if (remembered.has(user)) return remembered.get(user);
  try {
    const value = JSON.parse(localStorage.getItem(key(user)));
    return uuid(value.device) && localOrigin(value.origin) ? value : null;
  } catch { return null; }
}
export function rememberLocalDevice(user, device, origin) {
  if (!user || !uuid(device) || !localOrigin(origin)) return;
  try { localStorage.setItem(key(user), JSON.stringify({ device, origin })); remembered.delete(user); }
  catch { remembered.set(user, { device, origin }); }
}
export function devicePath(device, user, task) {
  const local = localDevice(user)?.device === device;
  return (local ? '/local/open/' + device : '/workspace/' + device + '/') + (validTask(task) ? '?task=' + encodeURIComponent(task) : '');
}
export function forgetLocalDevice(user, device) {
  if (localDevice(user)?.device !== device) return;
  remembered.delete(user);
  try { localStorage.removeItem(key(user)); } catch {}
}
export function beginLocalConfirmation(user, device, origin, task, context) {
  if (!user || !uuid(device) || !localOrigin(origin)) return '';
  const known = localDevice(user);
  if (known?.device === device && known.origin === origin) return '';
  const nonce = crypto.randomUUID();
  try {
    sessionStorage.setItem(pendingKey, JSON.stringify({ nonce, user, device, origin, task: validTask(task) ? task : null, context, expires: Date.now() + 120000 }));
    return nonce;
  } catch { return ''; } // Storage restrictions must not block local work.
}
export function confirmLocalDevice(nonce, device, user) {
  let pending;
  try { pending = JSON.parse(sessionStorage.getItem(pendingKey)); } catch {}
  if (!pending || !nonce || pending.nonce !== nonce || pending.device !== device || pending.user !== user || pending.expires <= Date.now() || !uuid(device) || !localOrigin(pending.origin)) throw new Error('本机确认已失效，请重新连接这台电脑。');
  sessionStorage.removeItem(pendingKey);
  // Only the same tab that initiated the login can confirm it. The callback
  // runs after the loopback node has accepted its own device-bound login code.
  rememberLocalDevice(user, device, pending.origin);
  return withContext(pending.origin + '/local/open' + (validTask(pending.task) ? '?task=' + encodeURIComponent(pending.task) : ''), pending.context);
}
