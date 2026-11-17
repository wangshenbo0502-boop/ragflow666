import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { api, load, save, root, rows } from './run.mjs';

const pipeline = await load('00-control/domain-pipeline.json');
const docs = await load('00-control/document-register.json');
const trialMap = Object.fromEntries(Object.entries(pipeline.trials).map(([domain, trial]) => [domain, trial]));
const completed = {};

for (const [domain, trial] of Object.entries(trialMap)) {
  const doc = docs.find(d => d.source_id === trial.source_id);
  if (!doc?.count_as_valid) throw Error(`Trial source ${trial.source_id} is not eligible`);
  const name = path.basename(doc.master_path);
  const listed = rows(await api(`/datasets/${trial.dataset_id}/documents?page=1&page_size=100`));
  const previous = listed.filter(d => d.id === trial.document_id || d.name === name);
  if (previous.length) {
    await api(`/datasets/${trial.dataset_id}/documents`, 'DELETE', { ids: previous.map(d => d.id) });
  }
  const content = await readFile(path.join(root, doc.master_path));
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/markdown' }), name);
  const uploaded = await api(`/datasets/${trial.dataset_id}/documents`, 'POST', form);
  const item = rows(uploaded).find(d => d.name === name);
  if (!item?.id) throw Error(`Upload did not return ${name}: ${JSON.stringify(uploaded).slice(0, 500)}`);
  await api(`/datasets/${trial.dataset_id}/documents/parse`, 'POST', { document_ids: [item.id] });
  completed[domain] = {
    dataset_id: trial.dataset_id,
    document_id: item.id,
    source_id: doc.source_id,
    title: doc.title,
    master_path: doc.master_path,
    sha256: doc.sha256,
    status: 'parse-requested'
  };
  pipeline.trials[domain] = { ...pipeline.trials[domain], ...completed[domain] };
  await save('00-control/domain-pipeline.json', pipeline);
  console.log(domain, item.id, name, 'parse requested');
}
await save('00-control/domain-pipeline.json', pipeline);
console.log(JSON.stringify(completed, null, 2));
