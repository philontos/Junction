// Reproduce the six minimal parser observations without a model call or real session.
// Requires Node.js 24 and a clean checkout of the pinned upstream revision.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const revision = '470b9242d8c5eb5a35b6b330405b8edd52756a06';
const repository = process.argv[2];
const outputPath = process.argv[3];
if (!repository || !outputPath) {
  throw new Error('Usage: node probe-asp.mjs <pinned-asp-checkout> <new-output.json>');
}
const sourceFiles = ['tools.ts', 'normalize/claude.ts', 'normalize/codex.ts'];
const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
assert.equal(git('rev-parse', 'HEAD'), revision, 'Unexpected upstream revision');
git('diff', '--exit-code', 'HEAD', '--', ...sourceFiles.map(file => `src/${file}`));

const expectedPath = fileURLToPath(new URL('./asp-probes.json', import.meta.url));
assert.notEqual(path.resolve(outputPath), expectedPath, 'Do not overwrite the recorded evidence');
const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'context-asp-probe-'));
const sourceHashes = {};

try {
  fs.writeFileSync(path.join(temporaryDirectory, 'package.json'), '{"type":"module"}\n');
  for (const file of sourceFiles) {
    const source = fs.readFileSync(path.join(repository, 'src', file), 'utf8');
    sourceHashes[`src/${file}`] = createHash('sha256').update(source).digest('hex');
    const target = path.join(temporaryDirectory, file.replace(/\.ts$/, '.js'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, stripTypeScriptTypes(source));
  }
  const { normalizeClaude } = await import(pathToFileURL(path.join(temporaryDirectory, 'normalize/claude.js')));
  const { normalizeCodex } = await import(pathToFileURL(path.join(temporaryDirectory, 'normalize/codex.js')));
  const actual = expected.map(testCase => {
    const normalize = testCase.name.startsWith('claude_') ? normalizeClaude : normalizeCodex;
    const lines = testCase.input.map(record => JSON.stringify(record));
    // JSON round-trip reflects the public serialized result, omitting undefined fields.
    const output = JSON.parse(JSON.stringify(normalize(lines)));
    return { name: testCase.name, input: testCase.input, output };
  });
  fs.writeFileSync(outputPath, `${JSON.stringify(actual, null, 2)}\n`, { flag: 'wx' });
  assert.deepEqual(actual, expected, 'The observed normalizer outputs changed');
  const metadata = {
    repository: 'https://github.com/kevin-dp/agent-session-protocol',
    revision,
    node_version: process.version,
    source_sha256: sourceHashes,
    fixture_sha256: createHash('sha256').update(fs.readFileSync(expectedPath)).digest('hex'),
    cases: actual.map(item => ({ name: item.name, output_count: item.output.length })),
    result: 'Recorded outputs reproduced; not an end-to-end native resume test',
  };
  fs.writeFileSync(`${outputPath}.meta.json`, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify(metadata, null, 2));
} finally {
  // Only remove the temporary directory created by this invocation.
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
