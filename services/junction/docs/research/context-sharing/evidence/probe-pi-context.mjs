// Usage: node probe-pi-context.mjs SESSION_MANAGER_TS MESSAGES_TS TRANSFORM_TS OUTPUT_JSON
// Pinned original pure functions only; no packages, CLI startup, or model calls.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const [managerPath, messagesPath, transformPath, outputPath] = process.argv.slice(2);
assert.ok(outputPath, 'Four arguments required');
const expected = [
  'df17da0ba0f3519c6b0a057eac1c51f38c041fc33738de2e449f86118aef565e',
  '5397e3c96c9504266e4ee8b6e88d5098b3280ee7dbb0c687b74708c62a06c8d4',
  '1afe70d8ab9ac24fcfc7ee46bf002b24f9557396ffe3c61e44d3e35c692e27f4',
];
const sources = await Promise.all([managerPath, messagesPath, transformPath].map(p => readFile(p, 'utf8')));
sources.forEach((s, i) => assert.equal(createHash('sha256').update(s).digest('hex'), expected[i], 'Pinned source mismatch'));
const asModule = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const strip = source => stripTypeScriptTypes(source, { mode: 'strip' });
const helpersUrl = asModule(strip(sources[1]));
const start = sources[0].indexOf('function buildEntryIndex(');
const end = sources[0].indexOf('/**\n * Compute the default session directory', start);
assert.ok(start >= 0 && end > start);
const projectionUrl = asModule(
  `import { createCustomMessage, createBranchSummaryMessage, createCompactionSummaryMessage } from '${helpersUrl}';\n` +
  strip(sources[0].slice(start, end)));
const { buildContextEntries, buildSessionContext } = await import(projectionUrl);
const { transformMessages } = await import(asModule(strip(sources[2])));

const timestamp = '2026-01-01T00:00:00Z';
const entry = (id, parentId, type, extra) => ({ id, parentId, type, timestamp, ...extra });
const msg = (id, parentId, role, content) => entry(id, parentId, 'message', { message: { role, content, timestamp: 1 } });
const checkpoint = { role: 'system', content: [{ type: 'text', text: 'Synthetic prompt' }], timestamp: 1 };
const raw = [
  msg('old', null, 'user', 'Original task'),
  msg('keep', 'old', 'user', 'Keep this'),
  entry('compact', 'keep', 'compaction', { summary: 'Synthetic summary', firstKeptEntryId: 'keep', tokensBefore: 10, systemMessage: checkpoint }),
  msg('next', 'compact', 'user', 'Next turn'),
  msg('sibling', 'keep', 'user', 'Another branch'),
];
const original = structuredClone(raw);
assert.deepEqual(buildContextEntries(raw, 'next').map(e => e.id), ['compact', 'keep', 'next']);
const active = buildSessionContext(raw, 'next').messages;
assert.deepEqual(active.map(m => m.role), ['system', 'compactionSummary', 'user', 'user']);
assert.equal(active[1].summary, 'Synthetic summary');
assert.deepEqual(buildContextEntries(raw, 'sibling').map(e => e.id), ['old', 'keep', 'sibling']);
assert.deepEqual(raw, original);

const edited = [...raw, entry('edit', 'next', 'context_edit', { targetId: 'keep', replacement: { content: 'Projected replacement' } })];
assert.equal(buildSessionContext(edited, 'edit').messages[2].content, 'Projected replacement');
assert.equal(buildSessionContext(edited, 'sibling').messages[1].content, 'Keep this');
assert.equal(edited.find(e => e.id === 'keep').message.content, 'Keep this');

const sourceModel = { provider: 'openai', api: 'openai-responses', model: 'source-model' };
const targetModel = { provider: 'anthropic', api: 'anthropic-messages', id: 'target-model', input: ['text', 'image'] };
const history = [
  { role: 'assistant', ...sourceModel, stopReason: 'toolUse', timestamp: 1, content: [
    { type: 'thinking', thinking: '', thinkingSignature: 'synthetic-opaque-signature' },
    { type: 'text', text: 'Use a tool', textSignature: 'synthetic-text-signature' },
    { type: 'toolCall', id: 'old|call', name: 'read', arguments: { path: 'fixture' }, thoughtSignature: 'synthetic-tool-signature' },
  ] },
  { role: 'toolResult', toolCallId: 'old|call', toolName: 'read', content: [{ type: 'text', text: 'Result' }], isError: false, timestamp: 2 },
];
const historyBefore = structuredClone(history);
const transformed = transformMessages(history, targetModel, () => 'normalized_call');
assert.deepEqual(transformed[0].content.map(b => b.type), ['text', 'toolCall']);
assert.equal(transformed[0].content[1].id, 'normalized_call');
assert.equal(transformed[1].toolCallId, 'normalized_call');
assert.equal('thoughtSignature' in transformed[0].content[1], false);
assert.equal('textSignature' in transformed[0].content[0], false);
const sameModel = { ...targetModel, ...sourceModel, id: sourceModel.model };
assert.equal(transformMessages(history, sameModel)[0].content[0].type, 'thinking');
assert.deepEqual(history, historyBefore);

const orphan = transformMessages([history[0]], targetModel, () => 'normalized_call');
assert.equal(orphan.length, 2);
assert.equal(orphan[1].toolCallId, 'normalized_call');
assert.equal(orphan[1].isError, true);
assert.equal(orphan[1].content[0].text, 'No result provided');

const result = {
  source_commit: 'babe30a7e6c185346c85859da30b58183e5964f0',
  source_sha256: { session_manager: expected[0], messages: expected[1], transform_messages: expected[2] },
  node: process.version,
  scope: 'Pinned pure source functions after type stripping; synthetic inputs; not CLI or provider integration',
  cases: [
    { name: 'branch_compaction_checkpoint', passed: true, selected_ids: ['compact', 'keep', 'next'], message_roles: active.map(m => m.role), raw_unchanged: true },
    { name: 'branch_relative_context_edit', passed: true, observed: 'Selected branch projection changed; sibling and raw message unchanged' },
    { name: 'cross_provider_content_and_ids', passed: true, observed: 'Foreign thinking/signatures dropped; call/result IDs normalized together; same-model signed thinking retained; source unchanged' },
    { name: 'orphan_tool_call', passed: true, observed: 'Synthetic error result inserted for missing tool result' },
  ],
};
await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ cases: result.cases.length, passed: true }));
