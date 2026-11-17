import { api, load, rows, save } from './run.mjs';

const pipeline = await load('00-control/domain-pipeline.json');
const report = [];
for (const [domain, trial] of Object.entries(pipeline.trials)) {
  if (!trial.document_id || !trial.dataset_id) continue;
  const documentPage = await api(`/datasets/${trial.dataset_id}/documents?page=1&page_size=100`);
  const doc = rows(documentPage).find(item => item.id === trial.document_id);
  if (!doc) throw Error(`Document ${trial.document_id} not found in ${domain}`);
  const result = await api(`/datasets/${trial.dataset_id}/documents/${trial.document_id}/chunks?page=1&page_size=100`);
  const chunks = rows(result);
  const entry = {
    domain,
    doc_id: trial.doc_id,
    source_id: trial.source_id,
    dataset_id: trial.dataset_id,
    document_id: trial.document_id,
    parser_id: doc.parser_id,
    pipeline_id: doc.pipeline_id,
    pipeline_version_id: doc.pipeline_version_id,
    ingestion_status: doc.ingestion_status || doc.status,
    chunk_count_reported: doc.chunk_count,
    chunk_count_exported: chunks.length,
    chunks
  };
  await save(`04-chunks/actual/${domain}-hierarchy-trial.json`, entry);
  report.push({
    domain,
    parser_id: entry.parser_id,
    pipeline_id: entry.pipeline_id,
    pipeline_version_id: entry.pipeline_version_id,
    ingestion_status: entry.ingestion_status,
    chunk_count_reported: entry.chunk_count_reported,
    chunk_count_exported: entry.chunk_count_exported
  });
}
await save('00-control/pipeline-trial-acceptance.json', report);
console.log(JSON.stringify(report, null, 2));
