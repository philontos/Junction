import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'junction-check-'));
try {
  const cloud = 'apps/workbench/server/cloud';
  const files = fs.readdirSync(path.join(root, cloud)).filter(name => name.endsWith('.test.ts')).map(name => cloud + '/' + name);
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files, 'apps/workbench/server/agents/pi.test.ts',
    'apps/workbench/server/fleet/bootstrap.test.ts'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, TASK_DISPATCHER_DATA_DIR: data },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { fs.rmSync(data, { recursive: true, force: true }); }
