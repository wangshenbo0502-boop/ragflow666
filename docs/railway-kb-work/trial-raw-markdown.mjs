import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { api, hash, load, root, rows, save } from './run.mjs';

const command = process.argv[2] || 'debug';
assert.ok(['debug', 'publish', 'reparse'].includes(command));
const recordPath = '00-control/raw-markdown-trial-pipeline.json';
const sourcePath = '05-review/current-title-pipeline-readback.json';
const base = await load(sourcePath);
const registry = await load('00-control/document-register.json');
const doc = registry.find(item => item.doc_id === 'DOC0027');
const ledger = await load('00-control/successor-import-ledger.json');
const trial = ledger.documents.find(item => item.doc_id === doc.doc_id && item.phase === 'trial');
assert.equal(hash(await readFile(path.join(root, doc.master_path))), doc.sha256);
const expected = await load(doc.structure_v3.expected_path);
const ids = {
  constant: 'StringTransform:RawMarkdownType',
  aggregate: 'VariableAggregator:RawMarkdownFile',
  parser: 'Parser:HipSignsRhyme',
  title: 'TitleChunker:SparklySchoolsTravel',
};
let record = await load(recordPath).catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return null;
});
if (!record) {
  const dsl = structuredClone(base.dsl);
  const constant = { method: 'merge', script: 'txt', delimiters: ['\n'] };
  const fields = ['doc_id', 'name', 'bucket', 'path', 'file', 'binary'];
  const aggregate = { groups: [
    { group_name: 'file_type', variables: [{ value: `${ids.constant}@result` }] },
    ...fields.map(field => ({ group_name: field, variables: [{ value: `File@${field}` }] })),
  ] };
  dsl.components.File.downstream = [ids.constant];
  dsl.components[ids.parser].upstream = [ids.aggregate];
  dsl.components[ids.constant] = { obj: { component_name: 'StringTransform', params: constant },
    upstream: ['File'], downstream: [ids.aggregate] };
  dsl.components[ids.aggregate] = { obj: { component_name: 'VariableAggregator', params: aggregate },
    upstream: [ids.constant], downstream: [ids.parser] };
  const sequence = ['File', ids.constant, ids.aggregate, ids.parser, ids.title,
    'Extractor:AutoExtractDefault', 'Tokenizer:GreatCarsWash'];
  dsl.graph.edges = sequence.slice(1).map((target, index) => ({
    id: `${sequence[index]}-${target}`, source: sequence[index], target,
    sourceHandle: 'start', targetHandle: 'end',
  }));
  dsl.graph.nodes.push(
    { id: ids.constant, type: 'stringTransformNode',
      data: { label: 'StringTransform', name: 'StringTransform', form: constant },
      position: { x: 350, y: 200 } },
    { id: ids.aggregate, type: 'variableAggregatorNode',
      data: { label: 'VariableAggregator', name: 'VariableAggregator', form: aggregate },
      position: { x: 650, y: 200 } },
  );
  for (const [index, id] of sequence.entries()) {
    dsl.graph.nodes.find(node => node.id === id).position = { x: 50 + index * 300, y: 200 };
  }
  const created = await api('/agents', 'POST', {
    title: '铁路知识库-Markdown原文保真隔离试切',
    description: 'Explicit text parser routing for structured Markdown; preserve tables and literal characters before title chunking.',
    permission: 'me', canvas_category: 'dataflow_canvas', dsl,
  });
  assert.ok(created.id);
  record = { created_at: new Date().toISOString(), pipeline_id: created.id, ids,
    source_pipeline_id: base.id, source_snapshot: sourcePath,
    source_snapshot_sha256: hash(await readFile(path.join(root, sourcePath))),
    purpose: 'Isolated trial only; no shared dataset or pipeline change.', status: 'draft' };
  await save(recordPath, record);
}
const current = await api(`/agents/${record.pipeline_id}`);
await save('05-review/raw-markdown-trial-pipeline-readback.json', current);
const at = new Date().toISOString();
if (command === 'debug') {
  const evidencePath = `05-review/DOC0027-raw-markdown-debug-${at.replaceAll(/[:.]/g, '-')}.json`;
  const evidence = { checked_at: at, doc_id: doc.doc_id, master_sha256: doc.sha256,
    document_id: trial.document_id, pipeline_id: record.pipeline_id,
    scope: 'Real component debug against existing stored Markdown, without embedding or ingestion.',
    new_model_requests: 0, formal_import: false, retrieval_accepted: false };
  try {
    const debug = (id, inputs) => api(`/agents/${record.pipeline_id}/components/${id}/debug`,
      'POST', { params: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, { value }])) });
    const constant = await debug(ids.constant, {});
    assert.equal(constant.result, 'txt');
    const aggregate = await debug(ids.aggregate, {
      [`${ids.constant}@result`]: constant.result,
      'File@doc_id': trial.document_id, 'File@name': trial.filename,
    });
    assert.equal(aggregate.file_type, 'txt');
    assert.equal(aggregate.doc_id, trial.document_id);
    const parsed = await debug(ids.parser, aggregate);
    evidence.constant = constant;
    evidence.aggregate = aggregate;
    evidence.parser = parsed;
    assert.equal(parsed.file_type, 'txt');
    const chunked = await debug(ids.title, parsed);
    evidence.chunker = chunked;
    const textOf = chunk => chunk.text || chunk.content || chunk.content_with_weight || '';
    const normalize = text => text.replace(/\s+/gu, '');
    const chunks = chunked.chunks || [];
    evidence.checks = expected.knowledge_points.map(point => {
      const pattern = new RegExp(`${point.knowledge_point_id}(?![0-9A-Za-z-])`, 'u');
      const matches = chunks.filter(chunk => pattern.test(textOf(chunk)));
      return { knowledge_point_id: point.knowledge_point_id,
        matching_chunks: matches.length,
        full_body_matches: matches.filter(chunk => normalize(textOf(chunk)).includes(normalize(point.text))).length };
    });
    evidence.chunk_count = chunks.length;
    evidence.full_body_passed = evidence.checks.filter(check =>
      check.matching_chunks === 1 && check.full_body_matches === 1).length;
    evidence.literal_preserved = chunks.some(chunk => textOf(chunk).includes('TXTX####—*****'));
    evidence.passed = evidence.full_body_passed === expected.knowledge_points.length && evidence.literal_preserved;
    await save(evidencePath, evidence);
    record.debug_evidence = evidencePath;
    record.debug_passed = evidence.passed;
    await save(recordPath, record);
    console.log(JSON.stringify({ evidence: evidencePath, chunk_count: chunks.length,
      full_body_passed: evidence.full_body_passed, expected_points: expected.knowledge_points.length,
      literal_preserved: evidence.literal_preserved, passed: evidence.passed,
      sample_chunk: chunks[0], failed: evidence.checks.filter(check =>
        check.matching_chunks !== 1 || check.full_body_matches !== 1).slice(0, 5) }));
    if (!evidence.passed) process.exitCode = 1;
  } catch (error) {
    evidence.error = error.message;
    evidence.passed = false;
    await save(evidencePath, evidence);
    record.debug_evidence = evidencePath;
    record.debug_passed = false;
    await save(recordPath, record);
    throw error;
  }
} else if (command === 'publish') {
  assert.equal(record.debug_passed, true, 'Passing component debug is required before publishing the isolated trial.');
  if (!record.pipeline_version_id) {
    const published = await api(`/agents/${record.pipeline_id}/publish`, 'POST', {
      title: '原文保真隔离试切-v1', description: 'Validated text routing followed by unchanged H1/H2/H3 hierarchy.',
      dsl: current.dsl,
    });
    assert.ok(published.id);
    record.pipeline_version_id = published.id;
    record.status = 'published-for-isolated-trial';
    record.published_at = at;
    await save(recordPath, record);
    await save('05-review/raw-markdown-trial-published-version.json', published);
  }
  console.log(JSON.stringify(record));
} else {
  assert.equal(record.debug_passed, true);
  assert.ok(record.pipeline_version_id);
  let next = ledger.documents.find(item => item.document_id === trial.document_id
    && item.pipeline_version_id === record.pipeline_version_id);
  if (!next) {
    assert.equal(trial.status, 'chunk-quality-rejected');
    const rejection = await load(trial.quality_evidence);
    assert.ok(rejection.bindings.actual.snapshot_path, 'Historical actual chunks must be preserved.');
    const original = Buffer.from(await (await api(
      `/datasets/${trial.dataset_id}/documents/${trial.document_id}`, 'GET', undefined, true)).arrayBuffer());
    assert.equal(hash(original), doc.sha256);
    next = { doc_id: doc.doc_id, source_id: doc.source_id, domain: doc.domain,
      phase: 'trial', dataset_id: trial.dataset_id, document_id: trial.document_id,
      filename: trial.filename, sha256: doc.sha256,
      pipeline_id: record.pipeline_id, pipeline_version_id: record.pipeline_version_id,
      structure_evidence: trial.structure_evidence, status: 'pipeline-binding-intent',
      reused_existing_upload: true, prior_quality_evidence: trial.quality_evidence,
      configuration_debug_evidence: record.debug_evidence, created_at: at };
    ledger.documents.push(next);
    await save('00-control/successor-import-ledger.json', ledger);
    try {
      await api(`/datasets/${trial.dataset_id}/documents/${trial.document_id}`, 'PATCH', {
        parse_type: 2, pipeline_id: record.pipeline_id, pipeline_version_id: record.pipeline_version_id,
      });
    } catch (error) {
      next.status = 'pipeline-binding-rejected';
      next.error = error.message;
      await save('00-control/successor-import-ledger.json', ledger);
      await save('05-review/DOC0027-raw-markdown-binding-rejection.json', {
        checked_at: new Date().toISOString(), record: next, parse_requested: false,
        formal_import: false, retrieval_accepted: false,
      });
      throw error;
    }
    next.status = 'parse-request-intent';
    await save('00-control/successor-import-ledger.json', ledger);
    await api(`/datasets/${trial.dataset_id}/documents/parse`, 'POST', { document_ids: [trial.document_id] });
    next.status = 'parse-requested';
    next.requested_at = new Date().toISOString();
    await save('00-control/successor-import-ledger.json', ledger);
  }
  const remote = rows(await api(`/datasets/${trial.dataset_id}/documents?page=1&page_size=100`))
    .find(item => item.id === trial.document_id);
  await save('05-review/DOC0027-raw-markdown-reparse-status.json', { checked_at: at, record: next, remote });
  console.log(JSON.stringify({ record: next, ingestion_status: remote?.ingestion_status,
    chunk_count: remote?.chunk_count, progress: remote?.progress, message: remote?.progress_msg }));
}
