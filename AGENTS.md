# Working in Junction

- Start from the root README. One checkout contains the workbench, local node, cloud gateway, Context service and adapters.
- Keep execution on the selected device. Context persistence and identity belong to the cloud service. Shared Context never grants execution permissions.
- Native JSONL is immutable evidence; normalized context is a versioned projection. Keep provenance and report missing information rather than inventing it.
- Add provider-specific behavior under `packages/agent-adapters`; neither adapter runtime may import application databases or cloud services.
- Run targeted tests and `npm run typecheck` for the modules changed. Do not run the complete historical workbench test suite on a user's active workstation: some integration tests manage real tmux sessions.
- Never run `tmux kill-server`, stop unrelated sessions, touch real private logs in tests, or publish credentials/state. Use temporary data and fake runners, or explicitly owned temporary sessions.
- `npm run dev` uses isolated `.local/dev` data. Do not repoint it to production databases.
- `npm run build` produces separate compatibility-preserving release bundles; deploy from these bundles, not a partial copy of a workspace directory.
- Keep cloud/node upgrades reversible and preserve user tasks, account IDs, device IDs and data paths.
