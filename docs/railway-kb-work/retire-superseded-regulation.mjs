import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { api, hash, load, originalDataset, root, rows, save } from './run.mjs';

const reportPath = '05-review/DOC0014-retirement-v1.json';
const snapshotRoot = '05-review/history/DOC0014-before-retirement';
const known = new Set(['8f75de8dc53f492abda6be6c6e1b76e0', '964e86066ece4a378ef745846628f22a']);
async function immutable(relative, bytes) {
  const old = await readFile(path.join(root, relative)).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (old) assert.equal(hash(old), hash(bytes), `Snapshot differs: ${relative}`);
  else await save(relative, bytes);
}
async function listDocuments() {
  const all = [];
  for (let page = 1; ; page++) {
    const batch = rows(await api(`/datasets/${originalDataset}/documents?page=${page}&page_size=100`));
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}
async function readChunks(id) {
  const all = [];
  for (let page = 1; ; page++) {
    const batch = rows(await api(`/datasets/${originalDataset}/documents/${id}/chunks?page=${page}&page_size=100`));
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}
const legal = await load('05-review/official-successor-regulations-v1.json');
assert.equal(legal.old_document.doc_id, 'DOC0014');
assert.ok(legal.notice.text.includes('同时废止'));
assert.ok(legal.notice.text.includes('国铁设备监规〔2025〕14号'));
assert.equal(hash(await readFile(path.join(root, legal.notice.original_path))), legal.notice.sha256);
let prior;
try { prior = await load(reportPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const before = await listDocuments();
const targets = before.filter(doc => known.has(doc.id));
assert.equal(targets.length, known.size, 'All historical versions must still exist');
assert.ok(targets.every(doc => doc.name.startsWith('DOC0014_')));
const report = prior || { started_at: new Date().toISOString(), dataset_id: originalDataset,
  doc_id: 'DOC0014', reason_source: 'S0032', effective_until_exclusive: '2026-04-01',
  action: 'Retain every original and chunk; disable retrieval only; no deletion or replacement upload.',
  before_document_ids: before.map(doc => doc.id).sort(), snapshots: [], completed: false };
for (const remote of targets) {
  const bytes = Buffer.from(await (await api(`/datasets/${originalDataset}/documents/${remote.id}`, 'GET', undefined, true)).arrayBuffer());
  const chunks = await readChunks(remote.id);
  assert.equal(chunks.length, Number(remote.chunk_count));
  let frozen = report.snapshots.find(item => item.document_id === remote.id);
  if (!frozen) {
    frozen = { document_id: remote.id, name: remote.name, previous_status: remote.status,
      original_path: `${snapshotRoot}/${remote.id}.md`, metadata_path: `${snapshotRoot}/${remote.id}-metadata.json`,
      chunks_path: `${snapshotRoot}/${remote.id}-chunks.json`, sha256: hash(bytes),
      chunk_count: chunks.length, chunk_bodies: chunks.map(c => ({ id: c.id, sha256: hash(c.content || '') })).sort((a, b) => a.id.localeCompare(b.id)) };
    await immutable(frozen.original_path, bytes);
    await immutable(frozen.metadata_path, Buffer.from(JSON.stringify(remote, null, 2) + '\n'));
    await immutable(frozen.chunks_path, Buffer.from(JSON.stringify(chunks, null, 2) + '\n'));
    report.snapshots.push(frozen);
    await save(reportPath, report);
  }
  assert.equal(hash(bytes), frozen.sha256, 'Original file has changed');
  assert.equal(hash(await readFile(path.join(root, frozen.original_path))), frozen.sha256);
}
const active = targets.filter(doc => String(doc.status) !== '0');
if (active.length) {
  report.status_update_result = await api(`/datasets/${originalDataset}/documents/batch-update-status`, 'POST', {
    doc_ids: active.map(doc => doc.id), status: '0',
  });
  await save(reportPath, report);
}
const after = await listDocuments();
assert.deepEqual(after.map(doc => doc.id).sort(), report.before_document_ids, 'Dataset document inventory changed');
report.verification = [];
for (const frozen of report.snapshots) {
  const remote = after.find(doc => doc.id === frozen.document_id);
  assert.ok(remote);
  assert.equal(String(remote.status), '0');
  const bytes = Buffer.from(await (await api(`/datasets/${originalDataset}/documents/${remote.id}`, 'GET', undefined, true)).arrayBuffer());
  const chunks = await readChunks(remote.id);
  assert.equal(hash(bytes), frozen.sha256);
  assert.equal(chunks.length, frozen.chunk_count);
  assert.deepEqual(chunks.map(c => ({ id: c.id, sha256: hash(c.content || '') })).sort((a, b) => a.id.localeCompare(b.id)), frozen.chunk_bodies);
  assert.ok(chunks.every(c => c.available === false), 'Historical chunks must not be retrievable');
  report.verification.push({ document_id: remote.id, status: remote.status,
    original_downloadable: true, original_sha256_unchanged: true, chunk_ids_and_bodies_unchanged: true,
    retained_chunks: chunks.length, all_chunks_disabled: true });
}
report.checked_at = new Date().toISOString();
report.completed = true;
report.temporary_coverage_gap = 'Four successor regulations remain unaccepted; existing answers must not use DOC0014 as current authority.';
await save(reportPath, report);

const inputsPath = '00-control/acceptance-v3-context-inputs.json';
const answersPath = '00-control/acceptance-v3-context-answers.json';
const inputs = await load(inputsPath);
const answers = await load(answersPath);
const impacted = new Map();
function inspect(value, origin, inheritedID = null) {
  if (!value || typeof value !== 'object') return;
  const id = value.test_id || inheritedID;
  if (id && JSON.stringify(value).includes('DOC0014')) {
    const item = impacted.get(id) || { test_id: id, evidence_expected: false, archived_answer_exposed: false };
    item[origin] = true;
    item.current_acceptance = 'INVALIDATED_PENDING_SUCCESSOR_EVIDENCE_AND_NEW_RUN';
    impacted.set(id, item);
  }
  for (const child of Object.values(value)) if (typeof child === 'object') inspect(child, origin, id);
}
inspect(inputs.questions, 'evidence_expected');
inspect(answers, 'archived_answer_exposed');
const overlay = { checked_at: new Date().toISOString(), scope: 'Legal-validity overlay; original test inputs and archived answers are immutable.',
  reason: 'DOC0014 was repealed on 2026-04-01; archived semantic PASS and retrieval scores are not current legal acceptance.',
  source_id: 'S0032', retired_doc_id: 'DOC0014', successor_doc_ids: ['DOC0025', 'DOC0026', 'DOC0027', 'DOC0028'],
  input_path: inputsPath, input_sha256: hash(await readFile(path.join(root, inputsPath))),
  answers_path: answersPath, answers_sha256: hash(await readFile(path.join(root, answersPath))),
  tests: [...impacted.values()], original_tests_modified: false, original_answers_modified: false };
await save('05-review/DOC0014-test-validity-overlay.json', overlay);
const annexPath = '05-review/DOC0014-annex-review.json';
const annexBytes = await readFile(path.join(root, annexPath));
const annex = JSON.parse(annexBytes);
if (!annex.legal_validity_overlay) await immutable(`${snapshotRoot}/DOC0014-annex-review.json`, annexBytes);
annex.legal_validity_overlay = { checked_at: report.checked_at, status: 'REPEALED_HISTORICAL_ONLY',
  not_current_after: '2026-04-01', source_id: 'S0032',
  note: 'Prior visual and semantic checks remain historical evidence, not current regulatory acceptance.' };
await save(annexPath, annex);
const register = await load('00-control/document-register.json');
Object.assign(register.find(d => d.doc_id === 'DOC0014'), { remote_retrieval_status: '0',
  retirement_evidence: reportPath, status: '不收录', exclusion_reason: '2026-04-01废止；原件及全部远端历史版本保留，检索已停用。',
  legal_status: 'REPEALED_HISTORICAL_ONLY' });
await save('00-control/document-register.json', register);
const note = '\n## DOC0014废止资料检索停用实证\n\n' +
  `核验时间：${report.checked_at}。原库内DOC0014两份文件及100片完整保留；下载哈希与切片ID/正文均未变化，两份状态均为0且100片均不可检索。操作前快照及实证：\`${reportPath}\`。\n\n` +
  `旧测试输入和回答未改写；效力覆盖清单：\`05-review/DOC0014-test-validity-overlay.json\`。受影响题：${overlay.tests.map(t => t.test_id).join('、')}。以前43/58及29/58仅是历史基线，不代表停用后或替代版成绩。四项替代细则未验收入库前存在临时覆盖缺口，不能用旧版作现行依据。\n`;
for (const name of ['progress.md', 'final-acceptance.md', 'import-register.md']) {
  const relative = `00-control/${name}`;
  const text = await readFile(path.join(root, relative), 'utf8');
  if (!text.includes('## DOC0014废止资料检索停用实证')) await save(relative, text + note);
}
console.log(JSON.stringify({ retired_documents: report.verification.length,
  preserved_chunks: report.verification.reduce((n, d) => n + d.retained_chunks, 0),
  impacted_tests: overlay.tests.map(t => t.test_id), completed: true }, null, 2));
