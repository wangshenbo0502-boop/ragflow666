import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('./', import.meta.url));
const load = async p => JSON.parse(await readFile(path.join(root, p), 'utf8'));
const digest = async p => createHash('sha256').update(await readFile(path.join(root, p))).digest('hex');
const verifiedBindings = [];
async function verify(binding) {
  assert.equal(await digest(binding.path), binding.sha256, binding.path);
  verifiedBindings.push({ path: binding.path, sha256: binding.sha256 });
}
const register = await load('00-control/document-register.json');
const ledger = await load('00-control/successor-import-ledger.json');
const q27 = await load('05-review/DOC0027-literal-trial-quality-2026-11-17.json');
const s26 = await load('05-review/DOC0026-structure-decision-2026-11-17.json');
const b27 = await load('05-review/DOC0027-literal-actual-budget-2026-11-17.json');
const initial = await load('05-review/DOC0027-literal-budget-initial-assertion-2026-11-17.json');
const diagnostic = await load('05-review/revision-formal-tests-v5/answer-review.json');
const domainSnapshot = await load('05-review/formal-domain-current-2026-11-17.json');
const cache = await load('05-review/successor-semantic-review/cache-verification.json');
const adjudication = await load('05-review/successor-semantic-adjudication-v2.json');
const rerank = await load('05-review/rerank-authenticated-2026-11-17T04-15-37-737Z.json');
const debug26 = await load('05-review/DOC0026-literal-markdown-debug-2026-11-17T05-28-41-615Z.json');
const tally = (items, key) => items.reduce((out, item) => {
  const value = item[key] ?? '(absent)';
  out[value] = (out[value] || 0) + 1;
  return out;
}, {});

assert.equal(register.length, 28);
assert.equal(q27.quality_accepted, true);
assert.equal(q27.formal_import, false);
assert.equal(q27.retrieval_accepted, false);
assert.equal(q27.final_count_eligible, false);
assert.equal(q27.checks.length, 200);
assert.equal(q27.exported_chunks, 205);
assert.equal(q27.metadata.length, 5);
assert.equal(q27.metadata_exclusion_verified, true);
assert.equal(q27.current_close_read.business_chunks, 16);
assert.equal(q27.actual_after_metadata_exclusion.filter(x => x.available === true).length, 200);
assert.equal(q27.actual_after_metadata_exclusion.filter(x => x.available === false).length, 5);
for (const key of ['review_script', 'master', 'input', 'input_manifest', 'actual', 'structure_decision', 'budget_evidence']) {
  await verify(q27[key]);
}
for (const key of ['original', 'master', 'expected', 'native', 'original_pdf']) await verify(s26.bindings[key]);
const reg27 = register.find(x => x.doc_id === 'DOC0027');
const reg26 = register.find(x => x.doc_id === 'DOC0026');
assert.equal(reg27.status, '试切通过');
assert.equal(reg27.structure_v3.current_trial.document_id, q27.document_id);
assert.equal(reg27.structure_v3.current_trial.evidence_sha256,
  await digest('05-review/DOC0027-literal-trial-quality-2026-11-17.json'));
assert.equal(reg26.sha256, s26.bindings.master.sha256);
assert.equal(reg26.structure_v3.structure_decision.sha256,
  await digest('05-review/DOC0026-structure-decision-2026-11-17.json'));
const currentLedger = ledger.documents.find(x => x.document_id === q27.document_id);
assert.equal(currentLedger.status, 'chunk-quality-accepted');
assert.equal(currentLedger.quality_evidence_sha256, reg27.structure_v3.current_trial.evidence_sha256);
assert.equal(debug26.passed, true);
assert.equal(debug26.full_body_passed, 390);
assert.equal(debug26.chunk_count, 395);

const formal = [];
for (const id of ['DOC0022', 'DOC0023']) {
  const qualityPath = `05-review/${id}-formal-quality-v5.json`;
  const q = await load(qualityPath);
  assert.equal(q.quality_accepted, true);
  assert.equal(q.formal_import, true);
  assert.equal(q.retrieval_accepted, false);
  await verify({ path: q.actual_path, sha256: q.actual_sha256 });
  await verify(q.structure_decision);
  const row = ledger.documents.find(x => x.document_id === q.document_id && x.phase === 'formal');
  assert.equal(row.quality_evidence_sha256, await digest(qualityPath));
  formal.push({ doc_id: id, dataset_id: q.dataset_id, document_id: q.document_id,
    exported_chunks: q.exported_chunks, accepted_business_chunks: q.accepted_business_chunks,
    excluded_metadata: q.metadata_excluded_chunk_ids, quality_accepted: q.quality_accepted,
    formal_import: q.formal_import, retrieval_accepted: q.retrieval_accepted, quality_path: qualityPath });
}
const domains = Object.entries(domainSnapshot.domains).map(([code, entry]) => ({
  code, id: entry.dataset.id, name: entry.dataset.name,
  documents: entry.dataset.document_count, chunks: entry.dataset.chunk_count,
  embedding_model: entry.dataset.embedding_model, permission: entry.dataset.permission,
  pipeline_id: entry.dataset.pipeline_id, pipeline_version_id: entry.dataset.pipeline_version_id,
}));
assert.equal(domains.length, 5);
assert.equal(new Set(domains.map(x => x.id)).size, 5);
for (const d of domains) {
  assert.equal(d.documents, d.code === 'CL' ? 2 : 0);
  assert.equal(d.chunks, d.code === 'CL' ? 65 : 0);
}
const pointCounts = {};
for (const id of ['DOC0025', 'DOC0026', 'DOC0027', 'DOC0028']) {
  const expected = await load(`04-chunks/expected/${id}-successor-v3.json`);
  pointCounts[id] = expected.knowledge_points.length;
}
assert.equal(Object.values(pointCounts).reduce((a, b) => a + b, 0), 1202);
const pending = adjudication.decisions.filter(x => x.decision !== 'FAITHFUL_SOURCE_RETAIN');
assert.equal(pending.length, 6);
const citationStatuses = tally(diagnostic.results.flatMap(x => x.citations), 'claim_support');
assert.deepEqual(citationStatuses, { SUPPORTED: 19, PARTIAL_CAUSAL_CONDITION_OMITTED: 1 });
assert.equal(diagnostic.local_acceptance, false);
assert.equal(diagnostic.final_70_regression, false);
assert.equal(diagnostic.independent_holdout, false);
assert.equal(rerank.direct_rerank.http_status, 200);
assert.equal(rerank.direct_rerank.succeeded, true);
assert.equal(rerank.system_retrieval.succeeded, true);

const references = [
  '05-review/stage-report-2026-11-17.md', 'stage-report-snapshot-2026-11-17.mjs',
  '00-control/progress.md', '00-control/chunk-review.md', '00-control/structure-register.md',
  '00-control/document-register.json', '00-control/successor-import-ledger.json',
  '00-control/baseline.md', '00-control/dataset-map.md', '00-control/formal-domain-map.json',
  '00-control/gap-register.md', 'rebuild-baseline-batch-01.mjs',
  '05-review/formal-domain-current-2026-11-17.json',
  '05-review/DOC0026-structure-decision-2026-11-17.json',
  '05-review/DOC0027-literal-trial-quality-2026-11-17.json',
  '05-review/DOC0027-literal-actual-budget-2026-11-17.json',
  '05-review/DOC0027-literal-budget-initial-assertion-2026-11-17.json',
  '05-review/DOC0026-literal-markdown-debug-2026-11-17T05-28-41-615Z.json',
  '04-chunks/inputs/DOC0026-literal-1e53deb5b6e2/manifest.json',
  '05-review/DOC0027-trial-quality-rejection-2026-11-16.json',
  '05-review/DOC0027-raw-markdown-binding-rejection.json',
  '00-control/raw-markdown-trial-pipeline.json',
  '05-review/successor-semantic-review/cache-verification.json',
  '05-review/successor-semantic-adjudication-v2.json',
  '05-review/generator-validation-2026-11-16T13-47-58-053Z.json',
  '05-review/source-table-alignment-2026-11-16T13-44-40-254Z/evidence.json',
  '05-review/revision-current-official-2026-11-17T04-25-02-988Z/evidence.json',
  '05-review/revision-formal-tests-v5/answer-review.json',
  '05-review/rerank-authenticated-2026-11-17T04-15-37-737Z.json',
  '05-review/rerank-authentication-provenance-2026-11-16.json',
  ...formal.map(x => x.quality_path),
  ...verifiedBindings.map(x => x.path),
  ...Object.keys(pointCounts).map(id => `04-chunks/expected/${id}-successor-v3.json`),
  ...Array.from({ length: 6 }, (_, i) => `04-chunks/expected/DOC${String(i + 1).padStart(4, '0')}-article-audit.json`),
];
const files = [];
for (const p of [...new Set(references)]) files.push({ path: p, sha256: await digest(p) });
const evidence = {
  generated_at: new Date().toISOString(), timezone: 'Asia/Shanghai',
  purpose: 'Independent review checkpoint; local snapshot, not a new remote acceptance run.',
  small_task_complete: true, overall_goal_accepted: false, wiki_in_scope: false,
  network_requests_during_snapshot: 0, new_model_requests_during_snapshot: 0,
  expansion: { frozen_baseline: 6, minimum: 18, preferred: 24, registered: register.length,
    domains: tally(register, 'domain'), statuses: tally(register, 'status'),
    final_count_eligible_true_records: register.filter(x => x.final_count_eligible === true).length,
    accepted_effective_total: null, interpretation: 'Final acceptance count unresolved; not a claim that effective sources are zero.' },
  formal_domains: { checked_at: domainSnapshot.checked_at, snapshot_reused: true, domains },
  structure: { point_counts: pointCounts, total_points: cache.total_points,
    model: cache.model, prompt_sha256: cache.prompt_sha256, rules_sha256: cache.rules_sha256,
    cache_checked_at: cache.checked_at, model_status: { pass: cache.pass, fail: cache.fail, pending: cache.pending },
    reused_batches: cache.reused_batches, faithful_source_decisions: 56,
    pending_source_issues: pending.map(x => ({ id: x.knowledge_point_id, decision: x.decision,
      source_location: x.source_location, rationale: x.rationale })),
    doc0026: { structure_accepted: s26.structure_accepted, trial_accepted: s26.trial_accepted,
      formal_import: s26.formal_import, retrieval_accepted: s26.retrieval_accepted,
      debug_chunks: debug26.chunk_count, debug_business_complete: debug26.full_body_passed,
      debug_is_remote_ingestion: false } },
  doc0027: { reviewed_at: q27.reviewed_at, dataset_id: q27.dataset_id, document_id: q27.document_id,
    pipeline_id: q27.pipeline_id, pipeline_version_id: q27.pipeline_version_id,
    exported: q27.exported_chunks, business: q27.accepted_business_chunks,
    metadata: q27.metadata, current_close_read: q27.current_close_read,
    reused_semantic_batches: q27.reused_semantic_batches, model_judgments: tally(q27.checks, 'semantic_status'),
    final_chunk_decisions: tally(q27.checks, 'decision'), quality_accepted: q27.quality_accepted,
    formal_import: q27.formal_import, retrieval_accepted: q27.retrieval_accepted,
    final_count_eligible: q27.final_count_eligible, limitation: q27.inspection_limit,
    budget: { local_maximum_tokens: b27.maximum_embedding_tokens, runtime: b27.embedding,
      total_tokenize_requests: initial.real_tokenize_requests + b27.real_tokenize_requests,
      total_embedding_requests: initial.real_embedding_requests + b27.real_embedding_requests,
      total_rerank_requests: initial.real_rerank_requests + b27.real_rerank_requests,
      retries: 1, fees: null, total_ingestion_and_agent_cost_measured: false, limitation: b27.limitation } },
  formal_imports: formal,
  retrieval: { checked_at: diagnostic.reviewed_at, scope: diagnostic.scope, counts: diagnostic.counts,
    citation_support: citationStatuses, parameters: diagnostic.parameters,
    answer_context_limit: diagnostic.answer_context_limit, local_acceptance: diagnostic.local_acceptance,
    final_70_regression: diagnostic.final_70_regression, independent_holdout: diagnostic.independent_holdout,
    partial_answers: diagnostic.results.filter(x => x.decision !== 'PASS').map(x => ({
      test_id: x.test_id, decision: x.decision, rationale: x.rationale })), cost: diagnostic.cost },
  reranker: { checked_at: rerank.checked_at, direct_http_status: rerank.direct_rerank.http_status,
    direct_succeeded: rerank.direct_rerank.succeeded, system_retrieval_succeeded: rerank.system_retrieval.succeeded,
    authentication: 'Local HTTP service credential, not a paid provider key; secret omitted.' },
  local_verification: { passed: true, verified_bindings: verifiedBindings,
    checks: ['current file hashes', 'register and ledger bindings', 'five distinct formal dataset IDs and saved counts',
      '1202 expected points', 'DOC0027 200 enabled plus 5 disabled', 'DOC0026 debug-only boundary',
      'formal DOC0022/23 quality evidence', '19 supported plus 1 partial citation', 'six unresolved source issues'] },
  files,
};
const target = '05-review/stage-report-2026-11-17-evidence.json';
await writeFile(path.join(root, target), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ evidence: target, files: files.length, verified_bindings: verifiedBindings.length,
  local_checks_passed: true, overall_goal_accepted: false }));
