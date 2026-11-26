// Pure lifecycle state shared by remote-card rendering and its regression test.
// Keep presentation and endpoint names out of this module: it only answers which
// action/state a task represents.
export function taskLifecycle(task) {
  const active = task.status !== "cleaned";
  const hasWorktree = !!task.hasWorktree;
  return {
    active,
    action: active ? "stop" : hasWorktree ? "removeWorktree" : "deleteRecord",
    resumable: task.kind !== "local" && task.status !== "creating" && task.runtime?.state !== "unknown"
      && !task.alive && (hasWorktree || !!task.hasDirectory),
    connectable: active && (!!task.alive || task.runtime?.state === "exited"
      || (task.runtime?.state === "unknown" && !!task.session)),
  };
}

/** Shared local/remote presentation. Running means a live process, not an LLM request. */
export function taskRuntimePresentation(task, t) {
  if (task.status === "cleaned") return { dot: "", label: t("task.archived"), detail: "" };
  if (task.status === "creating") return { dot: "cloning", label: t("task.creating"), detail: "" };
  if (task.runtime?.state === "unknown") return { dot: "", label: t("task.runtimeUnknown"), detail: t("task.runtimeUnknown") };
  if (task.alive) return { dot: task.waiting ? "waiting" : "live", label: t(task.waiting ? "task.waiting" : "task.running"), detail: "" };
  if (task.runtime?.state === "exited") {
    const { exitCode, signal } = task.runtime;
    const abnormal = !!signal || (Number.isInteger(exitCode) && exitCode !== 0);
    let label = t(abnormal ? "task.failedExit" : "task.exited");
    if (signal) label += ` · ${t("task.exitSignal", { signal })}`;
    else if (abnormal) label += ` · ${t("task.exitCode", { code: exitCode })}`;
    return { dot: abnormal ? "error" : "", label, detail: label };
  }
  if (task.status === "error") return { dot: "error", label: t("task.startFailed"), detail: t("task.startFailed") };
  const label = t(task.alive === undefined ? "task.runtimeUnknown" : "task.notRunning");
  return { dot: "", label, detail: label };
}
