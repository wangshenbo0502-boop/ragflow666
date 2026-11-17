import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { hash, load, root, save } from './run.mjs';
import { Tokenizer } from './06-tools/node_modules/@huggingface/tokenizers/dist/tokenizers.mjs';

const at = new Date().toISOString();
const docId = process.argv[2] || 'DOC0027';
assert.ok(['DOC0026', 'DOC0027'].includes(docId));
const doc = (await load('00-control/document-register.json')).find(item => item.doc_id === docId);
assert.ok(doc);
const expectedBytes = await readFile(path.resolve(root, doc.structure_v3.expected_path));
const expected = JSON.parse(expectedBytes);
const tokenizerBytes = await readFile(path.resolve(root, '../../deps/huggingface.co/BAAI/bge-m3/tokenizer.json'));
const tokenizer = new Tokenizer(JSON.parse(tokenizerBytes), {});
const longest = expected.knowledge_points.reduce((best, item) =>
  item.embedding_tokens_with_full_prefix > best.embedding_tokens_with_full_prefix ? item : best);
const text = `文档：${doc.title}（${doc.doc_id}）；版本：${doc.version}；来源：${doc.source_id}；定位：${longest.source_location}\n知识点：${longest.knowledge_point_id} ${longest.heading}\n${longest.text}`;
assert.equal(tokenizer.encode(text).ids.length, longest.embedding_tokens_with_full_prefix);
async function request(route, body) {
  const response = await fetch(`http://127.0.0.1:11434${route}`, {
    method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(180000),
  });
  assert.equal(response.status, 200);
  return response.json();
}
const show = await request('/api/show', { model: 'bge-m3' });
const limit = show.model_info['bert.context_length'];
assert.equal(limit, 8192);
assert.ok(longest.embedding_tokens_with_full_prefix < limit);
const probe = await request('/api/embed', { model: 'bge-m3', input: text, truncate: false });
assert.equal(probe.embeddings.length, 1);
assert.equal(probe.embeddings[0].length, 1024);
assert.ok(probe.embeddings[0].every(Number.isFinite));
assert.ok(probe.prompt_eval_count >= longest.embedding_tokens_with_full_prefix - 8);
assert.ok(probe.prompt_eval_count < limit);
const runtime = await request('/api/ps');
const active = runtime.models.find(model => model.name.startsWith('bge-m3'));
assert.ok(active);
const runtimeLimit = active.context_length ?? active.details?.context_length;
assert.ok(Number.isInteger(runtimeLimit) && runtimeLimit > 0 && runtimeLimit <= limit);
assert.ok(longest.embedding_tokens_with_full_prefix < runtimeLimit);
assert.ok(probe.prompt_eval_count < runtimeLimit);
const output = `05-review/${docId}-embedding-budget-${at.replaceAll(/[:.]/gu, '-')}.json`;
await save(output, { checked_at: at, doc_id: doc.doc_id, model: 'bge-m3', expected_path: doc.structure_v3.expected_path,
  expected_sha256: hash(expectedBytes), input_sha256: hash(text), knowledge_point_id: longest.knowledge_point_id,
  tokenizer_sha256: hash(tokenizerBytes), tokenizer_tokens: longest.embedding_tokens_with_full_prefix,
  model_info: show.model_info, runtime_model: active, truncate: false,
  response: { model: probe.model, prompt_eval_count: probe.prompt_eval_count,
    total_duration: probe.total_duration, vector_dimensions: probe.embeddings[0].length,
    vector_sha256: hash(JSON.stringify(probe.embeddings[0])) },
  real_embedding_requests: 1, declared_model_limit: limit, runtime_limit: runtimeLimit, candidate_budget_verified: true,
  limitation: 'Complete longest prefixed candidate accepted with truncation disabled; actual parser output still needs separate inspection.' });
console.log(JSON.stringify({ evidence: output, longest_id: longest.knowledge_point_id,
  tokenizer_tokens: longest.embedding_tokens_with_full_prefix, evaluated_tokens: probe.prompt_eval_count,
  declared_model_limit: limit, runtime_limit: runtimeLimit, dimensions: probe.embeddings[0].length }));
