// Shared by ordinary tasks and Context continuations on the selected node.
export function createReferencePicker({ root, catalog: referenceCatalog, supported: referencesSupported = () => true, loadBranches }) {
  const t = key => I18N.t(key);
  let taskReferences = [], referenceSeq = 0;
  function referenceAlias(value, repoId) {
    const slug = String(value || "").toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[._-]+|[._-]+$/g, "")
      .slice(0, 32);
    return slug || `repo-${repoId}`;
  }

  function uniqueReferenceAlias(value, repoId, key = null) {
    const seed = referenceAlias(value, repoId);
    const used = new Set(taskReferences
      .filter(reference => reference.key !== key)
      .map(reference => referenceAlias(reference.alias, reference.repoId)));
    if (!used.has(seed)) return seed;
    for (let n = 2; n < 1000; n++) {
      const suffix = `-${n}`;
      const candidate = seed.slice(0, 32 - suffix.length) + suffix;
      if (!used.has(candidate)) return candidate;
    }
    return `${seed.slice(0, 28)}-ref`;
  }

  function abortReferenceRequests() {
    taskReferences.forEach(reference => reference.controller?.abort());
  }

  function resetTaskReferences() {
    abortReferenceRequests();
    taskReferences = [];
    renderTaskReferences();
  }

  function option(value, label, selected = false) {
    const el = document.createElement("option");
    el.value = String(value);
    el.textContent = String(label);
    el.selected = selected;
    return el;
  }

  function renderTaskReferences() {
    const sec = root(), list = sec?.querySelector(".tm-ref-list"), add = sec?.querySelector(".tm-ref-add"), hint = sec?.querySelector(".hint");
    if (!sec || !list || !add || !hint) return;
    add.onclick = addTaskReference;
    const supported = referencesSupported();
    const repos = referenceCatalog();
    sec.classList.toggle("has-refs", taskReferences.length > 0);
    add.disabled = !supported || !repos.length || taskReferences.length >= 8;
    hint.textContent = !supported
      ? t("task.referencesUnsupported")
      : repos.length ? t("task.referencesHint") : t("task.noReferenceRepos");
    list.replaceChildren();

    for (const reference of taskReferences) {
      const row = document.createElement("div");
      row.className = "tm-ref-row";

      const repoSelect = document.createElement("select");
      repoSelect.setAttribute("aria-label", t("task.referenceRepo"));
      for (const repo of repos) repoSelect.append(option(repo.id, repo.name, Number(repo.id) === reference.repoId));
      repoSelect.addEventListener("change", () => {
        reference.repoId = Number(repoSelect.value);
        const repo = repos.find(candidate => Number(candidate.id) === reference.repoId);
        reference.alias = uniqueReferenceAlias(repo?.name, reference.repoId, reference.key);
        reference.branch = repo?.default_branch || "main";
        reference.branches = [];
        void loadReferenceBranches(reference);
        renderTaskReferences();
      });

      const branchSelect = document.createElement("select");
      branchSelect.setAttribute("aria-label", t("task.referenceBranch"));
      if (reference.loading) {
        branchSelect.append(option("", t("task.referenceLoading"), true));
        branchSelect.disabled = true;
      } else {
        const branches = reference.branches.length ? reference.branches : [reference.branch].filter(Boolean);
        for (const branch of branches) branchSelect.append(option(branch, branch, branch === reference.branch));
        branchSelect.addEventListener("change", () => { reference.branch = branchSelect.value; });
      }

      const alias = document.createElement("input");
      alias.className = "tm-ref-alias";
      alias.value = reference.alias;
      alias.placeholder = t("task.referenceAlias");
      alias.setAttribute("aria-label", t("task.referenceAlias"));
      alias.addEventListener("input", () => {
        reference.alias = alias.value;
      });
      alias.addEventListener("blur", () => {
        reference.alias = uniqueReferenceAlias(alias.value, reference.repoId, reference.key);
        alias.value = reference.alias;
      });

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "tm-ref-remove";
      remove.textContent = "×";
      remove.title = t("task.referenceRemove");
      remove.setAttribute("aria-label", t("task.referenceRemove"));
      remove.addEventListener("click", () => {
        reference.controller?.abort();
        taskReferences = taskReferences.filter(candidate => candidate.key !== reference.key);
        renderTaskReferences();
      });

      row.append(repoSelect, branchSelect, alias, remove);
      list.append(row);
    }
  }

  async function loadReferenceBranches(reference) {
    reference.controller?.abort();
    const controller = reference.controller = new AbortController();
    reference.loading = true;
    renderTaskReferences();
    const repo = referenceCatalog().find(candidate => Number(candidate.id) === reference.repoId);
    try {
      const branches = await loadBranches(reference.repoId, controller.signal);
      if (controller.signal.aborted) return;
      reference.branches = branches;
      reference.branch = branches.includes(reference.branch)
        ? reference.branch
        : (branches.includes(repo?.default_branch) ? repo.default_branch : branches[0] || repo?.default_branch || "");
    } catch (error) {
      if (error.name === "AbortError") return;
      reference.branches = [repo?.default_branch || reference.branch || "main"];
      reference.branch = reference.branches[0];
    } finally {
      if (reference.controller === controller) {
        reference.loading = false;
        renderTaskReferences();
      }
    }
  }

  function addTaskReference() {
    if (!referencesSupported() || taskReferences.length >= 8) return;
    const repos = referenceCatalog();
    const used = new Set(taskReferences.map(reference => reference.repoId));
    const repo = repos.find(candidate => !used.has(Number(candidate.id))) || repos[0];
    if (!repo) return;
    const reference = {
      key: ++referenceSeq,
      repoId: Number(repo.id),
      branch: repo.default_branch || "main",
      branches: [],
      alias: uniqueReferenceAlias(repo.name, repo.id),
      loading: false,
      controller: null,
    };
    taskReferences.push(reference);
    renderTaskReferences();
    void loadReferenceBranches(reference);
  }


  function referencePayload() {
    if (taskReferences.some(reference => reference.loading || !reference.branch || !String(reference.alias).trim())) return null;
    return taskReferences.map(reference => ({
      repo_id: reference.repoId,
      ref: reference.branch,
      alias: reference.alias,
    }));
  }

  return { render: renderTaskReferences, reset: resetTaskReferences, add: addTaskReference, payload: referencePayload, dispose: abortReferenceRequests };
}
