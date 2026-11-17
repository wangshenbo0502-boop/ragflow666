import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { hash, load, root, save, table } from './run.mjs';

const documents = await load('00-control/document-register.json');
const baseline = await load('00-control/baseline-curation.json');
const sources = await load('00-control/source-register.json');
const ledger = await load('00-control/revision-v3-ledger.json');
const inputs = await load('00-control/acceptance-v3-context-inputs.json');
const preservation = await load('05-review/preservation-context-v3.json');
const snapshotPath = '00-control/document-register-full.json';
const historyPath = '05-review/history/pre-reconcile-v3-document-register-full.json';
let previousBytes;
try { previousBytes = await readFile(path.join(root, historyPath)); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  previousBytes = await readFile(path.join(root, snapshotPath));
}
const previous = JSON.parse(previousBytes);
const baselineIDs = new Set(baseline.docs.map(doc => doc.doc_id));
const sourceIDs = new Set(sources.map(source => source.source_id));
assert.equal(new Set(documents.map(doc => doc.doc_id)).size, documents.length);
assert.equal(documents.length, inputs.formal.length);
assert.ok(preservation.passed, 'Prior preservation audit did not pass');
const checks = [];
const changes = [];
for (const doc of documents) {
  assert.match(doc.doc_id, /^DOC\d{4}$/u);
  assert.ok(sourceIDs.has(doc.source_id), `${doc.doc_id} unknown source`);
  const master = await readFile(path.join(root, doc.master_path));
  assert.equal(hash(master), doc.sha256, `${doc.doc_id} master hash mismatch`);
  const original = await readFile(path.join(root, doc.original_path));
  const formal = inputs.formal.find(item => item.doc_id === doc.doc_id);
  assert.ok(formal, `${doc.doc_id} missing frozen import mapping`);
  assert.equal(formal.sha256, doc.sha256, `${doc.doc_id} frozen content mismatch`);
  const imported = ledger.documents.findLast(item => item.document_id === formal.document_id
    && item.sha256 === doc.sha256 && item.phase === 'formal');
  assert.ok(imported, `${doc.doc_id} missing matching formal ledger entry`);
  const retained = preservation.documents.find(item => item.document_id === formal.document_id);
  assert.equal(retained?.role, 'current', `${doc.doc_id} not a current audited document`);
  assert.ok(retained.passed, `${doc.doc_id} preservation failure`);
  checks.push({ doc_id: doc.doc_id, source_id: doc.source_id,
    previous_source_ids: doc.previous_source_ids || [],
    master_path: doc.master_path, master_sha256: hash(master),
    original_path: doc.original_path, original_sha256: hash(original),
    dataset_id: inputs.dataset_id, system_document_id: formal.document_id,
    ingestion_status: retained.ingestion_status,
    imported_chunk_count_including_metadata: retained.chunk_count,
    pipeline_version_id: imported.pipeline_version_id,
    final_acceptance_status: '待复核', final_count_eligible: false,
    outstanding: ['版本及效力核验', '附件/语义检查', '检索及回答验收'],
    live_status_rechecked_in_this_script: false,
    live_status_evidence_checked_at: preservation.checked_at });
  const old = [...previous.baseline, ...previous.expanded].find(item =>
    item.doc_id === doc.doc_id || item.source_id === doc.source_id
    || (doc.previous_source_ids || []).includes(item.source_id));
  assert.ok(old, `${doc.doc_id} no historical mapping`);
  const fields = ['doc_id', 'source_id', 'master_path', 'original_path', 'sha256', 'status'];
  const differing = fields.filter(field => old[field] !== doc[field]);
  if (differing.length) changes.push({ doc_id: doc.doc_id,
    differences: Object.fromEntries(differing.map(field => [field,
      { previous: old[field], current: doc[field] }])) });
}
assert.equal(checks.filter(item => baselineIDs.has(item.doc_id)).length, baseline.docs.length);
const current = {
  baseline: documents.filter(doc => baselineIDs.has(doc.doc_id)),
  expanded: documents.filter(doc => !baselineIDs.has(doc.doc_id)),
  count: { baseline: baseline.docs.length, current_candidates: documents.length,
    expansion_candidates: documents.length - baseline.docs.length,
    final_valid_document_count: null },
  counting_note: 'count_as_valid为历史脚本的来源初筛标记，不代表最终有效数；本快照不按该字段计算验收通过量。所有候选的最终计数仍待来源、版本效力、附件、语义及检索验收。',
  validation: checks,
};
const markdown = '# 文档登记表\n\n' +
  '当前24篇为重构候选，不是24篇最终有效现行文献。原始资料、旧版本和重构前完整登记快照保留。文档身份、路径和哈希按document-register.json对账；上传解析状态引用既有真实审计，并非本脚本重新联网核验。历史count_as_valid字段仅作初筛记录，不用于最终验收计数。\n\n' +
  table(['doc_id', '标题', '来源ID', '计数归并ID', '最终计数', '原件路径', '当前主副本路径',
    '主领域', '旧/新增', '原整理状态（沿用）', '本轮资料状态', '系统文档ID', '来源/效力/检索'],
  documents.map(doc => [doc.doc_id, doc.title, doc.source_id, doc.doc_id,
    '待核验，不计入已验收量', doc.original_path, doc.master_path, doc.domain,
    baselineIDs.has(doc.doc_id) ? '基线旧文重构' : '扩充候选', doc.status, '待复核',
    checks.find(item => item.doc_id === doc.doc_id).system_document_id,
    '未通过最终门槛；原初筛状态不作为完成结论']));
const check = process.argv.includes('--check');
if (check) {
  assert.deepEqual(await load(snapshotPath), current, 'Full register is not reconciled');
  assert.equal(await readFile(path.join(root, '00-control/document-register.md'), 'utf8'), markdown);
} else {
  try { await access(path.join(root, historyPath)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await save(historyPath, previousBytes);
  }
  await save(snapshotPath, current);
  await save('00-control/document-register.md', markdown);
  await save('05-review/document-register-reconciliation-v3.json', {
    checked_at: new Date().toISOString(), scope: 'Local identity, hash and register projection checks only',
    current_candidates: documents.length, baseline: baseline.docs.length,
    expansion_candidates: documents.length - baseline.docs.length,
    final_valid_document_count: null, prior_snapshot_sha256: hash(previousBytes),
    preserved_snapshot_path: historyPath, changed_documents: changes,
    checks, originals_and_masters_unchanged: true, remote_mutation: false,
  });
}
console.log(JSON.stringify({ mode: check ? 'check' : 'write', candidates: documents.length,
  baseline: baseline.docs.length, reconciled_documents: changes.length,
  final_valid_document_count: null, originals_and_masters_unchanged: true }));
