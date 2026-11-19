import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist'); fs.mkdirSync(output, { recursive: true });
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'junction-build-'));
const run = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const files = [...new Set(run(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0'))].filter(p => p && fs.existsSync(path.join(root, p)));
const copy = (source, target) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.cpSync(path.join(root, source), target, { verbatimSymlinks: true }); };
const hashes = {};
try {
  const node = path.join(stage, 'node'), context = path.join(stage, 'context'); fs.mkdirSync(node); fs.mkdirSync(context);
  for (const file of files) {
    if (file.startsWith('deploy/cloud/') || ['package.json', 'package-lock.json', 'deploy/postinstall.mjs', 'deploy/node/install.sh'].includes(file) || /^(apps\/workbench|packages\/agent-adapters\/node|packages\/node-transport|services\/junction\/gateway)\//.test(file)) copy(file, path.join(node, file));
    if (file.startsWith('services/junction/') && !file.startsWith('services/junction/gateway/')) copy(file, path.join(context, file.slice('services/junction/'.length)));
    if (file.startsWith('packages/agent-adapters/python/')) copy(file, path.join(context, 'agent-adapters', file.slice('packages/agent-adapters/python/'.length)));
    if (file.startsWith('deploy/junction/')) copy(file, path.join(context, 'deploy', file.slice('deploy/junction/'.length)));
  }
  // Existing installers and systemd units enter through server/. Runtime code
  // resolves to apps/workbench; this compatibility path ships only in releases.
  fs.symlinkSync('apps/workbench/server', path.join(node, 'server'));
  const docker = path.join(context, 'Dockerfile'), compose = path.join(context, 'deploy/compose.yaml');
  fs.writeFileSync(docker, fs.readFileSync(docker, 'utf8').replaceAll('services/junction/', '').replaceAll('packages/agent-adapters/python', 'agent-adapters'));
  fs.writeFileSync(compose, fs.readFileSync(compose, 'utf8').replace('context: ../..', 'context: ..').replace('dockerfile: services/junction/Dockerfile', 'dockerfile: Dockerfile'));
  for (const [name, directory] of [['node', node], ['junction', context]]) {
    const archive = path.join(output, name + '.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', directory, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    hashes[name] = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    fs.writeFileSync(archive + '.sha256', hashes[name] + '\n');
  }
  const manifest = { revision: run(['rev-parse', 'HEAD']), dirty: !!run(['status', '--porcelain']), artifacts: hashes };
  fs.writeFileSync(path.join(output, 'release.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify(manifest, null, 2));
} finally { fs.rmSync(stage, { recursive: true, force: true }); }
