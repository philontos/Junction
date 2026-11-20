# Runtime boundaries

The repository is unified; the applications remain independently deployable.

```text
Browser ── loopback ── Workbench / local node ── local Agent, Git, tmux
   │                         │
   │ remote device           │ share / retrieve Context
   ▼                         ▼
Cloud gateway ────────── Junction Context service ── SQLite + raw archives
```

`apps/workbench` owns task execution and the shared web interface. `services/junction/gateway` owns browser accounts, node enrollment and remote relay. The Python service owns Context identity, immutable versions, normalization and storage. Account provisioning connects these two cloud services without sharing browser credentials with nodes.

The Node adapter package depends on structural task/runner interfaces. The Python adapter package owns portable context models and native JSONL parsers; it depends only on Pydantic. The Context service consumes those models and parsers. Neither adapter package depends on workbench databases or cloud services. The small `node-transport` module contains shared HTTP/WebSocket forwarding, protocol types and errors.

The gateway renders the workbench's web assets, but never launches Agents. Existing workbench import paths delegate to the shared modules. This compatibility layer is intentional and contains no duplicated provider implementation.

Public contracts retain their existing versions: `junction.context/1`, optional environment metadata, and `switchyard-tunnel/1`. The monorepo move did not alter Context IDs, database schemas, device IDs or existing data locations. Local workbench support is negotiated as `local-workspace/1`, so old nodes can still use remote relay.

The merge contains both original Git histories. `git log --all` exposes their commits; `git log --follow -- <file>` tracks moved files. New development happens in Junction; the old Switchyard checkout is retained for rollback/reference and is not the ongoing source of release builds.

## Task workspaces and Context lifecycle

The node allocates execution directories; Junction owns shared Context identities and revisions. Private node data and visible working files have separate roots, both independent of release installations:

```text
<node data>/
  mirrors/<repo-id>-<name>.git              shared Git objects
  tasks/<task-id>/                         durable task metadata
    task.json, workspace.json              identity, workspace and reference paths
    context.json                          pinned handoff provenance, when present
~/Junction/workspaces/<node-instance>/
  tasks/<task-id>/                         independent directory task output
  repos/<repo-id>-<name>/<task-id>/         repository task worktree
```

Node configuration may override the workspace root with `workspace_root`; standalone services use `JUNCTION_WORKSPACE_ROOT`. Isolated dev/test profiles retain their own work files under the profile data root. Root changes affect new tasks only. Repository fetch/checkout is bounded; an unavailable remote does not silently turn into a missing-branch error or an outdated tracking-branch checkout. Explicit local branches and pinned Context commits remain valid starting points. Per-repository `core.sshCommand` is honored so local network/identity configuration can be applied without altering global routing or transferring it through Context.

Creation without `cwd` defaults to a managed workspace. `cwd_mode: existing` requires an explicit existing directory; legacy requests with an explicit `cwd` retain that behavior. `GET /api/tasks/options` advertises `managed_workspaces` and the destination node's layout. A new UI must check that capability before sending a managed request to an older node. Once assigned, the absolute path in the task record is authoritative; resume never recomputes it, and upgrades never relocate old tasks.

Sharing snapshots the conversation and environment description, not the working directory. Repeated shares of one node/task identity map to one Context with immutable revisions. Continuation creates a new task with its own directory, session and fixed source revision. With a recorded repository URL, the default `workspace_mode: context` resolves the repository on the executing node, matching SSH and HTTPS identities. Missing repositories are registered through the existing owner-local service, using that device's Git authentication. Concurrent requests do not create duplicate repositories; failures remain retryable. Only network Git URLs may be registered automatically, never historical local paths or remote helpers. A recorded commit must be available or fetched before creating the worktree; there is no fallback to the default branch if that commit is unavailable. Partial records without a commit use the recorded branch, then the repository default, with this limitation shown before starting. Contexts without repository information default to a managed directory; explicit directory/repository choices remain supported.

`/api/tasks/options` advertises `context_repository_setup` so a newer UI cannot accidentally dispatch automatic setup to an older node as a directory task. `/api/junction/continue?stream=1` returns NDJSON preparation stages and a completion receipt; the existing JSON response remains available. Context download and Git preparation have bounded, cancellable operations. A local handoff archive is placed under the task control directory's `.tdsp/context/`; it is separate from the new Agent's native session and must be treated as historical evidence. Republishing a continuation retains `derived_from` and uses the new task's own Context identity.

Directory task output is retained after task metadata deletion; it is never placed under `tasks/<id>` because that directory is disposable control metadata. Repository worktrees keep their existing explicit cleanup flow. Context does not transfer tools, credentials or execution permissions.
