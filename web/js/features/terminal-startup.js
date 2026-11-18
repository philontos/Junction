// Inspect parsed cells, not raw PTY bytes: tmux emits escape sequences and its
// own status bar before the agent has rendered anything.
export function hasTerminalContent(term) {
  const buffer = term.buffer?.active;
  if (!buffer) return false;
  const top = buffer.viewportY;
  for (let row = 0; row < term.rows; row++) {
    const text = buffer.getLine(top + row)?.translateToString(true).trim() || "";
    if (!text) continue;
    // The default tmux status can be at either edge; its session name is often
    // truncated before the closing bracket. Prompts/errors on those rows count.
    if ((row === 0 || row === term.rows - 1) && /^\[tdsp-/.test(text)) continue;
    return true;
  }
  return false;
}

export function mountTerminalStartup(pane, term) {
  const indicator = document.createElement("div");
  indicator.className = "term-startup";
  indicator.hidden = true;
  indicator.setAttribute("role", "status");
  const spinner = document.createElement("span");
  spinner.className = "spinner";
  spinner.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  indicator.appendChild(spinner);
  indicator.appendChild(label);
  pane.appendChild(indicator);
  let done = false, timer = null;

  function hide() {
    clearTimeout(timer);
    timer = null;
    indicator.hidden = true;
  }
  function show(key) {
    if (done) return;
    label.dataset.i18n = key;
    label.textContent = I18N.t(key);
    // Existing sessions normally repaint immediately; avoid a loading flash.
    if (indicator.hidden && timer === null) timer = setTimeout(() => {
      timer = null;
      indicator.hidden = false;
    }, 250);
  }
  function dispose() {
    done = true;
    hide();
    indicator.remove();
  }
  return {
    connecting: () => show("term.connecting"),
    connected: agent => show(["codex", "claude", "kimi"].includes(agent)
      ? `term.starting.${agent}` : "term.waitingOutput"),
    inspect() { if (!done && hasTerminalContent(term)) dispose(); },
    hide,
    dispose,
  };
}
