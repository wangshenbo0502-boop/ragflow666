import assert from 'node:assert/strict';
import { api, hash, originalDataset, save, sql } from './run.mjs';

const stamp = new Date().toISOString();
const appID = '3b0470c7c4fb414dab6d32c19dfee8da';
const report = { checked_at: stamp, app_id: appID, settings_changed: false };
try {
  const before = await api(`/searches/${appID}`);
  const modelID = before.search_config?.rerank_id;
  assert.match(modelID || '', /^[a-f0-9]{32}$/u);
  const instance = JSON.parse(sql(`SELECT JSON_OBJECT('name',m.model_name,
    'api_key',i.api_key,'endpoint',i.extra,'limits',m.extra)
    FROM tenant_model m JOIN tenant_model_instance i ON i.id=m.instance_id
    WHERE m.id='${modelID}'`));
  let key = instance.api_key;
  if (key.startsWith('{')) key = JSON.parse(key).api_key;
  assert.ok(typeof key === 'string' && key.length);
  report.model = { id: modelID, name: instance.name,
    limits: JSON.parse(instance.limits || '{}'), authentication: 'Existing instance credential; omitted from evidence' };
  const request = { model: instance.name, query: '铁路运输企业应当如何保障铁路运输安全？',
    documents: ['铁路运输企业应当制定铁路运输安全管理制度，完善相关作业程序，保障铁路旅客和货物运输安全。',
      '本段介绍绘画颜料，与铁路运输安全管理无关。'], top_n: 2 };
  const response = await fetch('http://127.0.0.1:8082/v1/rerank', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(request), signal: AbortSignal.timeout(60000),
  });
  const payload = await response.json();
  const results = payload.results || payload.data;
  report.direct_rerank = { http_status: response.status, request, response: payload,
    succeeded: response.ok && Array.isArray(results) && results.length === 2
      && results.every(item => Number.isInteger(item.index) && Number.isFinite(item.relevance_score || item.score)) };
  assert.ok(report.direct_rerank.succeeded, 'Authenticated reranker did not return two scored results');
  const searchRequest = { dataset_ids: [originalDataset], question: request.query, page_size: 5,
    knn_top_k: 32, knn_num_candidates: 100, rerank_candidates_count: 64,
    use_kg: false, rerank_id: modelID };
  const search = await api('/datasets/search', 'POST', searchRequest);
  report.system_retrieval = { succeeded: true, request: searchRequest, response: search };
  report.application_unchanged = hash(JSON.stringify(before))
    === hash(JSON.stringify(await api(`/searches/${appID}`)));
} catch (error) {
  report.error = { message: error.message, cause: error.cause?.message, code: error.cause?.code };
}
const evidence = `05-review/rerank-authenticated-${stamp.replaceAll(':', '-').replaceAll('.', '-')}.json`;
await save(evidence, report);
console.log(JSON.stringify({ evidence, model: report.model,
  direct_rerank: report.direct_rerank && { succeeded: report.direct_rerank.succeeded,
    http_status: report.direct_rerank.http_status, results: report.direct_rerank.response },
  search_succeeded: report.system_retrieval?.succeeded,
  chunk_count: report.system_retrieval?.response?.chunks?.length,
  application_unchanged: report.application_unchanged, error: report.error }, null, 2));
