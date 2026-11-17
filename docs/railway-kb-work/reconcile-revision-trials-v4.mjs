import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { api, hash, load, originalDataset, root, rows, save } from './run.mjs';

const at = new Date().toISOString();
const folder = `05-review/revision-trial-reconciliation-${at.replaceAll(/[:.]/gu, '-')}`;
const registryPath = '00-control/document-register.json';
const registryBytes = await readFile(path.join(root, registryPath));
const registry = JSON.parse(registryBytes);
const datasetID = '0fb4da10e6ad4dd0bc7071b4407fe038';
const targets = [
  ['DOC0022', '98ab6f431ca546b6ae0dc7d68a9f9b35', 'e44f76fadd9e8259'],
  ['DOC0023', '09c031de678b4515937d37e133bcdce6', 'bc13e0fb27e6ea67'],
];
const normalize = text => text.replaceAll('**', '').replaceAll(/\s+/gu, '');
const documents = rows(await api(`/datasets/${datasetID}/documents?page=1&page_size=100`));
const prepared = [];
for (const [docID, documentID, metadataID] of targets) {
  const registered = registry.find(item => item.doc_id === docID);
  const live = documents.find(item => item.id === documentID);
  assert.ok(registered && live);
  assert.equal(live.ingestion_status, 'COMPLETED');
  assert.equal(live.pipeline_id, '0a707ed3e4144548a49bc7ee2cc83e31');
  assert.equal(live.pipeline_version_id, '8965e46a33454571a7ac918fbcb5bc7f');
  const chunker = Object.entries(live.parser_config).find(([key]) => key.startsWith('TitleChunker:'))?.[1];
  assert.ok(chunker);
  assert.equal(chunker.chunk_token_cap, 0);
  assert.equal(chunker.hierarchy, 3);
  const extractor = Object.entries(live.parser_config).find(([key]) => key.startsWith('Extractor:'))?.[1];
  assert.equal(extractor?.summary?.enabled, false);
  assert.equal(extractor?.questions?.top_n, 0);
  assert.equal(extractor?.metadata?.enabled, false);
  const local = await readFile(path.join(root, registered.master_path));
  assert.equal(hash(local), registered.sha256);
  const download = await api(`/datasets/${datasetID}/documents/${documentID}`, 'GET', undefined, true);
  const remote = Buffer.from(await download.arrayBuffer());
  assert.equal(hash(remote), hash(local), `${docID}: uploaded file differs from current master`);
  const result = await api(`/datasets/${datasetID}/documents/${documentID}/chunks?page=1&page_size=100`);
  const chunks = rows(result);
  assert.equal(chunks.length, result.total);
  assert.equal(chunks.length, live.chunk_count);
  const expectedBytes = await readFile(path.join(root, registered.revision_v4.expected_path));
  const expected = JSON.parse(expectedBytes);
  const points = expected.points.map(point => {
    const matching = chunks.filter(chunk => (chunk.content || '').match(/\bDOC\d{4}-K\d+\b/gu)?.includes(point.knowledge_point_id));
    assert.equal(matching.length, 1, `${point.knowledge_point_id}: missing or duplicate`);
    assert.equal(matching[0].available, true);
    assert.ok(normalize(matching[0].content).includes(normalize(point.text)), `${point.knowledge_point_id}: incomplete context`);
    assert.ok(normalize(matching[0].content).includes(normalize(point.source_body)), `${point.knowledge_point_id}: incomplete article`);
    return { knowledge_point_id: point.knowledge_point_id, chunk_id: matching[0].id,
      expected_text_sha256: hash(point.text), source_body_sha256: hash(point.source_body),
      complete_expected_text: true, available: true };
  });
  const mapped = new Set(points.map(point => point.chunk_id));
  const extras = chunks.filter(chunk => !mapped.has(chunk.id));
  assert.equal(extras.length, 1);
  assert.equal(extras[0].id, metadataID);
  assert.ok(extras[0].content.includes('本节仅供追溯；不作为业务问答证据。'));
  assert.ok(!/\bDOC\d{4}-K\d+\b/u.test(extras[0].content));
  const evidence = { doc_id: docID, dataset_id: datasetID, document_id: documentID,
    classification: 'isolation trial; not formal import or acceptance',
    local_master_path: registered.master_path, local_sha256: hash(local), remote_sha256: hash(remote),
    expected_path: registered.revision_v4.expected_path, expected_sha256: hash(expectedBytes),
    pipeline_id: live.pipeline_id, pipeline_version_id: live.pipeline_version_id,
    parser_config: live.parser_config, ingestion_status: live.ingestion_status,
    chunks_total: chunks.length, points_total: points.length, points,
    metadata_chunk: { id: metadataID, content_sha256: hash(extras[0].content),
      available_before: extras[0].available, reason: 'Traceability-only index explicitly excluded from business answer evidence' },
    structure_acceptance: false, legal_effectiveness_acceptance: false, formal_import: false };
  await save(`${folder}/${docID}-before.json`, result);
  prepared.push({ registered, evidence });
}

for (const { evidence } of prepared) {
  const route = `/datasets/${datasetID}/documents/${evidence.document_id}/chunks`;
  if (evidence.metadata_chunk.available_before) {
    await api(route, 'PATCH', { chunk_ids: [evidence.metadata_chunk.id], available: false });
  }
  const after = await api(`${route}?page=1&page_size=100`);
  const chunks = rows(after);
  assert.equal(chunks.length, evidence.chunks_total);
  const before = rows(await load(`${folder}/${evidence.doc_id}-before.json`));
  for (const chunk of chunks) {
    const previous = before.find(item => item.id === chunk.id);
    assert.ok(previous);
    assert.equal(chunk.content, previous.content);
    assert.equal(chunk.available, chunk.id === evidence.metadata_chunk.id ? false : previous.available);
  }
  evidence.metadata_chunk.available_after = false;
  evidence.business_chunks_available = chunks.filter(chunk => chunk.available).length;
  evidence.original_content_preserved = true;
  await save(`${folder}/${evidence.doc_id}-after.json`, after);
  await save(`${folder}/${evidence.doc_id}.json`, evidence);
}

const datasetIDs = [originalDataset, 'dac0aeb13d4d4e4f967a689c4c55af69',
  '8f7cbc152fc64d7b8d39da97028e5abe', '6b3ebc8cdb424cc4b489f80a4bf8718c',
  datasetID, '6276358588ab4dbb8c17baf7600b95c4'];
const datasets = [];
for (const id of datasetIDs) {
  const live = await api(`/datasets/${id}`);
  datasets.push({ id, name: live.name, classification: id === originalDataset ? 'original formal dataset' : 'isolation trial',
    document_count: live.document_count ?? live.doc_num, chunk_count: live.chunk_count ?? live.chunk_num,
    pipeline_id: live.pipeline_id, pipeline_version_id: live.pipeline_version_id,
    accessible: true });
}
await save(`${folder}/dataset-snapshot.json`, { checked_at: at, datasets,
  five_formal_domain_datasets_complete: false, original_dataset_modified: false });
await save(`${folder}/summary.json`, { checked_at: at, evidence_folder: folder,
  new_uploads: 0, documents_reparsed: 0, original_dataset_modified: false,
  documents: prepared.map(item => item.evidence), datasets });
assert.equal(hash(await readFile(path.join(root, registryPath))), hash(registryBytes),
  'Registry changed during reconciliation; preserve concurrent edits');
await save(`${folder}/${registryPath}`, registryBytes);
for (const { registered, evidence } of prepared) {
  registered.revision_v4.remote_upload_status = '已核对当前版隔离试验文件；非正式入库';
  registered.revision_v4.real_chunk_status = `已隔离试切并复核${evidence.points_total}个正文知识点；1个追溯索引片段停用检索；非正式验收`;
  registered.revision_v4.current_trial = { checked_at: at, dataset_id: datasetID,
    document_id: evidence.document_id, master_sha256: evidence.local_sha256,
    pipeline_id: evidence.pipeline_id, pipeline_version_id: evidence.pipeline_version_id,
    body_points: evidence.points_total, chunks: evidence.chunks_total,
    evidence_path: `${folder}/${evidence.doc_id}.json`, formal_import: false };
}
await save(registryPath, registry);
console.log(JSON.stringify({ evidence_folder: folder, new_uploads: 0,
  documents: prepared.map(({ evidence }) => ({ doc_id: evidence.doc_id,
    points: evidence.points_total, chunks: evidence.chunks_total,
    available: evidence.business_chunks_available })),
  datasets }, null, 2));
