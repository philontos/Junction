// Shared by the portal, login transitions and workbench. Load before styles so
// the first paint uses the incoming theme, even across cloud/loopback origins.
// Colors live in css/app.css; Theme.onChange also re-skins the xterm canvases.

(function () {
  const KEY = "theme";
  const DEFAULT = "dark";
  let initialized = false;
  let memoryTheme = null;
  const valid = value => value === "light" || value === "dark";
  // browser-chrome color per theme = each theme's --bg (see app.css tokens). Duplicated
  // here because <meta theme-color> takes a literal, not a CSS var — keep in sync.
  const CHROME = { dark: "#1a1613", light: "#f5f0e8" };

  function current() {
    return document.documentElement.dataset.theme === "light" ? "light" : "dark";
  }

  // Mirror the theme onto <meta name="theme-color"> so iOS paints its edge strips /
  // swipe-transition gutters and the address bar in the app background, not white.
  function applyChrome() {
    const m = document.querySelector('meta[name="theme-color"]');
    if (m) m.content = CHROME[current()];
  }

  function apply(next) {
    const changed = next !== current();
    document.documentElement.dataset.theme = next;
    applyChrome();
    refreshLinks();
    if (changed && typeof Theme.onChange === "function") Theme.onChange(next);
  }

  function set(next) {
    if (!valid(next)) return;
    try { localStorage.setItem(KEY, next); memoryTheme = null; } catch (_) { memoryTheme = next; }
    apply(next);
  }

  function toggle() { set(current() === "light" ? "dark" : "light"); }

  function savedTheme() {
    if (memoryTheme) return memoryTheme;
    try {
      const saved = localStorage.getItem(KEY);
      return valid(saved) ? saved : DEFAULT;
    } catch (_) { return current(); }
  }

  // Carry only a display preference. Keep login codes, confirmation nonces and
  // task selections intact; none of these URLs grant additional permissions.
  function url(target) {
    const next = new URL(target, location.href);
    const fragment = new URLSearchParams(next.hash.slice(1));
    fragment.set(KEY, current());
    next.hash = fragment.toString();
    return next.href;
  }

  function refreshLinks() {
    for (const link of document.querySelectorAll("a[data-theme-link][href]")) link.href = url(link.href);
  }

  function init() {
    if (initialized) return;
    initialized = true;
    const fragment = new URLSearchParams(location.hash.slice(1));
    const incoming = fragment.get(KEY);
    if (fragment.has(KEY)) {
      fragment.delete(KEY);
      const remaining = fragment.toString();
      history.replaceState(history.state, "", location.pathname + location.search + (remaining ? "#" + remaining : ""));
    }
    if (valid(incoming)) set(incoming);
    else apply(savedTheme());
  }

  const Theme = {
    set,
    toggle,
    init,
    url,
    onChange: null, // app sets this to re-skin terminals on switch
    get theme() { return current(); },
  };
  window.Theme = Theme;
  init();
  document.addEventListener("DOMContentLoaded", refreshLinks);
  // Include new-tab and context-menu navigation, including dynamically added
  // device links, without intercepting the browser's normal navigation.
  for (const event of ["click", "auxclick", "contextmenu"]) document.addEventListener(event, e => {
    const link = e.target.closest?.("a[data-theme-link][href]");
    if (link) link.href = url(link.href);
  }, true);
  window.addEventListener("storage", event => {
    try { if (event.storageArea !== localStorage) return; } catch (_) { return; }
    if (event.key === KEY || event.key === null) { memoryTheme = null; apply(savedTheme()); }
  });
  window.addEventListener("pageshow", () => apply(savedTheme()));
})();
