import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (bin, args) => {
  const result = spawnSync(bin, args, { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw Error(`${bin} failed. Correct the error above and run npm run setup again.`);
};
if (Number(process.versions.node.split('.')[0]) < 22) throw Error('Node.js 22 or newer is required.');
run('npm', ['ci', '--no-audit', '--no-fund']);
const candidates = [process.env.JUNCTION_PYTHON, 'python3.12', 'python3.13', 'python3.11', 'python3'].filter(Boolean);
const python = candidates.find(bin => spawnSync(bin, ['-c', 'import sys; sys.exit(sys.version_info < (3,11))'], { stdio: 'ignore' }).status === 0);
if (!python) throw Error('Python 3.11+ is required. Install it or set JUNCTION_PYTHON, then rerun npm run setup.');
if (!fs.existsSync(path.join(root, '.venv/bin/python'))) run(python, ['-m', 'venv', '.venv']);
run(path.join(root, '.venv/bin/python'), ['-m', 'pip', 'install', '--constraint', 'services/junction/requirements.lock', '-e', 'packages/agent-adapters/python', '-e', 'services/junction[dev]']);
run(path.join(root, '.venv/bin/python'), ['-m', 'pip', 'check']);
console.log('\nReady. npm run dev starts the local workbench and Context service.');
