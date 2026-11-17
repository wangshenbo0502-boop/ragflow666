import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { api, hash, load, repo, root, rows, save } from './run.mjs';
import { Tokenizer } from './06-tools/node_modules/@huggingface/tokenizers/dist/tokenizers.mjs';

const accept = process.argv.includes('--accept');
const formal = process.argv.includes('--formal');
const at = new Date().toISOString();
const require = createRequire(path.join(repo, 'web/package.json'));
const { fromMarkdown } = await import(pathToFileURL(require.resolve('mdast-util-from-markdown')));
const bytes = relative => readFile(path.resolve(root, relative));
const bound = async binding => assert.equal(hash(await bytes(binding.path)), binding.sha256, binding.path);
const textOf = chunk => chunk.content || chunk.content_with_weight || chunk.text || '';
const lines = text => text.replaceAll('\r\n', '\n').split('\n').filter(line => line.trim()).join('\n').trim();
const registry = await load('00-control/document-register.json');
const doc = registry.find(item => item.doc_id === 'DOC0027');
const structure = doc.structure_v3;
const decision = await load(structure.structure_decision.path);
await bound(structure.structure_decision);
assert.equal(decision.structure_accepted, true);
for (const binding of [...Object.values(decision.bindings), ...decision.dependencies]) await bound(binding);
const manifestPath = '04-chunks/inputs/DOC0027-literal-da4500791353/manifest.json';
const manifest = await load(manifestPath);
for (const key of ['master', 'expected', 'structure_decision', 'input', 'debug_evidence']) await bound(manifest[key]);
assert.equal(manifest.master.sha256, doc.sha256);
assert.equal(manifest.structure_decision.sha256, structure.structure_decision.sha256);
assert.equal(manifest.reversible_exact_bytes, true);
assert.equal(manifest.headings_unchanged, true);
const master = (await bytes(doc.master_path)).toString('utf8');
const rendition = (await bytes(manifest.input.path)).toString('utf8');
const renditionAST = fromMarkdown(rendition);
let restored = rendition;
for (const block of renditionAST.children.filter(node => node.type === 'code').reverse()) {
  restored = restored.slice(0, block.position.start.offset) + block.value
    + restored.slice(block.position.end.offset);
}
assert.equal(restored, master);
const expected = await load(structure.expected_path);
const native = await load(decision.bindings.native.path);
const actualPath = formal
  ? '04-chunks/actual/DOC0027-successor-formal.json'
  : '04-chunks/actual/DOC0027-successor-trial.json';
const evidencePath = formal
  ? '05-review/DOC0027-formal-quality-2026-11-17.json'
  : '05-review/DOC0027-literal-trial-quality-2026-11-17.json';
const actualBytes = await bytes(actualPath);
const actual = JSON.parse(actualBytes);
assert.equal(actual.phase, formal ? 'formal' : 'trial');
assert.equal(actual.document_id, formal
  ? '33ea398a0b4b4bfa8bc96a4278b3bd0a'
  : '8896cd1f6eda42a8ad98bbac1cfeef3d');
assert.equal(actual.sha256, doc.sha256);
assert.equal(actual.input_sha256, manifest.input.sha256);
assert.equal(actual.pipeline_version_id, manifest.pipeline_version_id);
assert.equal(actual.ingestion_status, 'COMPLETED');
assert.equal(actual.chunks.length, 205);
assert.equal(expected.knowledge_points.length, 200);
const debug = await load(manifest.debug_evidence.path);
assert.equal(debug.passed, true);
assert.deepEqual(actual.chunks.map(textOf).map(lines), debug.chunker.chunks.map(textOf).map(lines));

const headings = fromMarkdown(master).children.filter(node => node.type === 'heading');
assert.equal(headings.filter(node => node.depth === 1).length, 1);
assert.equal(headings.filter(node => node.depth === 3).length, 200);
assert.ok(headings.every(node => node.depth <= 3));
const headingSlices = headings.map((heading, index) => ({
  depth: heading.depth,
  raw: master.slice(heading.position.start.offset, headings[index + 1]?.position.start.offset).trim(),
}));
const units = new Map();
let ancestors = [];
for (const heading of headingSlices) {
  ancestors = ancestors.filter(item => item.depth < heading.depth);
  if (heading.depth === 3) {
    const id = /^### (DOC0027-[A-Z0-9-]+) /u.exec(heading.raw)?.[1];
    assert.ok(id, heading.raw.slice(0, 120));
    assert.ok(!units.has(id));
    units.set(id, [...ancestors, heading].map(item => item.raw).join('\n'));
  }
  ancestors.push(heading);
}
const verification = await load('05-review/successor-semantic-review/cache-verification.json');
const adjudication = await load('05-review/successor-semantic-adjudication-v2.json');
const batches = new Map();
for (const item of verification.batch_evidence.filter(item => item.doc_id === doc.doc_id)) {
  await bound(item);
  const batch = await load(item.path);
  assert.equal(batch.source_sha256, decision.bindings.original.sha256);
  assert.equal(batch.model, verification.model);
  assert.equal(batch.prompt_sha256, verification.prompt_sha256);
  assert.equal(batch.rules_sha256, verification.rules_sha256);
  assert.equal(batch.input_sha256, hash(JSON.stringify({
    version: batch.version, model: batch.model, promptHash: batch.prompt_sha256,
    ruleHash: batch.rules_sha256, source_hash: decision.bindings.native.sha256,
    payload: batch.input,
  })));
  batches.set(item.path, { binding: item, batch });
}
const sourceCompact = text => text.replace(/\s+/gu, '');
const checks = expected.knowledge_points.map(point => {
  const unit = units.get(point.knowledge_point_id);
  assert.ok(unit);
  const matches = actual.chunks.filter(chunk => lines(textOf(chunk)) === lines(unit));
  assert.equal(matches.length, 1, `${point.knowledge_point_id}: complete unit mismatch`);
  const chunk = matches[0];
  assert.equal(chunk.doc_type_kwd, 'text');
  assert.equal(chunk.available, true);
  assert.equal(chunk.docnm_kwd, actual.filename);
  assert.equal((textOf(chunk).match(/^### DOC0027-/gmu) || []).length, 1);
  const judgment = verification.judgments.find(item => item.knowledge_point_id === point.knowledge_point_id);
  const cached = batches.get(judgment?.evidence_path);
  assert.ok(cached);
  const input = cached.batch.input.items.find(item => item.knowledge_point_id === point.knowledge_point_id);
  assert.equal(input.heading, point.heading);
  let candidate = point.text;
  for (const line of input.candidate_shared_context_lines) {
    assert.ok(candidate.includes(line + '\n'));
    candidate = candidate.replace(line + '\n', '');
  }
  assert.equal(candidate, input.candidate_remaining_text);
  for (const context of cached.batch.input.shared_context) {
    const source = native.blocks.find(block => block.type === 'paragraph' && block.paragraph === context.paragraph);
    assert.ok(source, `${point.knowledge_point_id}: missing shared source`);
    assert.equal(sourceCompact(context.text), sourceCompact(source.text));
  }
  const table = native.tables.find(item => item.table_id === point.native_table_id);
  for (const cell of [...(point.native_cell_mapping || []), ...(point.external_merge_origins || [])]) {
    assert.deepEqual(cell, table?.rows.flatMap(row => row.cells).find(item => item.cell_id === cell.cell_id));
  }
  assert.deepEqual(input.external_merge_origins || [], point.external_merge_origins || []);
  for (const context of point.common_context || []) {
    assert.equal(sourceCompact(context.text), sourceCompact(native.blocks.find(block =>
      block.type === 'paragraph' && block.paragraph === context.paragraph)?.text || ''));
    assert.ok(point.text.includes(context.text.trim()));
  }
  const adjudicated = adjudication.decisions.find(item => item.knowledge_point_id === point.knowledge_point_id);
  if (judgment.status !== 'PASS') {
    assert.equal(adjudicated?.decision, 'FAITHFUL_SOURCE_RETAIN');
    assert.equal(adjudicated.candidate_text_sha256, hash(point.text));
    assert.equal(adjudicated.original_sha256, decision.bindings.original.sha256);
    assert.equal(adjudicated.native_sha256, decision.bindings.native.sha256);
    assert.equal(adjudicated.expected_sha256, decision.bindings.expected.sha256);
  }
  return { knowledge_point_id: point.knowledge_point_id, chunk_id: chunk.id,
    source_location: point.source_location, candidate_sha256: hash(point.text),
    actual_text_sha256: hash(textOf(chunk)), complete_master_unit_sha256: hash(unit),
    complete_unit_equal_except_empty_lines: true, single_business_heading: true,
    source_cells_and_shared_context_unchanged: true,
    semantic_status: judgment.status, semantic_batch: cached.binding,
    semantic_finding: judgment.finding,
    source_adjudication: adjudicated?.decision, answer_limit: adjudicated?.answer_limit,
    decision: 'PASS_FOR_FAITHFUL_SOURCE_CHUNK' };
});
assert.equal(new Set(checks.map(item => item.chunk_id)).size, 200);
assert.equal(checks.filter(item => item.semantic_status === 'PASS').length, 198);
assert.equal(checks.filter(item => item.source_adjudication === 'FAITHFUL_SOURCE_RETAIN').length, 2);
const metadata = actual.chunks.filter(chunk => !checks.some(item => item.chunk_id === chunk.id));
assert.equal(metadata.length, 5);
const metadataTitles = ['阅读范围', '原文附件目录', '附件5', '核验边界与后续验收', '来源清单'];
assert.deepEqual(metadata.map(chunk => /^## (.+)$/mu.exec(textOf(chunk))?.[1]), metadataTitles);
assert.ok(metadata.every(chunk => !/^### /mu.test(textOf(chunk))));
assert.ok(textOf(actual.chunks.find(chunk => checks.find(item =>
  item.knowledge_point_id === 'DOC0027-K014')?.chunk_id === chunk.id)).includes('TXTX####—*****'));
const tokenizerBytes = await bytes('../../deps/huggingface.co/BAAI/bge-m3/tokenizer.json');
assert.equal(hash(tokenizerBytes), actual.tokenizer_sha256);
const tokenizer = new Tokenizer(JSON.parse(tokenizerBytes), {});
const inputs = actual.chunks.map(chunk => {
  const complete = `${actual.filename}\n${textOf(chunk)}`;
  return { chunk_id: chunk.id, complete, embedding_tokens: tokenizer.encode(complete).ids.length };
});
assert.equal(Math.max(...inputs.map(item => item.embedding_tokens)), 1929);
const budgetPath = '05-review/DOC0027-literal-actual-budget-2026-11-17.json';
let budget;
try {
  budget = await load(budgetPath);
  assert.equal(budget.passed, true);
  if (budget.actual_sha256 !== hash(actualBytes)) {
    assert.ok(formal, 'Only the recorded formal document can reuse a budget from its accepted trial');
    const trialActual = await load('04-chunks/actual/DOC0027-successor-trial.json');
    assert.deepEqual(actual.chunks.map(textOf).map(lines).sort(),
      trialActual.chunks.map(textOf).map(lines).sort(),
      'Formal chunk texts differ from the budget-validated accepted trial');
    assert.deepEqual(inputs.map(item => hash(item.complete)).sort(),
      budget.inputs.map(item => item.complete_input_sha256).sort(),
      'Formal embedding inputs differ from the budget-validated accepted trial');
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const key = (await bytes('../../.cache/reranker.api-key')).toString('utf8').trim();
  async function request(base, route, body, authenticated = false) {
    const response = await fetch(`${base}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json',
        ...(authenticated ? { Authorization: `Bearer ${key}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000),
    });
    assert.equal(response.status, 200, `${route}: HTTP ${response.status}`);
    return response.json();
  }
  const rerank = (route, body) => request('http://127.0.0.1:8082', route, body, true);
  const ollama = (route, body) => request('http://127.0.0.1:11434', route, body);
  const props = await rerank('/props');
  assert.equal(props.model_alias, 'bge-reranker-v2-m3');
  const query = '铁路通信设备生产许可申请表的填写对象、材料和受理机构填写区域是什么？';
  const queryTokens = (await rerank('/tokenize', { content: query, add_special: false })).tokens.length;
  for (const input of inputs) {
    input.reranker_tokens = (await rerank('/tokenize', { content: input.complete, add_special: false })).tokens.length;
    assert.ok(input.reranker_tokens + queryTokens + 8 < props.default_generation_settings.n_ctx);
  }
  const longest = inputs.reduce((a, b) => a.embedding_tokens > b.embedding_tokens ? a : b);
  const embedded = await ollama('/api/embed', { model: 'bge-m3', input: longest.complete, truncate: false });
  assert.equal(embedded.embeddings.length, 1);
  assert.equal(embedded.embeddings[0].length, 1024);
  assert.ok(embedded.embeddings[0].every(Number.isFinite));
  assert.ok(Number.isInteger(embedded.prompt_eval_count) && embedded.prompt_eval_count > 0);
  assert.ok(Math.abs(embedded.prompt_eval_count - longest.embedding_tokens) <= 2,
    'Unexpected local/runtime token-count divergence; inspect before acceptance');
  const runtime = (await ollama('/api/ps')).models.find(item => item.name.startsWith('bge-m3'));
  assert.ok(runtime.context_length > longest.embedding_tokens);
  const rerankLongest = inputs.reduce((a, b) => a.reranker_tokens > b.reranker_tokens ? a : b);
  const reranked = await rerank('/v1/rerank', { model: props.model_alias, query,
    documents: [rerankLongest.complete], top_n: 1 });
  assert.equal(reranked.results.length, 1);
  assert.ok(Number.isFinite(reranked.results[0].relevance_score));
  assert.ok(reranked.usage.prompt_tokens >= rerankLongest.reranker_tokens + queryTokens);
  assert.ok(reranked.usage.prompt_tokens < props.default_generation_settings.n_ctx);
  budget = { checked_at: at, actual_path: actualPath, actual_sha256: hash(actualBytes),
    tokenizer_sha256: hash(tokenizerBytes), filename: actual.filename,
    inputs: inputs.map(({ complete, ...item }) => ({ ...item, complete_input_sha256: hash(complete) })),
    maximum_embedding_tokens: longest.embedding_tokens, longest_chunk_id: longest.chunk_id,
    embedding: { model: embedded.model, truncate: false, runtime_limit: runtime.context_length,
      prompt_eval_count: embedded.prompt_eval_count,
      runtime_minus_local_tokens: embedded.prompt_eval_count - longest.embedding_tokens,
      count_note: 'Local tokenizer and runtime counts are recorded separately. Full input was accepted with truncate:false.',
      vector_dimensions: embedded.embeddings[0].length,
      vector_sha256: hash(JSON.stringify(embedded.embeddings[0])) },
    reranker: { model: props.model_alias, context_limit: props.default_generation_settings.n_ctx,
      query, query_tokens: queryTokens, maximum_document_tokens: rerankLongest.reranker_tokens,
      longest_chunk_id: rerankLongest.chunk_id, result: reranked },
    real_embedding_requests: 1, real_rerank_requests: 1, real_tokenize_requests: inputs.length + 1,
    passed: true, limitation: 'Budget validation uses the recorded query; later retrieval must budget its actual query independently.' };
  await save(budgetPath, budget);
}
const observed = [
  ['DOC0027-NOTICE', '印发与施行日期分开，通知完整保留。'],
  ['DOC0027-K001', '目的、适用对象及依据完整，单条结构保留。'],
  ['DOC0027-K004', '四项申请条件及附件指向完整。'],
  ['DOC0027-K005', '十项材料、份数和外委能力条件同片保留。'],
  ['DOC0027-K006', '延续或重新申请条件、除外项及近5年信息要求保留；第五条材料仍需跨条检索，不自行扩写。'],
  ['DOC0027-K008', '当场更正、补正期限、逾期受理及书面凭证要求同片保留。'],
  ['DOC0027-K013', '20/10工作日、批准与告知条件、检验检测评审不计时例外同片保留。'],
  ['DOC0027-K014', '许可证项目和TXTX####—*****五个星号原样保留。'],
  ['DOC0027-K015', '5年、届满60工作日前申请及名称变化不改有效期例外同片保留。'],
  ['DOC0027-K023', '撤销情形、欺骗贿赂应当撤销及3年限制同片保留。'],
  ['DOC0027-K026', '最短业务片完整保留解释机关，不因短而合并。'],
  ['DOC0027-K031', '最长业务片保留7列表头、原生合并、空格未知及受理机构填写区说明。'],
  ['DOC0027-K035', '统计表两个不同分母、空白格和纵向合并保留，不推断填值。'],
  ['DOC0027-S0035-T01-G007-009', 'LTE三类设备及合并产品编号、适用范围、执行标准和更新表注同片保留。'],
  ['DOC0027-S0035-T02-G089-089', 'LTE检验过程专用测试软件的设备要求和备注仍空白，不推断无要求。'],
  ['DOC0027-S0035-T03-G003-003', '关键项标识、质量体系对象和七部分审查及不合格项阈值共同前提同片保留。'],
].map(([id, observation]) => {
  const check = checks.find(item => item.knowledge_point_id === id);
  assert.ok(check);
  return { knowledge_point_id: id, chunk_id: check.chunk_id,
    actual_text_sha256: check.actual_text_sha256, observation };
});
const evidence = { reviewed_at: at, doc_id: doc.doc_id, phase: formal ? 'formal' : 'trial',
  review_script: { path: 'review-doc0027-literal-trial.mjs',
    sha256: hash(await readFile(new URL(import.meta.url))) },
  dataset_id: actual.dataset_id, document_id: actual.document_id,
  master: manifest.master, input: manifest.input,
  input_manifest: { path: manifestPath, sha256: hash(await bytes(manifestPath)) },
  actual: { path: actualPath, sha256: hash(actualBytes) },
  structure_decision: structure.structure_decision,
  pipeline_id: actual.pipeline_id, pipeline_version_id: actual.pipeline_version_id,
  budget_evidence: { path: budgetPath, sha256: hash(await bytes(budgetPath)) },
  exported_chunks: 205, accepted_business_chunks: 200, checks,
  current_close_read: { business_chunks: observed.length, observations: observed,
    metadata_chunks: metadata.length,
    scope: 'Current full-text spot readings of actual chunks, backed by complete deterministic master comparison and reused source semantic judgments; no new original-page visual review.' },
  metadata: metadata.map((chunk, index) => ({ chunk_id: chunk.id, heading: metadataTitles[index],
    content_sha256: hash(textOf(chunk)), reason: 'Scope, directory, empty parent heading or provenance only; not independent business evidence.' })),
  inspection_method: 'All 205 actual texts compared against real component debug. All 200 business chunks independently reconstructed from the unchanged master with their full ancestor headings and parent text. Only empty lines ignored, no Markdown punctuation removed. Qualified source semantic reviews and source adjudications reused after candidate, native-cell, shared-context, prompt, rules and source identity checks.',
  inspection_limit: 'This is semantic evidence reuse plus full actual fidelity checking, not 200 new independent visual transcriptions or model reviews. Existing visual records retain their bounded observations.',
  new_semantic_requests: 0, reused_semantic_batches: batches.size,
  quality_accepted: false, formal_import: false, retrieval_accepted: false,
  final_count_eligible: false };
  if (accept) {
  const base = `/datasets/${actual.dataset_id}/documents/${actual.document_id}`;
  const allChunks = async () => {
    const result = [];
    for (let page = 1; ; page++) {
      const next = rows(await api(`${base}/chunks?page=${page}&page_size=100`));
      result.push(...next);
      if (next.length < 100) return result;
    }
  };
  const downloaded = Buffer.from(await (await api(base, 'GET', undefined, true)).arrayBuffer());
  assert.equal(hash(downloaded), manifest.input.sha256);
  const before = await allChunks();
  assert.equal(before.length, 205);
  for (const original of actual.chunks) {
    const now = before.find(item => item.id === original.id);
    assert.ok(now);
    assert.equal(textOf(now), textOf(original));
    assert.ok(now.available || metadata.some(item => item.id === now.id));
  }
  const toExclude = before.filter(chunk => chunk.available && metadata.some(item => item.id === chunk.id));
  if (toExclude.length) await api(`${base}/chunks`, 'PATCH', { chunk_ids: toExclude.map(chunk => chunk.id), available: false });
  const after = await allChunks();
  assert.equal(after.length, 205);
  for (const original of actual.chunks) {
    const now = after.find(item => item.id === original.id);
    assert.ok(now);
    assert.equal(textOf(now), textOf(original));
    assert.equal(now.available, !metadata.some(item => item.id === now.id));
  }
  evidence.actual_after_metadata_exclusion = after;
  evidence.metadata_exclusion_verified = true;
  evidence.quality_accepted = true;
  await save(evidencePath, evidence);
  const ledger = await load('00-control/successor-import-ledger.json');
  const record = ledger.documents.find(item => item.document_id === actual.document_id);
  assert.ok(record);
  record.status = 'chunk-quality-accepted';
  record.quality_evidence = evidencePath;
  record.quality_evidence_sha256 = hash(await bytes(evidencePath));
  record.reviewed_at = at;
  await save('00-control/successor-import-ledger.json', ledger);
  if (formal) {
    record.status = 'chunk-quality-accepted';
    structure.formal_quality_evidence = { path: evidencePath, sha256: record.quality_evidence_sha256,
      dataset_id: actual.dataset_id, document_id: actual.document_id, reviewed_at: at };
    structure.formal_import_status = '正式入库切片质量通过；检索/引用/无证据回答待验收';
    doc.status = '正式切片质量通过，待检索验收';
    doc.formal_import = { dataset_id: actual.dataset_id, document_id: actual.document_id,
      evidence_path: evidencePath, evidence_sha256: record.quality_evidence_sha256,
      chunks: 205, business_chunks: 200, excluded_metadata_chunks: 5 };
    doc.final_count_eligible = false;
    doc.exclusion_reason = '正式入库切片质量已通过；文档级检索、引用及无证据回答验收尚未完成。';
  } else {
    structure.previous_trial_quality_evidence ||= structure.trial_quality_evidence;
    structure.trial_quality_evidence = { path: evidencePath, sha256: record.quality_evidence_sha256,
      document_id: actual.document_id, reviewed_at: at };
    structure.current_trial = { dataset_id: actual.dataset_id, document_id: actual.document_id,
      master_sha256: doc.sha256, input_sha256: manifest.input.sha256, input_manifest_path: manifestPath,
      chunks: 205, business_chunks: 200, excluded_metadata_chunks: 5, quality_accepted: true,
      pipeline_id: actual.pipeline_id, pipeline_version_id: actual.pipeline_version_id,
      evidence_path: evidencePath, evidence_sha256: record.quality_evidence_sha256 };
    structure.trial_status = '保真入库副本隔离试切通过；200业务片完整，5非业务片停用检索';
    doc.status = '试切通过';
    doc.final_count_eligible = false;
    doc.exclusion_reason = '当前保真副本隔离试切通过；正式导入、检索/引用/无证据回答未验收，不计最终有效量。';
  }
  await save('00-control/document-register.json', registry);
} else {
  await save('05-review/DOC0027-literal-trial-audit-2026-11-17.json', evidence);
}
console.log(JSON.stringify({ doc_id: doc.doc_id, phase: formal ? 'formal' : 'trial',
  exported: 205, complete_business_units: checks.length,
  semantic_pass_reused: 198, faithful_source_adjudications_reused: 2, batches_reused: batches.size,
  maximum_tokens_with_filename: budget.maximum_embedding_tokens, quality_accepted: accept,
  evidence: accept ? evidencePath : '05-review/DOC0027-literal-trial-audit-2026-11-17.json' }));
