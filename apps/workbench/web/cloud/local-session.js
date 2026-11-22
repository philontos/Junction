// Recover a browser's existing local workspace through the normal cloud login
// flow. This stores only a retry timestamp, never a login code or credential.
const retryKey = device => 'switchyard-local-recovery:' + device;

export function beginLocalRecovery(device) {
  try {
    const last = Number(sessionStorage.getItem(retryKey(device)));
    const now = Date.now();
    if (last && now >= last && now - last < 60000) return false;
    sessionStorage.setItem(retryKey(device), String(now));
    return true;
  } catch { return false; } // Retain the manual retry when storage is restricted.
}

export function clearLocalRecovery(device) {
  try { sessionStorage.removeItem(retryKey(device)); } catch {}
}

// A desktop may resume without a network-change event. Check immediately on
// return instead of waiting for a stale terminal socket or the next poll.
export function watchLocalSession(device, onExpired) {
  let pending = false, navigating = false, stopped = false;
  async function check() {
    if (stopped || pending || navigating || document.hidden) return;
    pending = true;
    try {
      const response = await fetch('/local/status', { signal: AbortSignal.timeout(3000) });
      if (stopped) return;
      if (response.status === 401) { navigating = true; onExpired(); }
      else if (response.ok) clearLocalRecovery(device);
    } catch { /* A network outage or node restart does not invalidate a login. */ }
    finally { pending = false; }
  }
  const events = ['pageshow', 'focus', 'online'];
  for (const event of events) window.addEventListener(event, check);
  document.addEventListener('visibilitychange', check);
  const timer = setInterval(check, 30000);
  void check();
  return () => {
    stopped = true;
    clearInterval(timer);
    for (const event of events) window.removeEventListener(event, check);
    document.removeEventListener('visibilitychange', check);
  };
}
