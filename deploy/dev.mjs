import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = path.join(root, '.local/dev');
const workbenchPort = Number(process.env.WORKBENCH_PORT || 3100), contextPort = Number(process.env.JUNCTION_PORT || 8768);
const junction = path.join(root, '.venv/bin/junction');
if (!fs.existsSync(junction)) throw Error('Run npm run setup first.');
for (const port of [workbenchPort, contextPort]) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Use ports between 1024 and 65535.');
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', () => reject(Error(`Port ${port} is occupied; set WORKBENCH_PORT/JUNCTION_PORT to an available port.`))); listener.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => listener.close(resolve));
}
if (workbenchPort === contextPort) throw Error('Workbench and Context service need distinct ports.');
fs.mkdirSync(data, { recursive: true, mode: 0o700 });
const token = path.join(data, 'developer.token');
if (!fs.existsSync(token)) {
  const result = spawnSync(junction, ['user-add', 'developer', '--data-dir', path.join(data, 'context'), '--output-token', token], { stdio: 'inherit' });
  if (result.status !== 0) throw Error('Could not initialize the development account.');
}
const config = path.join(data, 'junction.json');
fs.writeFileSync(config, JSON.stringify({ url: `http://127.0.0.1:${contextPort}`, default_account: 'developer', accounts: [{ id: 'developer', label: 'Developer', token_file: token }] }), { mode: 0o600 });
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return; stopping = true; process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL'); }, 5000).unref();
}
const start = (bin, args, env = {}) => {
  const child = spawn(bin, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } }); children.push(child);
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => { if (!stopping) stop(code || 1); }); return child;
};
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
start(junction, ['serve', '--data-dir', path.join(data, 'context'), '--host', '127.0.0.1', '--port', String(contextPort)]);
let healthy = false;
for (let i = 0; i < 80 && !stopping; i++) {
  try { healthy = (await fetch(`http://127.0.0.1:${contextPort}/healthz`, { signal: AbortSignal.timeout(500) })).ok; } catch {}
  if (healthy) break; await new Promise(resolve => setTimeout(resolve, 100));
}
if (!healthy) { console.error('Context service did not start.'); stop(1); }
else {
  start(process.execPath, ['--import', 'tsx', 'apps/workbench/server/index.ts'], {
    HOST: '127.0.0.1', HOSTS: '127.0.0.1', PORT: String(workbenchPort),
    TASK_DISPATCHER_DATA_DIR: path.join(data, 'workbench'), SWITCHYARD_JUNCTION_CONFIG: config,
  });
  console.log(`\nWorkbench: http://127.0.0.1:${workbenchPort}\nContext: http://127.0.0.1:${contextPort}\nData: ${data}\nCtrl+C stops these services; existing tmux tasks are preserved.\n`);
}
