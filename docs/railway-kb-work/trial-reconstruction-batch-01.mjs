import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { api, load, rows, save, root } from './run.mjs';

const pipeline = await load('00-control/domain-pipeline.json');
const register = await load('00-control/document-register.json');
const requestedIDs = process.argv.slice(2).map(value => Number(value.replace(/^DOC/i, '')));
const selected = register.filter(doc => requestedIDs.length
  ? requestedIDs.includes(Number(doc.doc_id.slice(3)))
  : Number(doc.source_id.slice(1)) <= 5);
const uploaded = await load('00-control/reconstruction-trial-batch-01.json').catch(() => []);

for (const doc of selected) {
  const datasetID = pipeline.trials[doc.domain].dataset_id;
  const filename = `${path.basename(doc.master_path, '.md')}_rebuild.md`;
  const content = await readFile(path.join(root, doc.master_path));
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/markdown' }), filename);
  const result = await api(`/datasets/${datasetID}/documents`, 'POST', form);
  const row = rows(result).find(item => item.name === filename);
  if (!row?.id) throw new Error(`Upload did not return ${filename}`);
  await api(`/datasets/${datasetID}/documents/${row.id}`, 'PATCH', {
    parse_type: 2,
    pipeline_id: pipeline.pipeline_id,
    pipeline_version_id: pipeline.pipeline_version_id
  });
  await api(`/datasets/${datasetID}/documents/parse`, 'POST', { document_ids: [row.id] });
  uploaded.push({
    doc_id: doc.doc_id,
    source_id: doc.source_id,
    domain: doc.domain,
    dataset_id: datasetID,
    trial_document_id: row.id,
    filename,
    source_path: doc.master_path,
    source_sha256: doc.sha256,
    pipeline_id: pipeline.pipeline_id,
    pipeline_version_id: pipeline.pipeline_version_id,
    status: 'parse-requested'
  });
  const previousIndex = uploaded.findIndex(item => item.doc_id === doc.doc_id);
  if (previousIndex >= 0) uploaded[previousIndex] = {
    ...uploaded[previousIndex],
    ...{
      doc_id: doc.doc_id,
      source_id: doc.source_id,
      domain: doc.domain,
      dataset_id: datasetID,
      trial_document_id: row.id,
      filename,
      source_path: doc.master_path,
      source_sha256: doc.sha256,
      pipeline_id: pipeline.pipeline_id,
      pipeline_version_id: pipeline.pipeline_version_id,
      status: 'parse-requested'
    }
  };
  else uploaded.push({
    doc_id: doc.doc_id,
    source_id: doc.source_id,
    domain: doc.domain,
    dataset_id: datasetID,
    trial_document_id: row.id,
    filename,
    source_path: doc.master_path,
    source_sha256: doc.sha256,
    pipeline_id: pipeline.pipeline_id,
    pipeline_version_id: pipeline.pipeline_version_id,
    status: 'parse-requested'
  });
  await save('00-control/reconstruction-trial-batch-01.json', uploaded);
  console.log(`${doc.doc_id}: uploaded and parse requested in ${doc.domain} trial dataset`);
}
