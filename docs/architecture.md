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

Public contracts retain their existing versions: `junction.context/1`, optional environment metadata, and `switchyard-tunnel/1`. Directory changes do not alter Context IDs, database schemas, device IDs or local data locations. Local workbench support is negotiated as `local-workspace/1`, so old nodes can still use remote relay.

The merge contains both original Git histories. `git log --all` exposes their commits; `git log --follow -- <file>` tracks moved files. New development happens in Junction; the old Switchyard checkout is retained for rollback/reference and is not the ongoing source of release builds.
