import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const prebuilds = path.join(path.dirname(require.resolve('node-pty/package.json')), 'prebuilds');
if (fs.existsSync(prebuilds)) for (const dir of fs.readdirSync(prebuilds)) {
  const helper = path.join(prebuilds, dir, 'spawn-helper');
  if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
}
