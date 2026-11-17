import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { api, hash, load, originalDataset, root, rows, save } from './run.mjs';

const register = await load('00-control/document-register.json');
const ledger = await load('00-control/revision-v3-ledger.json');
const baseline = await load('00-control/inventory-original-documents.json');
const older = await load('00-control/original-import-ledger.json');
const expectedHashes = new Map([
  ...baseline.documents.map(d => [d.id, d.content_sha256]),
  ...older.documents.map(d => [d.document_id, d.sha256]),
  ...ledger.documents.filter(d => d.phase === 'formal').map(d => [d.document_id, d.sha256]),
]);
const current = new Map(register.map(d => {
  const item = ledger.documents.find(r => r.doc_id === d.doc_id && r.sha256 === d.sha256 &&
    r.phase === 'formal' && r.status === 'full-body-verified');
  if (!item) throw Error(`${d.doc_id}: current edition not verified`);
  return [item.document_id, d];
}));
const documents = [];
for (let page = 1; ; page++) {
  const response = await api(`/datasets/${originalDataset}/documents?page=${page}&page_size=100`);
  const batch = rows(response);
  documents.push(...batch);
  if (documents.length >= response.total || batch.length < 100) break;
}
const report = { checked_at: new Date().toISOString(), dataset_id: originalDataset,
  scope: 'Read-only live download, SHA-256, all chunk bodies and availability; no deletion.',
  documents: [], failures: [] };
for (const remote of documents) {
  const doc = current.get(remote.id);
  const downloaded = Buffer.from(await (await api(
    `/datasets/${originalDataset}/documents/${remote.id}`, 'GET', undefined, true)).arrayBuffer());
  const chunks = [];
  for (let page = 1; ; page++) {
    const batch = rows(await api(
      `/datasets/${originalDataset}/documents/${remote.id}/chunks?page=${page}&page_size=100`));
    chunks.push(...batch);
    if (batch.length < 100) break;
  }
  const actualHash = hash(downloaded);
  const checks = {
    original_downloadable: downloaded.length > 0,
    hash_matches_frozen_record: Boolean(expectedHashes.get(remote.id)) &&
      expectedHashes.get(remote.id) === actualHash,
    chunk_count_matches: chunks.length === Number(remote.chunk_count),
    status_matches: String(remote.status) === (doc ? '1' : '0'),
  };
  if (doc) {
    checks.master_hash_matches = hash(await readFile(path.join(root, doc.master_path))) === actualHash;
    checks.ingestion_completed = remote.ingestion_status === 'COMPLETED';
    const expected = await load(doc.structure_v3.expected_path);
    const normalize = s => s.replace(/\*\*([^*]+)\*\*/gu, '$1').replaceAll('`', '').replace(/\s+/gu, '');
    checks.all_points_complete_and_available = expected.points.every(p => {
      const id = new RegExp(`${p.knowledge_point_id}(?![0-9A-Za-z])`, 'u');
      const found = chunks.filter(c => id.test(c.content || ''));
      return found.length === 1 && found[0].available === true &&
        normalize(found[0].content).includes(normalize(p.text));
    });
    const metadata = chunks.filter(c => (c.content || '').includes('本节仅供追溯'));
    checks.metadata_disabled = metadata.length === 1 && metadata[0].available === false;
    checks.expected_chunk_count = chunks.length === expected.points.length + 1;
  } else checks.all_historical_chunks_disabled = chunks.every(c => c.available === false);
  const item = { document_id: remote.id, name: remote.name, doc_id: doc?.doc_id,
    role: doc ? 'current' : 'retained-history', sha256: actualHash,
    frozen_sha256: expectedHashes.get(remote.id), status: remote.status,
    ingestion_status: remote.ingestion_status, chunk_count: chunks.length, checks,
    passed: Object.values(checks).every(Boolean) };
  report.documents.push(item);
  if (!item.passed) report.failures.push(item);
  await save('05-review/preservation-context-v3.json', report);
  console.log(JSON.stringify({ id: remote.id, role: item.role, passed: item.passed }));
}
for (const id of expectedHashes.keys()) {
  if (!documents.some(d => d.id === id)) report.failures.push({ document_id: id, missing: true });
}
report.current_count = report.documents.filter(d => d.role === 'current').length;
report.history_count = report.documents.length - report.current_count;
report.passed = report.failures.length === 0 && report.current_count === register.length;
await save('05-review/preservation-context-v3.json', report);
console.log(JSON.stringify({ current: report.current_count, retained: report.history_count,
  failures: report.failures.length, passed: report.passed }));
