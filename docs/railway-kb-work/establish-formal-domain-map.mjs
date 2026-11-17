import assert from 'node:assert/strict';
import { api, domains, hash, originalDataset, save, tenant } from './run.mjs';

const pipelineID = '0a707ed3e4144548a49bc7ee2cc83e31';
const versionID = '8965e46a33454571a7ac918fbcb5bc7f';
const embedding = 'bge-m3@ollama_local@Ollama';
const checkedAt = new Date().toISOString();
const evidencePath = `05-review/formal-domain-map-${checkedAt.replaceAll(':', '-').replaceAll('.', '-')}.json`;
const before = await api('/datasets?page=1&page_size=100');
assert(Array.isArray(before), 'Expected the complete dataset array');
assert(before.length < 100, 'Dataset list needs pagination before creating targets');
const original = before.find(d => d.id === originalDataset);
assert(original, 'Original dataset must remain accessible');
const version = await api(`/agents/${pipelineID}/versions/${versionID}`);
assert.equal(version.user_canvas_id, pipelineID);
const dsl = typeof version.dsl === 'string' ? JSON.parse(version.dsl) : version.dsl;
const chunker = Object.values(dsl.components).find(c => c.obj?.component_name === 'TitleChunker')?.obj.params;
assert.equal(chunker?.method, 'hierarchy');
assert.equal(chunker.hierarchy, 3);
assert.equal(chunker.chunk_token_cap, 0);
const extractor = Object.values(dsl.components).find(c => c.obj?.component_name === 'Extractor')?.obj.params;
assert.equal(extractor?.summary?.enabled, false);
assert.equal(extractor.questions.top_n, 0);
assert.equal(extractor.metadata.enabled, false);
const snapshot = d => ({
  id: d.id, name: d.name, tenant_id: d.tenant_id, permission: d.permission,
  embedding_model: d.embedding_model, document_count: d.document_count,
  chunk_count: d.chunk_count, pipeline_id: d.pipeline_id,
  pipeline_version_id: d.pipeline_version_id, parser_config: d.parser_config,
});
const evidence = {
  checked_at: checkedAt, tenant_id: tenant,
  purpose: 'Create or reconcile five formal domain targets; document acceptance remains separate.',
  pipeline_id: pipelineID, pipeline_version_id: versionID,
  published_dsl_sha256: hash(JSON.stringify(dsl)), embedding_model: embedding,
  before: before.map(snapshot), domains: {}, document_uploads: 0,
  parse_requests: 0, corpus_accepted: false, retrieval_accepted: false,
};
await save(evidencePath, evidence);
for (const [code, name] of Object.entries(domains)) {
  const matches = before.filter(d => d.name === name);
  assert(matches.length <= 1, `Ambiguous existing formal target ${code}`);
  let dataset = matches[0];
  let action = 'reused';
  if (!dataset) {
    dataset = await api('/datasets', 'POST', {
      name, embedding_model: embedding, language: 'Chinese', permission: 'me',
      pipeline_id: pipelineID, pipeline_version_id: versionID, parse_type: 2,
    });
    action = 'created';
    assert(dataset.id, `Missing returned dataset ID for ${code}`);
  }
  const detail = await api(`/datasets/${dataset.id}`);
  assert.equal(detail.name, name);
  assert.equal(detail.permission, 'me');
  assert.equal(detail.embedding_model, embedding);
  assert.equal(detail.pipeline_id, pipelineID);
  assert.equal(detail.pipeline_version_id, versionID);
  evidence.domains[code] = { action, ...snapshot(detail), acceptance: 'target-ready; corpus-not-imported' };
  await save(evidencePath, evidence);
  console.log(JSON.stringify({ domain: code, id: detail.id, name: detail.name, action }));
}
const after = await api('/datasets?page=1&page_size=100');
for (const item of before) {
  const current = after.find(d => d.id === item.id);
  assert(current, `Existing dataset disappeared: ${item.id}`);
  for (const key of ['name', 'permission', 'document_count', 'chunk_count']) {
    assert.deepEqual(current[key], item[key], `Concurrent change in ${item.id}: ${key}`);
  }
}
evidence.after = after.map(snapshot);
evidence.existing_datasets_unchanged = true;
evidence.completed_at = new Date().toISOString();
await save(evidencePath, evidence);
await save('00-control/formal-domain-map.json', {
  checked_at: evidence.completed_at, evidence_path: evidencePath, tenant_id: tenant,
  pipeline_id: pipelineID, pipeline_version_id: versionID,
  embedding_model: embedding, domains: evidence.domains,
  formal_import_complete: false, retrieval_accepted: false,
});
console.log(JSON.stringify({ evidence_path: evidencePath, formal_targets: Object.keys(evidence.domains).length }));
