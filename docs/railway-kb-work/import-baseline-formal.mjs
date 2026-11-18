import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { api, hash, load, root, rows, save } from './run.mjs';

const docIDs = process.argv.slice(2);
assert.ok(docIDs.length > 0 && docIDs.length <= 5, 'Provide 1-5 document IDs');
const at = new Date().toISOString();
const register = await load('00-control/document-register.json');
const pipeline = await load('00-control/domain-pipeline.json');
const mapping = await load('00-control/formal-domain-map.json');
const ledgerPath = '00-control/baseline-formal-import-ledger.json';
const ledger = await load(ledgerPath).catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return { created_at: at, documents: [] };
});

for (const docID of docIDs) {
  const doc = register.find(item => item.doc_id === docID);
  assert.ok(doc && doc.count_as_valid, `${docID} is not an eligible registered document`);
  const master = await readFile(path.join(root, doc.master_path));
  assert.equal(hash(master), doc.sha256, `${docID} master hash changed`);
  const trialPath = `04-chunks/actual/${docID}-v3-trial.json`;
  const formalPath = `04-chunks/actual/${docID}-v3-formal.json`;
  const trial = await load(trialPath);
  const priorFormal = await load(formalPath);
  const expected = await load(`04-chunks/expected/${docID}-v3.json`);
  const points = expected.knowledge_points || expected.points;
  assert.equal(trial.phase, 'trial');
  assert.equal(trial.dataset_id, pipeline.trials[doc.domain].dataset_id);
  assert.equal(trial.sha256, doc.sha256);
  assert.equal(trial.pipeline_id, pipeline.pipeline_id);
  assert.equal(trial.pipeline_version_id, pipeline.pipeline_version_id);
  assert.equal(trial.passed, true);
  assert.equal(trial.full_body_passed, points.length);
  assert.equal(trial.expected_points, points.length);
  assert.equal(priorFormal.phase, 'formal');
  assert.equal(priorFormal.sha256, doc.sha256);
  assert.equal(priorFormal.pipeline_id, pipeline.pipeline_id);
  assert.equal(priorFormal.pipeline_version_id, pipeline.pipeline_version_id);
  assert.equal(priorFormal.passed, true);
  assert.equal(priorFormal.full_body_passed, points.length);

  const target = mapping.domains[doc.domain];
  const dataset = await api(`/datasets/${target.id}`);
  assert.equal(dataset.pipeline_id, pipeline.pipeline_id);
  assert.equal(dataset.pipeline_version_id, pipeline.pipeline_version_id);
  let documents = rows(await api(`/datasets/${target.id}/documents?page=1&page_size=100`));
  const existing = ledger.documents.find(item => item.doc_id === docID
    && item.sha256 === doc.sha256 && item.dataset_id === target.id);
  const matches = documents.filter(item => item.name
    === `${path.basename(doc.master_path, '.md')}_formal_${doc.sha256.slice(0, 12)}.md`);
  assert.ok(matches.length <= 1, `${docID} has duplicate matching formal uploads`);
  let record = existing;
  if (!record) {
    assert.equal(matches.length, 0, `${docID} remote file exists without an audit ledger`);
    const filename = `${path.basename(doc.master_path, '.md')}_formal_${doc.sha256.slice(0, 12)}.md`;
    const form = new FormData();
    form.append('file', new Blob([master], { type: 'text/markdown' }), filename);
    const uploaded = rows(await api(`/datasets/${target.id}/documents`, 'POST', form));
    const remote = uploaded.find(item => item.name === filename);
    assert.ok(remote?.id, `${docID} upload ID missing`);
    record = {
      doc_id: docID, source_id: doc.source_id, domain: doc.domain,
      dataset_id: target.id, document_id: remote.id, filename,
      master_path: doc.master_path, sha256: doc.sha256,
      trial_evidence: trialPath, prior_formal_evidence: formalPath,
      pipeline_id: pipeline.pipeline_id,
      pipeline_version_id: pipeline.pipeline_version_id,
      status: 'uploaded', uploaded_at: at
    };
    ledger.documents.push(record);
    await save(ledgerPath, ledger);
  } else {
    assert.equal(matches[0]?.id, record.document_id);
  }

  documents = rows(await api(`/datasets/${target.id}/documents?page=1&page_size=100`));
  const remoteBytes = Buffer.from(await (await api(
    `/datasets/${target.id}/documents/${record.document_id}`, 'GET', undefined, true
  )).arrayBuffer());
  assert.equal(hash(remoteBytes), doc.sha256, `${docID} remote original mismatch`);
  const remote = documents.find(item => item.id === record.document_id);
  assert.ok(remote, `${docID} formal document is absent from the target library`);
  if (remote.ingestion_status === 'COMPLETED') {
    record.status = 'parse-completed-awaiting-review';
  } else if (!['RUNNING', 'PENDING', 'QUEUED'].includes(remote.ingestion_status)) {
    assert.equal(record.status, 'uploaded', `${docID} parse already attempted; inspect before retry`);
    record.status = 'parse-request-intent';
    await save(ledgerPath, ledger);
    await api(`/datasets/${target.id}/documents/${record.document_id}`, 'PATCH', {
      parse_type: 2, pipeline_id: pipeline.pipeline_id,
      pipeline_version_id: pipeline.pipeline_version_id
    });
    await api(`/datasets/${target.id}/documents/parse`, 'POST', {
      document_ids: [record.document_id]
    });
    record.status = 'parse-requested';
    record.parse_requested_at = new Date().toISOString();
  } else {
    record.status = 'parse-requested';
  }
  await save(ledgerPath, ledger);
  console.log(JSON.stringify({
    doc_id: docID, dataset_id: target.id, document_id: record.document_id,
    status: record.status, ingestion_status: remote.ingestion_status,
    parse_requested_at: record.parse_requested_at
  }));
}
