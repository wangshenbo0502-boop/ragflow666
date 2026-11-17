import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { api, hash, load, root, rows, save } from './run.mjs';

const at = new Date().toISOString();
const phase = process.argv[2] || 'trial';
assert.ok(['trial', 'formal'].includes(phase), 'Usage: node review-doc0026-trial.mjs [trial|formal]');
const registry = await load('00-control/document-register.json');
const doc = registry.find(item => item.doc_id === 'DOC0026');
const statusPath = `05-review/DOC0026-${phase}-status.json`;
const status = await load(statusPath);
const record = status.record;
const decision = await load('05-review/DOC0026-structure-decision-2026-11-17.json');
const manifestPath = record.input_manifest_path;
const manifest = await load(manifestPath);
const expected = await load(doc.structure_v3.expected_path);
const actualPath = phase === 'formal'
  ? '04-chunks/actual/DOC0026-successor-formal.json'
  : record.actual_evidence;
const actual = await load(actualPath);

assert.equal(decision.structure_accepted, true);
assert.equal(hash(await readFile(path.join(root, doc.master_path))), doc.sha256);
assert.equal(decision.bindings.master.sha256, doc.sha256);
assert.equal(manifest.master.sha256, doc.sha256);
assert.equal(manifest.input.sha256, record.input_sha256);
assert.equal(manifest.pipeline_version_id, record.pipeline_version_id);
assert.equal(actual.doc_id, doc.doc_id);
assert.equal(actual.dataset_id, record.dataset_id);
assert.equal(actual.document_id, record.document_id);
assert.equal(actual.pipeline_version_id, record.pipeline_version_id);
assert.equal(actual.ingestion_status, 'COMPLETED');
assert.equal(actual.deterministic_passed, true);
assert.equal(actual.exported_count, 395);
assert.equal(actual.expected_points, 390);
assert.equal(expected.knowledge_points.length, 390);

const dataset = await api(`/datasets/${record.dataset_id}`);
assert.equal(dataset.pipeline_id, record.pipeline_id);
assert.equal(dataset.pipeline_version_id, record.pipeline_version_id);

const allChunks = async () => {
  const chunks = [];
  for (let page = 1; ; page++) {
    const next = rows(await api(
      `/datasets/${record.dataset_id}/documents/${record.document_id}/chunks?page=${page}&page_size=100`,
    ));
    chunks.push(...next);
    if (next.length < 100) return chunks;
  }
};
const remote = rows(await api(`/datasets/${record.dataset_id}/documents?page=1&page_size=100`))
  .find(item => item.id === record.document_id);
assert.ok(remote);
assert.equal(remote.ingestion_status, 'COMPLETED');
assert.equal(remote.chunk_count, 395);
assert.equal(remote.pipeline_version_id, record.pipeline_version_id);

let chunks = await allChunks();
assert.equal(chunks.length, 395);
assert.equal(new Set(chunks.map(item => item.id)).size, 395);
const textOf = chunk => chunk.content || chunk.content_with_weight || '';
const normalize = text => text.replaceAll('\\|', '|').replaceAll('<br>', '\n')
  .replace(/\*\*([^*]+)\*\*/gu, '$1').replaceAll('`', '').replace(/\s+/gu, '');

const pointChecks = expected.knowledge_points.map(point => {
  const check = actual.checks.find(item => item.knowledge_point_id === point.knowledge_point_id);
  assert.ok(check?.passed, `${point.knowledge_point_id}: previous deterministic check failed`);
  const matches = chunks.filter(chunk => new RegExp(
    `${point.knowledge_point_id}(?![0-9A-Za-z-])`, 'u',
  ).test(textOf(chunk)));
  assert.equal(matches.length, 1, `${point.knowledge_point_id}: remote ID must be unique`);
  assert.ok(normalize(textOf(matches[0])).includes(normalize(point.text)),
    `${point.knowledge_point_id}: remote text is incomplete`);
  assert.ok(matches[0].available, `${point.knowledge_point_id}: business chunk is unavailable`);
  return { knowledge_point_id: point.knowledge_point_id, chunk_id: matches[0].id,
    source_location: point.source_location, candidate_sha256: hash(point.text),
    remote_text_sha256: hash(textOf(matches[0])) };
});

const pointIDs = new Set(pointChecks.map(item => item.chunk_id));
let metadata = chunks.filter(chunk => !pointIDs.has(chunk.id));
assert.equal(metadata.length, 5);
const metadataHeadings = metadata.map(chunk => /^## (.+)$/mu.exec(textOf(chunk))?.[1]);
assert.deepEqual(metadataHeadings, ['阅读范围', '原文附件目录', '附件5', '核验边界与后续验收', '来源清单']);

const blankPoint = expected.knowledge_points.find(point =>
  point.text.includes('内径百分表') && point.text.includes('〔原表空白〕'));
assert.ok(blankPoint, 'The source-blank equipment row must remain explicitly unknown');
assert.ok(normalize(blankPoint.text).includes('〔原表空白〕'));

const excluded = metadata.filter(chunk => chunk.available);
if (excluded.length) {
  await api(`/datasets/${record.dataset_id}/documents/${record.document_id}/chunks`, 'PATCH', {
    chunk_ids: excluded.map(chunk => chunk.id), available: false,
  });
}
chunks = await allChunks();
metadata = chunks.filter(chunk => !pointIDs.has(chunk.id));
assert.equal(chunks.length, 395);
assert.ok(metadata.every(chunk => !chunk.available));
for (const point of pointChecks) {
  const current = chunks.find(chunk => chunk.id === point.chunk_id);
  assert.ok(current?.available);
  assert.equal(hash(textOf(current)), point.remote_text_sha256);
}

const queries = [
  { id: 'DOC0026-K005', question: '铁路信号设备生产企业申请许可证应提交哪些材料？' },
  { id: 'DOC0026-K016', question: '铁路信号设备生产企业哪些生产条件发生变化需要重新申请许可？' },
  { id: blankPoint.knowledge_point_id, question: '道岔外锁闭装置检验过程的内径百分表，原文规定的设备要求是什么？' },
];
const retrieval = [];
for (const query of queries) {
  const response = await api('/datasets/search', 'POST', {
    dataset_ids: [record.dataset_id], question: query.question,
    page_size: 5, knn_top_k: 32, knn_num_candidates: 100, use_kg: false,
  });
  const top5 = rows(response).slice(0, 5).map((chunk, index) => ({
    rank: index + 1, chunk_id: chunk.id, document_id: chunk.document_id,
    similarity: chunk.similarity, text: textOf(chunk),
  }));
  const target = top5.find(item => item.document_id === record.document_id
    && item.text.includes(query.id));
  assert.ok(target, `${query.id}: relevant trial chunk missing from top 5`);
  if (query.id === blankPoint.knowledge_point_id) {
    assert.ok(normalize(target.text).includes(normalize('〔原表空白〕')));
  }
  retrieval.push({ ...query, top5, target_chunk_id: target.chunk_id,
    decision: query.id === blankPoint.knowledge_point_id
      ? 'RETRIEVED_SOURCE_BLANK; no numeric inference permitted'
      : 'RELEVANT_SOURCE_CHUNK_IN_TOP5' });
}

const checkedAt = new Date().toISOString();
const evidence = {
  checked_at: checkedAt,
  doc_id: doc.doc_id,
  phase,
  dataset_id: record.dataset_id,
  document_id: record.document_id,
  bindings: {
    original: { path: doc.original_path, sha256: decision.bindings.original.sha256 },
    master: { path: doc.master_path, sha256: doc.sha256 },
    expected: { path: doc.structure_v3.expected_path, sha256: decision.bindings.expected.sha256 },
    input_manifest: { path: manifestPath, sha256: hash(await readFile(path.join(root, manifestPath))) },
    actual: { path: actualPath, sha256: hash(await readFile(path.join(root, actualPath))) },
    pipeline_id: record.pipeline_id,
    pipeline_version_id: record.pipeline_version_id,
  },
  ingestion_status: remote.ingestion_status,
  exported_chunks: chunks.length,
  expected_business_points: expected.knowledge_points.length,
  complete_business_points: pointChecks.length,
  point_checks: pointChecks,
  nonbusiness_chunks: metadata.map(chunk => ({
    chunk_id: chunk.id, heading: /^## (.+)$/mu.exec(textOf(chunk))?.[1],
    available: chunk.available, text_sha256: hash(textOf(chunk)),
  })),
  table_blank_preservation: {
    knowledge_point_id: blankPoint.knowledge_point_id,
    source_location: blankPoint.source_location,
    source_markers: ['内径百分表', '〔原表空白〕'],
    interpretation: 'The original leaves the equipment requirement blank. Do not infer a value, applicability, or compliance.',
  },
  retrieval,
  quality_accepted: true,
  formal_import: phase === 'formal',
  retrieval_accepted: false,
  scope: phase === 'formal'
    ? 'Formal XH dataset chunk fidelity and three live retrieval diagnostics. This is not final document acceptance.'
    : 'Current isolated trial chunk fidelity and three live retrieval diagnostics. This is not formal import or final document acceptance.',
  remote_mutations: { uploads: 0, reparses: 0, metadata_chunks_disabled: excluded.map(item => item.id) },
  new_semantic_requests: 0,
};
const evidencePath = `05-review/DOC0026-${phase}-quality-2026-11-17.json`;
await save(evidencePath, evidence);

const ledger = await load('00-control/successor-import-ledger.json');
const ledgerRecord = ledger.documents.find(item => item.document_id === record.document_id);
assert.ok(ledgerRecord);
if (phase === 'trial') {
  ledgerRecord.status = 'chunk-quality-accepted';
  ledgerRecord.quality_evidence = evidencePath;
  ledgerRecord.quality_evidence_sha256 = hash(await readFile(path.join(root, evidencePath)));
  ledgerRecord.reviewed_at = checkedAt;
} else {
  ledgerRecord.formal_status = 'chunk-quality-accepted';
  ledgerRecord.formal_quality_evidence = evidencePath;
  ledgerRecord.formal_quality_evidence_sha256 = hash(await readFile(path.join(root, evidencePath)));
  ledgerRecord.formal_reviewed_at = checkedAt;
}
await save('00-control/successor-import-ledger.json', ledger);

if (phase === 'trial') {
  doc.status = '隔离试切通过，待正式导入';
  doc.structure_v3.trial_status = '当前隔离试切通过：390个业务点完整，5个非业务片已停用';
  doc.structure_v3.trial_quality_evidence = {
    path: evidencePath, sha256: ledgerRecord.quality_evidence_sha256,
    dataset_id: record.dataset_id, document_id: record.document_id,
    reviewed_at: checkedAt,
  };
} else {
  doc.status = '正式切片质量通过，待检索验收';
  doc.structure_v3.formal_import_status = '正式库切片质量通过；检索/引用/无证据回答待验收';
  doc.structure_v3.formal_quality_evidence = {
    path: evidencePath, sha256: ledgerRecord.formal_quality_evidence_sha256,
    dataset_id: record.dataset_id, document_id: record.document_id,
    reviewed_at: checkedAt,
  };
  doc.formal_import = {
    dataset_id: record.dataset_id, document_id: record.document_id,
    evidence_path: evidencePath, evidence_sha256: ledgerRecord.formal_quality_evidence_sha256,
    chunks: chunks.length, business_chunks: pointChecks.length, excluded_metadata_chunks: metadata.length,
  };
}
doc.final_count_eligible = false;
doc.exclusion_reason = phase === 'formal'
  ? '正式切片质量通过；文档级检索、引用及无证据回答验收未完成。'
  : '隔离试切通过；正式导入及正式库检索、引用、无证据回答验收未完成。';
await save('00-control/document-register.json', registry);

console.log(JSON.stringify({
  doc_id: doc.doc_id, phase, quality_accepted: true,
  business_chunks: pointChecks.length, nonbusiness_chunks: metadata.length,
  live_retrievals: retrieval.map(item => ({
    id: item.id, target_chunk_id: item.target_chunk_id, decision: item.decision,
  })),
  evidence: evidencePath,
}, null, 2));
