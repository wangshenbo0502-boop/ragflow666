import { api, load, rows, save } from './run.mjs';

const ledgerPath = '00-control/original-import-ledger.json';
const ledger = await load(ledgerPath);
const verification = await load('00-control/original-import-verification.json');
const baseline = await load('00-control/inventory-original-documents.json');
const replacements = new Map(ledger.documents.map(item => [item.doc_id, item]));
const verified = new Map(verification.map(item => [item.doc_id, item]));
const oldToNew = new Map([
  ['equipment-quality.md', 'DOC0001'],
  ['real-name-tickets.md', 'DOC0002'],
  ['passenger-security.md', 'DOC0003'],
  ['passenger-transport.md', 'DOC0004'],
  ['railway-emergency.md', 'DOC0005'],
  ['railway-safety.md', 'DOC0006']
]);
const originalDocuments = rows(baseline.documents);
const retiring = [];

for (const old of originalDocuments) {
  const docID = oldToNew.get(old.name);
  if (!docID) throw new Error(`No verified replacement mapping for ${old.name}`);
  const replacement = replacements.get(docID);
  const result = verified.get(docID);
  if (!replacement || !result ||
      replacement.status !== 'parsed-coverage-passed' ||
      result.ingestion_status !== 'COMPLETED' ||
      result.chunk_count_reported !== result.chunk_count_exported ||
      result.missing_article_numbers.length) {
    throw new Error(`Replacement ${docID} has not passed original-dataset verification.`);
  }
  retiring.push({ old_document_id: old.id, old_name: old.name, replacement_doc_id: docID });
}

await api(`/datasets/${ledger.dataset_id}/documents/batch-update-status`, 'POST', {
  doc_ids: retiring.map(item => item.old_document_id),
  status: '0'
});

const current = rows(await api(`/datasets/${ledger.dataset_id}/documents?page=1&page_size=100`));
for (const item of retiring) {
  const old = current.find(doc => doc.id === item.old_document_id);
  if (!old || String(old.status) !== '0') {
    throw new Error(`Old document status did not verify as inactive: ${item.old_name}`);
  }
  const replacement = ledger.documents.find(doc => doc.doc_id === item.replacement_doc_id);
  replacement.original_documents_to_retire.push({
    document_id: item.old_document_id,
    filename: item.old_name,
    status: '0'
  });
}

ledger.retired_originals_at = new Date().toISOString();
ledger.retired_originals = retiring;
await save(ledgerPath, ledger);
console.log(JSON.stringify({
  retired_count: retiring.length,
  retired: retiring.map(item => ({
    filename: item.old_name,
    replacement_doc_id: item.replacement_doc_id
  }))
}, null, 2));
