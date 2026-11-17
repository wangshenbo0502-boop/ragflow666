import { execFileSync } from 'node:child_process';
import { api, hash, load, originalDataset, save, sql } from './run.mjs';

const appID = '3b0470c7c4fb414dab6d32c19dfee8da';
const before = await api(`/searches/${appID}`);
const modelID = before.search_config?.rerank_id;
if (!/^[a-f0-9]{32}$/u.test(modelID || '')) throw Error('Unexpected rerank model ID');
const metadata = sql(`SELECT JSON_OBJECT('id',m.id,'name',m.model_name,
  'model_type',m.model_type,'status',m.status,'limits',m.extra,
  'provider',p.provider_name,'instance',i.instance_name,'endpoint',i.extra)
  FROM tenant_model m JOIN tenant_model_provider p ON p.id=m.provider_id
  JOIN tenant_model_instance i ON i.id=m.instance_id WHERE m.id='${modelID}'`);
const model = JSON.parse(metadata);
model.limits = JSON.parse(model.limits);
model.endpoint = JSON.parse(model.endpoint);
const report = { checked_at: new Date().toISOString(), app_id: appID,
  dataset_id: originalDataset, model,
  scope: 'Read-only runtime checks; no model, application, database or service settings changed.',
  containers: execFileSync('docker', ['ps', '-a', '--format', '{{.Names}}\t{{.Status}}\t{{.Image}}'],
    { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/u),
};
try {
  const response = await fetch('http://127.0.0.1:8082/v1/models', {
    signal: AbortSignal.timeout(10000),
  });
  report.host_endpoint = { reachable: true, status: response.status };
} catch (error) {
  report.host_endpoint = { reachable: false, error: error.cause?.code || error.message };
}
const input = await load('00-control/acceptance-v3-context-inputs.json');
try {
  const response = await api('/datasets/search', 'POST', {
    dataset_ids: [originalDataset], question: input.questions[0].question,
    ...input.parameters, rerank_id: modelID,
  });
  report.actual_retrieval = { succeeded: true, chunk_count: response.chunks?.length };
} catch (error) {
  report.actual_retrieval = { succeeded: false, error: error.message };
}
const after = await api(`/searches/${appID}`);
report.user_app_unchanged = hash(JSON.stringify(before)) === hash(JSON.stringify(after));
report.prior_no_rerank_score = '43/58 (74.1%); not a measurement of the user application with reranking.';
await save('05-review/runtime-audit-v3.json', report);
console.log(JSON.stringify(report, null, 2));
