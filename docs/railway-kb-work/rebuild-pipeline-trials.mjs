import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { api, load, save, root } from './run.mjs';

const pipeline = await load('00-control/domain-pipeline.json');
const docs = await load('00-control/document-register.json');
const trials = [
  ['GW', 'S0007'],
  ['XH', 'S0011'],
  ['GD', 'S0016'],
  ['CL', 'S0020'],
  ['YS', 'S0022']
];

for (const [domain, sourceID] of trials) {
  const doc = docs.find(item => item.source_id === sourceID);
  const datasetID = pipeline.trials[domain].dataset_id;
  if (!doc || !datasetID) throw Error(`Missing document or dataset for ${domain}/${sourceID}`);
  const filename = path.basename(doc.master_path);
  const content = await readFile(path.join(root, doc.master_path));
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/markdown' }), filename);
  const uploaded = await api(`/datasets/${datasetID}/documents`, 'POST', form);
  const rows = Array.isArray(uploaded) ? uploaded : uploaded?.docs || uploaded?.documents || [];
  const row = rows.find(item => item.name === filename);
  if (!row?.id) throw Error(`Could not identify uploaded trial document ${filename}`);

  await api(`/datasets/${datasetID}/documents/${row.id}`, 'PATCH', {
    parse_type: 2,
    pipeline_id: pipeline.pipeline_id,
    pipeline_version_id: pipeline.pipeline_version_id
  });
  await api(`/datasets/${datasetID}/documents/parse`, 'POST', { document_ids: [row.id] });
  pipeline.trials[domain] = {
    dataset_id: datasetID,
    document_id: row.id,
    source_id: sourceID,
    doc_id: doc.doc_id,
    title: doc.title,
    master_path: doc.master_path,
    status: 'hierarchy-parse-requested'
  };
  await save('00-control/domain-pipeline.json', pipeline);
  console.log(`${domain}: uploaded, bound, and parse requested`);
}
