import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { api, hash, load, root, rows, save } from './run.mjs';
import { Tokenizer } from './06-tools/node_modules/@huggingface/tokenizers/dist/tokenizers.mjs';

const [command, docID = 'DOC0027', phase = 'trial', pipelineOverride, inputManifestPath] = process.argv.slice(2);
assert.ok(['upload', 'verify'].includes(command));
assert.ok(['trial', 'formal'].includes(phase));
const at = new Date().toISOString();
const registry = await load('00-control/document-register.json');
const doc = registry.find(item => item.doc_id === docID);
const structure = doc?.revision_v5 || doc?.structure_v3;
assert.ok(structure?.structure_decision);
const decisionPath = structure.structure_decision.path;
const decision = await load(decisionPath);
const masterBytes = await readFile(path.join(root, doc.master_path));
assert.equal(hash(masterBytes), doc.sha256);
assert.equal(doc.sha256, decision.bindings.master.sha256);
assert.equal(decision.structure_accepted, true);
const expected = await load(structure.expected_path);
const points = expected.knowledge_points || expected.points;
assert.ok(Array.isArray(points) && points.length > 0);
assert.equal(hash(await readFile(path.join(root, structure.expected_path))),
  decision.bindings.expected.sha256);
let bytes = masterBytes;
let inputManifest;
if (inputManifestPath) {
  inputManifest = await load(inputManifestPath);
  assert.equal(inputManifest.doc_id, docID);
  assert.equal(inputManifest.master.sha256, doc.sha256);
  assert.equal(inputManifest.expected.sha256, decision.bindings.expected.sha256);
  assert.equal(inputManifest.reversible_exact_bytes, true);
  assert.equal(inputManifest.headings_unchanged, true);
  assert.equal(inputManifest.debug_evidence.passed, true);
  const debugBytes = await readFile(path.join(root, inputManifest.debug_evidence.path));
  assert.equal(hash(debugBytes), inputManifest.debug_evidence.sha256);
  assert.equal(JSON.parse(debugBytes).passed, true);
  assert.equal(hash(await readFile(path.join(root, decisionPath))), inputManifest.structure_decision.sha256);
  bytes = await readFile(path.join(root, inputManifest.input.path));
  assert.equal(hash(bytes), inputManifest.input.sha256);
}
const inputHash = hash(bytes);
const basePipeline = await load('00-control/domain-pipeline.json');
const pipeline = pipelineOverride && pipelineOverride !== '-'
  ? { ...basePipeline, ...await load(pipelineOverride), trials: basePipeline.trials }
  : basePipeline;
if (inputManifest) {
  assert.equal(inputManifest.pipeline_id, pipeline.pipeline_id);
  assert.equal(inputManifest.pipeline_version_id, pipeline.pipeline_version_id);
}
const mapping = await load('00-control/formal-domain-map.json');
const datasetID = phase === 'trial' ? pipeline.trials[doc.domain].dataset_id : mapping.domains[doc.domain].id;
const ledgerPath = '00-control/successor-import-ledger.json';
const ledger = await load(ledgerPath).catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return { created_at: at, documents: [] };
});
if (phase === 'formal') {
  const trial = ledger.documents.find(item => item.doc_id === docID && item.sha256 === doc.sha256
    && (item.input_sha256 || item.sha256) === inputHash
    && item.phase === 'trial' && item.status === 'chunk-quality-accepted');
  assert.ok(trial, 'Current trial quality gate missing');
}
async function allDocuments() {
  const result = [];
  for (let page = 1; ; page++) {
    const found = rows(await api(`/datasets/${datasetID}/documents?page=${page}&page_size=100`));
    result.push(...found);
    if (found.length < 100) return result;
  }
}
const dataset = await api(`/datasets/${datasetID}`);
assert.equal(dataset.pipeline_id, basePipeline.pipeline_id);
assert.equal(dataset.pipeline_version_id, basePipeline.pipeline_version_id);
const documents = await allDocuments();
let record = ledger.documents.find(item => item.doc_id === docID && item.sha256 === doc.sha256
  && (item.input_sha256 || item.sha256) === inputHash
  && item.dataset_id === datasetID && item.pipeline_version_id === pipeline.pipeline_version_id);
const filename = `${path.basename(doc.master_path, '.md')}_${inputManifest ? '保真入库副本' : '结构通过'}_${inputHash.slice(0, 12)}.md`;
if (command === 'upload') {
  if (!record) {
    const found = documents.filter(item => item.name === filename);
    assert.ok(found.length <= 1, 'Duplicate remote filename');
    let remote = found[0];
    if (!remote) {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: 'text/markdown' }), filename);
      remote = rows(await api(`/datasets/${datasetID}/documents`, 'POST', form))
        .find(item => item.name === filename);
    }
    assert.ok(remote?.id, 'Upload ID missing');
    record = { doc_id: docID, source_id: doc.source_id, domain: doc.domain, phase,
      dataset_id: datasetID, document_id: remote.id, filename, sha256: doc.sha256,
      input_sha256: inputHash,
      ...(inputManifestPath ? { input_manifest_path: inputManifestPath,
        input_manifest_sha256: hash(await readFile(path.join(root, inputManifestPath))) } : {}),
      pipeline_id: pipeline.pipeline_id, pipeline_version_id: pipeline.pipeline_version_id,
      structure_evidence: decisionPath, status: 'uploaded', uploaded_at: at };
    ledger.documents.push(record);
    await save(ledgerPath, ledger);
  }
  const downloaded = Buffer.from(await (await api(
    `/datasets/${datasetID}/documents/${record.document_id}`, 'GET', undefined, true)).arrayBuffer());
  assert.equal(hash(downloaded), inputHash, 'Remote original mismatch');
  if (record.status === 'uploaded') {
    await api(`/datasets/${datasetID}/documents/${record.document_id}`, 'PATCH', {
      parse_type: 2, pipeline_id: pipeline.pipeline_id,
      pipeline_version_id: pipeline.pipeline_version_id });
    const remote = (await allDocuments()).find(item => item.id === record.document_id);
    if (remote.ingestion_status === 'COMPLETED') {
      record.status = 'parse-completed-awaiting-review';
    } else if (!['RUNNING', 'PENDING', 'QUEUED'].includes(remote.ingestion_status)) {
      // Save intent before the remote call so an interrupted call is never blindly repeated.
      record.status = 'parse-request-intent';
      await save(ledgerPath, ledger);
      await api(`/datasets/${datasetID}/documents/parse`, 'POST', { document_ids: [record.document_id] });
      record.status = 'parse-requested';
    } else {
      record.status = 'parse-requested';
    }
    await save(ledgerPath, ledger);
  }
  console.log(JSON.stringify(record));
} else {
  assert.ok(record, 'No upload ledger');
  const remote = documents.find(item => item.id === record.document_id);
  assert.ok(remote);
  await save(`05-review/${docID}-${phase}-status.json`, { checked_at: at, record, remote, dataset });
  if (remote.ingestion_status !== 'COMPLETED') {
    console.log(JSON.stringify({ doc_id: docID, phase, status: remote.ingestion_status,
      progress: remote.progress, message: remote.progress_msg }));
    if (/FAIL|ERROR|CANCEL/u.test(remote.ingestion_status || '')) process.exitCode = 1;
  } else {
    assert.equal(remote.pipeline_id, pipeline.pipeline_id);
    assert.equal(remote.pipeline_version_id, pipeline.pipeline_version_id);
    const chunks = [];
    for (let page = 1; ; page++) {
      const next = rows(await api(`/datasets/${datasetID}/documents/${record.document_id}/chunks?page=${page}&page_size=100`));
      chunks.push(...next);
      if (next.length < 100) break;
    }
    assert.equal(new Set(chunks.map(item => item.id)).size, chunks.length);
    assert.equal(chunks.length, Number(remote.chunk_count));
    const textOf = chunk => chunk.content || chunk.content_with_weight || '';
    const normalize = text => text.replaceAll('\\|', '|').replaceAll('<br>', '\n')
      .replace(/\*\*([^*]+)\*\*/gu, '$1').replaceAll('`', '').replace(/\s+/gu, '');
    const checks = points.map(point => {
      const pattern = new RegExp(`${point.knowledge_point_id}(?![0-9A-Za-z-])`, 'u');
      const matching = chunks.filter(chunk => pattern.test(textOf(chunk)));
      const complete = matching.filter(chunk => normalize(textOf(chunk)).includes(normalize(point.text)));
      return { knowledge_point_id: point.knowledge_point_id, source_location: point.source_location,
        candidate_sha256: hash(point.text), chunk_ids: matching.map(item => item.id),
        complete_chunk_ids: complete.map(item => item.id), passed: matching.length === 1 && complete.length === 1 };
    });
    const pointIDs = new Set(checks.flatMap(item => item.chunk_ids));
    const nonbusiness = chunks.filter(chunk => !pointIDs.has(chunk.id));
    const tokenizerBytes = await readFile(path.resolve(root, '../../deps/huggingface.co/BAAI/bge-m3/tokenizer.json'));
    const tokenizer = new Tokenizer(JSON.parse(tokenizerBytes), {});
    const budgets = chunks.map(chunk => ({ chunk_id: chunk.id, text_sha256: hash(textOf(chunk)),
      text_tokens: tokenizer.encode(textOf(chunk)).ids.length,
      tokens_with_filename: tokenizer.encode(`${filename}\n${textOf(chunk)}`).ids.length }));
    const report = { ...record, checked_at: at, ingestion_status: remote.ingestion_status,
      exported_count: chunks.length, expected_points: points.length,
      full_body_passed: checks.filter(item => item.passed).length,
      deterministic_passed: checks.every(item => item.passed),
      checks, nonbusiness_chunk_ids: nonbusiness.map(item => item.id), budgets, chunks,
      tokenizer_sha256: hash(tokenizerBytes),
      maximum_tokens_with_filename: Math.max(...budgets.map(item => item.tokens_with_filename)),
      quality_accepted: false, formal_import: phase === 'formal', retrieval_accepted: false,
      remaining: 'Inspect rendered actual chunks, metadata boundaries and actual embedding/reranker budgets; automated coverage alone does not pass quality.' };
    const output = `04-chunks/actual/${docID}-successor-${phase}.json`;
    await save(output, report);
    record.status = 'actual-chunks-exported-awaiting-review';
    record.actual_evidence = output;
    record.exported_count = chunks.length;
    await save(ledgerPath, ledger);
    console.log(JSON.stringify({ doc_id: docID, phase, exported_count: chunks.length,
      full_body_passed: report.full_body_passed, expected_points: report.expected_points,
      nonbusiness_chunks: nonbusiness.map(item => ({ id: item.id, text: textOf(item) })),
      failed: checks.filter(item => !item.passed), maximum_tokens_with_filename: report.maximum_tokens_with_filename }));
  }
}
