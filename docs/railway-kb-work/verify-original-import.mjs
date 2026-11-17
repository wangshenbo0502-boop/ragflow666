import { api, load, rows, save } from './run.mjs';

const ledgerPath = '00-control/original-import-ledger.json';
const ledger = await load(ledgerPath);
const resultsPath = '00-control/original-import-verification.json';
const results = await load(resultsPath).catch(() => []);

for (const entry of ledger.documents) {
  if (results.some(item => item.doc_id === entry.doc_id &&
      item.document_id === entry.document_id && item.ingestion_status === 'COMPLETED' &&
      item.chunk_count_reported === item.chunk_count_exported &&
      item.missing_article_numbers.length === 0)) continue;

  let doc;
  for (let attempt = 0; attempt < 120; attempt++) {
    const docs = rows(await api(`/datasets/${ledger.dataset_id}/documents?page=1&page_size=100`));
    doc = docs.find(item => item.id === entry.document_id);
    if (!doc) throw new Error(`Original document missing: ${entry.document_id}`);
    const status = String(doc.ingestion_status || doc.status || '').toUpperCase();
    if (!['RUNNING', 'SCHEDULED', 'PROCESSING', 'UNSTARTED'].includes(status)) break;
    await new Promise(resolve => setTimeout(resolve, 10000));
  }

  const chunks = [];
  const total = Number(doc.chunk_count || 0);
  for (let page = 1; page <= Math.max(1, Math.ceil(total / 100)); page++) {
    chunks.push(...rows(await api(
      `/datasets/${ledger.dataset_id}/documents/${entry.document_id}/chunks?page=${page}&page_size=100`
    )));
  }
  const content = chunks.map(chunk => String(chunk.content || chunk.content_with_weight || '')).join('\n');
  const expected = await load(`04-chunks/expected/${entry.doc_id}-article-audit.json`);
  const actualArticles = new Set([...content.matchAll(
    /第[一二三四五六七八九十百零〇两0-9]+条/g
  )].map(match => match[0]));
  const missingArticles = expected.articles
    .map(item => item.article)
    .filter(article => !actualArticles.has(article));
  const result = {
    doc_id: entry.doc_id,
    source_id: entry.source_id,
    domain: entry.domain,
    document_id: entry.document_id,
    ingestion_status: doc.ingestion_status || doc.status,
    chunk_count_reported: total,
    chunk_count_exported: chunks.length,
    missing_article_numbers: missingArticles,
    trial_chunk_count: entry.trial_chunk_count,
    chunks
  };
  const index = results.findIndex(item => item.doc_id === result.doc_id);
  if (index >= 0) results[index] = result;
  else results.push(result);
  entry.status = result.ingestion_status === 'COMPLETED' &&
    result.chunk_count_reported === result.chunk_count_exported &&
    result.missing_article_numbers.length === 0 ? 'parsed-coverage-passed' : 'verification-failed';
  await save(resultsPath, results);
  await save(ledgerPath, ledger);
  console.log(JSON.stringify({
    doc_id: result.doc_id,
    ingestion_status: result.ingestion_status,
    chunk_count_reported: result.chunk_count_reported,
    chunk_count_exported: result.chunk_count_exported,
    missing_article_numbers: result.missing_article_numbers
  }));
}
