let started = false;

// Fetch/compile assets while the user browses Context. These hints never execute
// the workbench, establish a PTY, or open a device's authenticated document.
export function preloadWorkbenchAssets() {
  if (started || navigator.connection?.saveData) return;
  started = true;
  for (const [href, rel, as] of [
    ['/js/main.js', 'modulepreload'],
    ['/js/features/tasks.js', 'modulepreload'],
    ['/js/features/hosts.js', 'modulepreload'],
    ['/js/features/terminal.js', 'modulepreload'],
    ['/js/core/workbench-data.js', 'modulepreload'],
    ['/vendor/xterm.js', 'prefetch', 'script'],
    ['/vendor/addon-fit.js', 'prefetch', 'script'],
    ['/vendor/addon-canvas.js', 'prefetch', 'script'],
    ['/vendor/xterm.css', 'prefetch', 'style'],
  ]) {
    if (document.querySelector(`link[href="${href}"]`)) continue;
    const link = document.createElement('link'); link.rel = rel; link.href = href;
    if (as) link.as = as;
    document.head.append(link);
  }
}
