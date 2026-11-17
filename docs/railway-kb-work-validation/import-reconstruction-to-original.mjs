import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { api, load, rows, save, root } from './run.mjs';

const requestedIDs = process.argv.slice(2).map(value => Number(value.replace(/^DOC/i, '')));
if (requestedIDs.length < 1 || requestedIDs.length > 5) {
  throw new Error('Pass between one and five DOC IDs per import batch.');
}

const register = await load('00-control/document-register.json');
const trials = await load('00-control/reconstruction-trial-batch-01.json');
const accepted = new Map(trials.map(item => [item.doc_id, item]));
for (const docID of ['DOC0001', 'DOC0002', 'DOC0003', 'DOC0004', 'DOC0005']) {
  if (accepted.has(docID)) continue;
  const saved = await load(`04-chunks/actual/${docID}-reconstruction-trial.json`).catch(() => null);
  if (saved) accepted.set(docID, saved);
}
const ledgerPath = '00-control/original-import-ledger.json';
const ledger = await load(ledgerPath).catch(() => ({
  dataset_id: '66ff4d9d5ff748af8e83080bd7482f04',
  pipeline_id: '0a707ed3e4144548a49bc7ee2cc83e31',
  pipeline_version_id: '8965e46a33454571a7ac918fbcb5bc7f',
  documents: []
}));
const existing = rows(await api(`/datasets/${ledger.dataset_id}/documents?page=1&page_size=100`));

for (const numericID of requestedIDs) {
  const docID = `DOC${String(numericID).padStart(4, '0')}`;
  const doc = register.find(item => item.doc_id === docID);
  const trial = accepted.get(docID);
  if (!doc || !trial) throw new Error(`${docID} has no completed trial record.`);
  if ([10, 14, 16].includes(numericID)) throw new Error(`${docID} is excluded pending source review.`);
  const trialResult = await load(`04-chunks/actual/${docID}-reconstruction-trial.json`);
  if (trialResult.ingestion_status !== 'COMPLETED' ||
      trialResult.chunk_count_reported !== trialResult.chunk_count_exported ||
      trialResult.missing_article_numbers.length) {
    throw new Error(`${docID} has not passed trial completeness checks.`);
  }

  const filename = `${path.basename(doc.master_path, '.md')}_重构版.md`;
  const previous = ledger.documents.find(item => item.doc_id === docID);
  if (previous) {
    console.log(`${docID}: already recorded as ${previous.document_id}`);
    continue;
  }
  if (existing.some(item => item.name === filename)) {
    throw new Error(`${filename} already exists in the original dataset but is not in the import ledger.`);
  }

  const content = await readFile(path.join(root, doc.master_path));
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/markdown' }), filename);
  const upload = await api(`/datasets/${ledger.dataset_id}/documents`, 'POST', form);
  const uploaded = rows(upload).find(item => item.name === filename);
  if (!uploaded?.id) throw new Error(`Upload did not return ${filename}.`);
  await api(`/datasets/${ledger.dataset_id}/documents/${uploaded.id}`, 'PATCH', {
    parse_type: 2,
    pipeline_id: ledger.pipeline_id,
    pipeline_version_id: ledger.pipeline_version_id
  });
  await api(`/datasets/${ledger.dataset_id}/documents/parse`, 'POST', {
    document_ids: [uploaded.id]
  });

  ledger.documents.push({
    doc_id: docID,
    source_id: doc.source_id,
    domain: doc.domain,
    title: doc.title,
    filename,
    document_id: uploaded.id,
    sha256: doc.sha256,
    trial_document_id: trial.trial_document_id,
    trial_chunk_count: trialResult.chunk_count_exported,
    pipeline_id: ledger.pipeline_id,
    pipeline_version_id: ledger.pipeline_version_id,
    status: 'parse-requested',
    original_documents_to_retire: []
  });
  await save(ledgerPath, ledger);
  console.log(`${docID}: uploaded to original dataset and parse requested (${uploaded.id})`);
}
