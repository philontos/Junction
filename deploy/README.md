# Build and deployment

Run `npm run setup`, the targeted checks, then `npm run build` from the repository root. `dist/release.json` records the source commit and both archive checksums. Build a clean commit for deployment.

| Artifact | Runs on | Contents |
| --- | --- | --- |
| `node.tar.gz` | Each user device; cloud gateway host | Workbench, node runtime, gateway, Node adapters and npm lockfile |
| `junction.tar.gz` | Cloud host | Context service, Python adapters, requirements lock and deployment files |

The node release keeps a `server` compatibility symlink for existing installers/systemd units. Run `npm ci` at the extracted release root. Do not copy only `apps/workbench`: its adapters and transport are workspace dependencies. The runtime still uses existing per-device data and credentials. New installations use [node/install.sh](node/install.sh), served by the cloud portal.

For a Context release, create its virtualenv, then install **both** local Python projects:

```sh
python3.12 -m venv .venv
.venv/bin/pip install -c requirements.lock ./agent-adapters .
.venv/bin/pip check
```

Cloud services remain independent: gateway on `127.0.0.1:8780`, Context service on `127.0.0.1:8767`, behind the existing HTTPS proxy. The [cloud gateway guide](../apps/workbench/docs/cloud-workspace.md) describes configuration; [Context deployment](../services/junction/docs/deployment.md) describes data, credentials and backups. Those service guides refer to the **extracted release root** unless noted otherwise.

Existing installations keep `/srv/switchyard-cloud`, `/srv/junction` and their systemd service names. Upgrade into new immutable release directories; verify package installation and health, back up data, atomically change `current`, then restart only the relevant service. Preserve the previous directory and installer bundle for rollback. Do not migrate databases or reset device binding simply because the repository moved.

For Docker from this repository: `docker build -f services/junction/Dockerfile .`. Compose configuration is under `deploy/junction`; provide its existing environment file explicitly when invoking it.
