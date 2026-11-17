import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { hash, load, root, save } from './run.mjs';

const at = new Date().toISOString();
const docID = process.argv[2] || 'DOC0027';
assert.ok(['DOC0026', 'DOC0027'].includes(docID), 'Unsupported document');
const date = docID === 'DOC0026' ? '2026-11-17' : '2026-11-16';
const output = `05-review/${docID}-structure-decision-${date}.json`;
const registry = await load('00-control/document-register.json');
const doc = registry.find(item => item.doc_id === docID);
const preflightPath = docID === 'DOC0026'
  ? '05-review/DOC0026-preflight-2026-11-17T05-13-59-313Z/summary.json'
  : '05-review/DOC0027-preflight-2026-11-16T13-45-01-518Z/summary.json';
const preflight = await load(preflightPath);
const embeddingPath = docID === 'DOC0026'
  ? '05-review/DOC0026-embedding-budget-2026-11-17T05-14-18-634Z.json'
  : '05-review/DOC0027-embedding-budget-2026-11-16T13-47-58-003Z.json';
const embedding = await load(embeddingPath);
const officialPath = '05-review/successor-official-2026-11-16T13-32-29-538Z/evidence.json';
const official = await load(officialPath);
const snapshotPath = `05-review/history/${docID}-before-structure-decision-${date}/${docID}-master.md`;
const bytes = relative => readFile(path.resolve(root, relative));
const before = (await bytes(snapshotPath)).toString('utf8');
const after = (await bytes(doc.master_path)).toString('utf8');
assert.equal(hash(before), preflight.bindings.master.sha256);
let previousDecision;
if (process.argv.includes('--rebind-metadata')) {
  const prior = await load(output);
  assert.equal(prior.structure_accepted, true);
  assert.equal(prior.bindings.master.sha256, doc.sha256);
  assert.equal(prior.metadata_only_change.before_sha256, hash(before));
  assert.equal(hash(await bytes(output)), doc.structure_v3.structure_decision.sha256);
  const history = `05-review/history/${docID}-metadata-rebind-${at.replaceAll(/[:.]/g, '-')}`;
  await save(`${history}/structure-decision.json`, prior);
  await save(`${history}/document-register.json`, registry);
  previousDecision = { path: `${history}/structure-decision.json`,
    sha256: hash(await bytes(`${history}/structure-decision.json`)),
    master_sha256: doc.sha256 };
} else {
  assert.equal(doc.sha256, hash(before), 'Registry changed since the snapshot');
}
const business = text => text.slice(text.indexOf('## 印发通知'), text.lastIndexOf('\n## '));
// Compare the business region through the final source table, excluding stage notes.
const body = text => business(text).split(/\n## (?:待核验事项|核验边界与后续验收)/u)[0];
assert.equal(body(after), body(before), 'Business contents or headings changed');
for (const [key, binding] of Object.entries(preflight.bindings)) {
  if (key !== 'master') assert.equal(hash(await bytes(binding.path)), binding.sha256);
}
assert.equal(embedding.expected_sha256, preflight.bindings.expected.sha256);
assert.equal(embedding.candidate_budget_verified, true);
assert.equal(embedding.truncate, false);
assert.ok(preflight.deterministic_checks.embedding_maximum_tokens < embedding.runtime_limit);
assert.equal(preflight.semantic_cache.pass + preflight.semantic_cache.adjudicated_faithful_source,
  doc.structure_v3.knowledge_points);
assert.equal(preflight.semantic_cache.adjudicated_faithful_source, 2);
assert.equal(preflight.candidate_reranker_budget_verified, true);
const source = official.documents.find(item => item.doc_id === doc.doc_id);
assert.equal(source.local_original_sha256, preflight.bindings.original.sha256);
assert.equal(source.source_identity_verified, true);
assert.ok(source.attachments.some(item => item.matches_local_original));
assert.ok(official.joint_notice.article_text.includes('2026年4月1日'));
const visual = await load(preflight.visual_evidence);
const pageCount = docID === 'DOC0026' ? 37 : 32;
assert.equal(visual.full_document_pages_viewed, pageCount);
assert.equal(new Set(visual.pages.map(page => page.page)).size, pageCount);
for (const page of visual.pages) assert.equal(hash(await bytes(page.image_path)), page.image_sha256);
const visualDependencies = [];
if (visual.excerpt_review_path) {
  const excerpt = await load(visual.excerpt_review_path);
  assert.equal(hash(await bytes(excerpt.png_path)), excerpt.png_sha256);
  visualDependencies.push(visual.excerpt_review_path);
}
if (visual.notes_path) {
  assert.equal(hash(await bytes(visual.notes_path)), visual.notes_sha256);
  visualDependencies.push(visual.notes_path);
}
if (visual.reused_bounded_evidence) visualDependencies.push(visual.reused_bounded_evidence);
const dependencies = [preflightPath, embeddingPath, officialPath, preflight.visual_evidence,
  ...visualDependencies, preflight.semantic_cache.path, preflight.semantic_cache.adjudication_path];
const decision = {
  decided_at: at, doc_id: doc.doc_id, decision: 'STRUCTURE_ACCEPTED_FOR_FAITHFUL_SOURCE_TRIAL',
  structure_accepted: true, trial_accepted: false, formal_import: false, retrieval_accepted: false,
  bindings: { ...preflight.bindings, master: { path: doc.master_path, sha256: hash(after) } },
  metadata_only_change: { before_path: snapshotPath, before_sha256: hash(before),
    after_sha256: hash(after), business_region_unchanged: true,
    candidate_expected_file_unchanged: true,
    ...(previousDecision ? { previous_decision: previousDecision } : {}),
    semantic_cache_reused_batches: preflight.semantic_cache.reused_batches, new_semantic_requests: 0 },
  deterministic_checks: { ...preflight.deterministic_checks,
    embedding_model_runtime_limit_verified: embedding.candidate_budget_verified },
  semantic_review: { model_pass: preflight.semantic_cache.pass, faithful_source_adjudications: 2,
    decisions: docID === 'DOC0026'
      ? ['DOC0026-S0034-T03-G167-167', 'DOC0026-K038']
      : ['DOC0027-S0035-T02-G089-089', 'DOC0027-K035'],
    interpretation: 'Blank source cells remain blank/unknown; no compliance conclusion inferred.' },
  visual_review: { pages_viewed: pageCount, evidence: preflight.visual_evidence,
    limitation: visual.scope, excerpt_evidence: visual.excerpt_review_path,
    observations_evidence: visual.notes_path },
  source_version: { ...source, official_page: {
    requested_url: source.official_page.requested_url,
    snapshot_path: source.official_page.snapshot_path,
    snapshot_sha256: source.official_page.snapshot_sha256 },
    scope: official.search_scope, effectiveness_boundary: source.legal_effectiveness },
  budgets: { embedding_runtime_limit: embedding.runtime_limit,
    maximum_prefixed_candidate_tokens: embedding.tokenizer_tokens,
    nontruncating_embedding_evidence: embeddingPath,
    reranker_evidence: preflight.reranker_budget_evidence },
  dependencies: await Promise.all(dependencies.map(async relative => ({
    path: relative, sha256: hash(await bytes(relative)) }))),
  limitation: 'Approval concerns faithful source structure and eligibility for trial, not a permit determination, universal legal currency, actual chunk quality or retrieval acceptance.',
};
await save(output, decision);
doc.sha256 = hash(after);
doc.structure_v3.structure_status = '结构通过；允许忠实原文隔离试切';
doc.structure_v3.structure_decision = { path: output, sha256: hash(await bytes(output)),
  master_sha256: doc.sha256, decided_at: at };
doc.version_verification = source.legal_effectiveness;
doc.exclusion_reason = '结构已通过；真实试切、正式导入及检索验收尚未完成，暂不计入最终有效量。';
await save('00-control/document-register.json', registry);
console.log(JSON.stringify({ doc_id: doc.doc_id, structure_accepted: true,
  evidence_path: output, master_sha256: doc.sha256, business_region_unchanged: true }));
