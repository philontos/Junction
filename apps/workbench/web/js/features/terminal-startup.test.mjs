import test from "node:test";
import assert from "node:assert/strict";
import { hasTerminalContent, mountTerminalStartup } from "./terminal-startup.js";

function terminal(lines, viewportY = 0) {
  return { rows: lines.length - viewportY, buffer: { active: {
    viewportY,
    getLine: row => ({ translateToString: () => lines[row] || "" }),
  } } };
}

test("blank screens and tmux's status alone keep the startup indicator", () => {
  for (const lines of [
    ["", "   ", ""],
    ["", "", '[tdsp-00ed0:tmux*                  "host" 12:21'],
    ["[tdsp-00ed] 0:tmux*", "", ""],
  ]) assert.equal(hasTerminalContent(terminal(lines)), false);
  assert.equal(hasTerminalContent(terminal(["old scrollback", "", "[tdsp-session]"], 1)), false);
});

test("banners, trust prompts and startup errors immediately reveal the terminal", () => {
  for (const lines of [
    ["OpenAI Codex", "", "[tdsp-session] 0:codex*"],
    ["", "Trust this folder?", "[tdsp-session] 0:claude*"],
    ["", "", "command not found: codex"],
    ["[tdsp-session] 0:codex*", "", "Press Enter to continue"],
  ]) assert.equal(hasTerminalContent(terminal(lines)), true);
});

function element() {
  return {
    dataset: {}, children: [], hidden: false, removed: false,
    appendChild(child) { this.children.push(child); },
    setAttribute() {}, remove() { this.removed = true; },
  };
}

function mount(t) {
  const originals = ["document", "I18N"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: element } });
  Object.defineProperty(globalThis, "I18N", { configurable: true, value: { t: key => key } });
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pane = element(), lines = ["", "", "[tdsp-test] 0:tmux*"];
  const startup = mountTerminalStartup(pane, terminal(lines));
  t.after(() => startup.dispose());
  return { startup, indicator: pane.children[0], lines };
}

test("slow startup stays visible until actual output, then stays gone across reconnects", t => {
  const { startup, indicator, lines } = mount(t);
  startup.connecting();
  t.mock.timers.tick(250);
  assert.equal(indicator.hidden, false);
  assert.equal(indicator.children[1].textContent, "term.connecting");
  startup.connected("codex");
  startup.inspect();
  t.mock.timers.tick(15_000);
  assert.equal(indicator.hidden, false);
  assert.equal(indicator.children[1].textContent, "term.starting.codex");
  lines[0] = "Sign in to Codex";
  startup.inspect();
  assert.equal(indicator.removed, true);
  lines[0] = "";
  startup.connecting();
  startup.connected("codex");
  t.mock.timers.tick(250);
  assert.equal(indicator.hidden, true);
});

test("a ready session never flashes the indicator", t => {
  const { startup, indicator, lines } = mount(t);
  startup.connecting();
  startup.connected("claude");
  lines[0] = "Claude Code";
  startup.inspect();
  t.mock.timers.tick(250);
  assert.equal(indicator.hidden, true);
});

test("disconnect and disposal cancel pending feedback; shells use a neutral label", t => {
  const { startup, indicator } = mount(t);
  startup.connecting();
  startup.hide();
  t.mock.timers.tick(250);
  assert.equal(indicator.hidden, true);
  startup.connecting();
  startup.connected("shell");
  assert.equal(indicator.children[1].textContent, "term.waitingOutput");
  startup.dispose();
  t.mock.timers.tick(250);
  assert.equal(indicator.hidden, true);
  assert.equal(indicator.removed, true);
});
