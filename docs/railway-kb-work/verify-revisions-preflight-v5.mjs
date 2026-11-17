import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { hash, load, root, save } from './run.mjs';
import { Tokenizer } from './06-tools/node_modules/@huggingface/tokenizers/dist/tokenizers.mjs';

const officialPath = process.argv[2];
assert.ok(officialPath, 'Provide freshly checked official-source evidence');
const at = new Date().toISOString();
const folder = `05-review/revision-preflight-v5-${at.replace(/[:.]/gu, '-')}`;
const bytes = relative => readFile(path.resolve(root, relative));
const registry = await load('00-control/document-register.json');
const official = await load(officialPath);
const semanticPath = '05-review/revision-semantic-v5/verification.json';
const semantic = await load(semanticPath);
const visualPath = '05-review/revision-visual-v5.json';
const visual = await load(visualPath);
assert.equal(semantic.pass, 63);
assert.equal(semantic.fail + semantic.pending, 0);
const tokenizerBytes = await bytes('../../deps/huggingface.co/BAAI/bge-m3/tokenizer.json');
const tokenizer = new Tokenizer(JSON.parse(tokenizerBytes), {});
const key = (await bytes('../../.cache/reranker.api-key')).toString('utf8').trim();
async function request(base, route, body, authenticated = false) {
  const response = await fetch(`${base}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json',
      ...(authenticated ? { Authorization: `Bearer ${key}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  assert.equal(response.status, 200, `${route}: HTTP ${response.status}`);
  return response.json();
}
const rerank = (route, body) => request('http://127.0.0.1:8082', route, body, true);
const ollama = (route, body) => request('http://127.0.0.1:11434', route, body);
const props = await rerank('/props');
assert.equal(props.model_alias, 'bge-reranker-v2-m3');
const rerankLimit = props.default_generation_settings.n_ctx;
const show = await ollama('/api/show', { model: 'bge-m3' });
const declaredLimit = show.model_info['bert.context_length'];
const compact = text => text.replace(/\s+/gu, '');
const decisions = [];
for (const docID of ['DOC0022', 'DOC0023']) {
  const doc = registry.find(item => item.doc_id === docID);
  const expectedBytes = await bytes(doc.revision_v5.expected_path);
  const expected = JSON.parse(expectedBytes);
  const masterBytes = await bytes(doc.master_path);
  const master = masterBytes.toString('utf8');
  assert.equal(hash(masterBytes), doc.sha256);
  assert.equal(expected.master_sha256, doc.sha256);
  assert.equal(hash(await bytes(doc.normalized_path)), expected.source_sha256);
  const source = official.records.find(item => item.doc_id === docID);
  assert.equal(source.master_sha256, doc.sha256);
  assert.equal(source.expected_sha256, hash(expectedBytes));
  assert.equal(source.catalog_link_verified, true);
  assert.ok(source.comparisons.every(item => item.exact_ignoring_whitespace
    || (docID === 'DOC0022' && item.knowledge_point_id === 'DOC0022-K03' && item.quotes_only)));
  const pages = visual.records.find(item => item.doc_id === docID);
  assert.equal(pages.viewed_pages.length, pages.pages);
  assert.equal(hash(await bytes(pages.pdf_path)), pages.pdf_sha256);
  assert.equal(source.attachments[0].sha256, pages.pdf_sha256);
  for (const page of pages.viewed_pages) {
    assert.equal(page.viewed, true);
    assert.equal(hash(await bytes(page.image_path)), page.image_sha256);
  }
  const headings = [...master.matchAll(/^(#{1,6}) (.+)$/gmu)];
  assert.equal(headings.filter(item => item[1] === '#').length, 1);
  for (let i = 1; i < headings.length; i++) {
    assert.ok(headings[i][1].length <= headings[i - 1][1].length + 1);
  }
  assert.equal(new Set(expected.points.map(point => point.knowledge_point_id)).size, expected.points.length);
  const filename = `${path.basename(doc.master_path, '.md')}_结构通过_${doc.sha256.slice(0, 12)}.md`;
  const query = docID === 'DOC0022'
    ? '铁路机车车辆行政许可的条件、有效期、延期和除外事项是什么？'
    : '铁路专用设备缺陷召回的责任主体、计划报告期限和处罚条件是什么？';
  const queryTokens = (await rerank('/tokenize', { content: query, add_special: false })).tokens.length;
  const pointChecks = [];
  const batches = new Map();
  for (const point of expected.points) {
    assert.equal(hash(point.source_body), point.source_body_sha256);
    const heading = `### ${point.heading_path.at(-1)}`;
    const start = master.indexOf(heading);
    assert.ok(start >= 0);
    const remainder = master.slice(start + heading.length);
    const end = remainder.search(/\n#{1,3} /u);
    const section = heading + (end < 0 ? remainder : remainder.slice(0, end));
    assert.ok(section.includes(point.text), `${point.knowledge_point_id}: incomplete section`);
    assert.ok(compact(point.body).includes(compact(point.source_body)));
    const judgment = semantic.judgments.find(item => item.knowledge_point_id === point.knowledge_point_id);
    assert.equal(judgment?.status, 'PASS');
    if (!batches.has(judgment.evidence_path)) batches.set(judgment.evidence_path, await load(judgment.evidence_path));
    const batch = batches.get(judgment.evidence_path);
    assert.equal(batch.model, semantic.model);
    assert.equal(batch.rules_sha256, semantic.rules_sha256);
    assert.equal(batch.prompt_sha256, semantic.prompt_sha256);
    const reviewed = batch.input.items.find(item => item.knowledge_point_id === point.knowledge_point_id);
    assert.equal(reviewed.candidate_text, point.text);
    assert.deepEqual(reviewed.dependencies, point.dependencies);
    assert.equal(batch.input.source_articles.find(item => item.article === point.article).original_body, point.source_body);
    for (const dependency of point.dependencies) {
      const article = expected.points.find(item => item.article === dependency.article);
      assert.ok(article, `${point.knowledge_point_id}: unresolved dependency`);
      assert.ok(compact(point.text).includes(compact(article.source_body)));
    }
    const complete = `${filename}\n${point.heading_path.map((label, index) => `${'#'.repeat(index + 1)} ${label}`).join('\n')}\n${point.text}`;
    const embeddingTokens = tokenizer.encode(complete).ids.length;
    const rerankTokens = (await rerank('/tokenize', { content: complete, add_special: false })).tokens.length;
    assert.ok(rerankTokens + queryTokens + 8 < rerankLimit);
    pointChecks.push({ knowledge_point_id: point.knowledge_point_id, source_location: point.source_location,
      candidate_sha256: hash(point.text), complete_input_sha256: hash(complete),
      embedding_tokens: embeddingTokens, reranker_tokens: rerankTokens, semantic_status: judgment.status,
      boundary: judgment.boundary, finding: judgment.finding, semantic_evidence: judgment.evidence_path,
      complete });
  }
  const longest = pointChecks.reduce((best, point) => point.embedding_tokens > best.embedding_tokens ? point : best);
  const embedded = await ollama('/api/embed', { model: 'bge-m3', input: longest.complete, truncate: false });
  assert.equal(embedded.embeddings.length, 1);
  assert.equal(embedded.embeddings[0].length, 1024);
  assert.ok(embedded.embeddings[0].every(Number.isFinite));
  const runtime = (await ollama('/api/ps')).models.find(item => item.name.startsWith('bge-m3'));
  const runtimeLimit = runtime?.context_length ?? runtime?.details?.context_length;
  assert.ok(runtimeLimit > longest.embedding_tokens && runtimeLimit <= declaredLimit);
  assert.ok(embedded.prompt_eval_count >= longest.embedding_tokens - 8);
  const rerankLongest = pointChecks.reduce((best, point) => point.reranker_tokens > best.reranker_tokens ? point : best);
  const reranked = await rerank('/v1/rerank', { model: props.model_alias, query,
    documents: [rerankLongest.complete], top_n: 1 });
  assert.equal(reranked.results.length, 1);
  assert.ok(Number.isFinite(reranked.results[0].relevance_score));
  assert.ok(reranked.usage.prompt_tokens >= rerankLongest.reranker_tokens + queryTokens);
  assert.ok(reranked.usage.prompt_tokens < rerankLimit);
  const dependencies = [officialPath, semanticPath, visualPath, ...batches.keys(),
    ...(doc.revision_v5.context_adjudication_path ? [doc.revision_v5.context_adjudication_path] : [])];
  const decision = { decided_at: at, doc_id: docID,
    decision: 'STRUCTURE_ACCEPTED_FOR_FAITHFUL_SOURCE_TRIAL', structure_accepted: true,
    trial_accepted: false, formal_import: false, retrieval_accepted: false,
    bindings: {
      master: { path: doc.master_path, sha256: doc.sha256 },
      expected: { path: doc.revision_v5.expected_path, sha256: hash(expectedBytes) },
      original: { path: doc.original_path, sha256: hash(await bytes(doc.original_path)) },
      normalized: { path: doc.normalized_path, sha256: expected.source_sha256 },
      original_pdf: { path: pages.pdf_path, sha256: pages.pdf_sha256 },
    },
    deterministic_checks: { unique_points: expected.points.length, complete_sections: true,
      headings_valid: true, source_bodies_retained: true, dependencies_complete: true },
    semantic_review: { pass: expected.points.length, new_requests: 0, reused_batches: batches.size,
      model: semantic.model, rules_sha256: semantic.rules_sha256, prompt_sha256: semantic.prompt_sha256 },
    visual_review: { evidence: visualPath, pages_viewed: pages.pages, limitation: pages.limitation },
    source_version: { evidence: officialPath, current_catalog_verified: true,
      legal_currency_scope: source.source_status, exhaustive_later_notice_search: false,
      formal_source_gate: 'Official current-effective catalog explicitly lists this consolidated version; faithful-source ingestion permitted with recorded version and bounded currency statement.' },
    budgets: { tokenizer_sha256: hash(tokenizerBytes), embedding_runtime_limit: runtimeLimit,
      embedding_declared_limit: declaredLimit, maximum_prefixed_tokens: longest.embedding_tokens,
      longest_id: longest.knowledge_point_id, truncate: false,
      actual_evaluated_tokens: embedded.prompt_eval_count,
      vector_dimensions: embedded.embeddings[0].length,
      vector_sha256: hash(JSON.stringify(embedded.embeddings[0])), runtime_model: runtime,
      reranker_model: props.model_alias, reranker_context_limit: rerankLimit,
      maximum_reranker_document_tokens: rerankLongest.reranker_tokens, query, query_tokens: queryTokens,
      reserved_pair_special_tokens: 8, reranker_probe: reranked },
    points: pointChecks.map(({ complete, ...point }) => point),
    dependencies: await Promise.all(dependencies.map(async dependency => ({
      path: dependency, sha256: hash(await bytes(dependency)),
    }))),
    cost: { semantic_requests: 0, embedding_requests: 1, rerank_requests: 1,
      tokenization_requests: expected.points.length + 1, provider_cost: null },
    limitation: 'Structure and current official catalog eligibility only; actual chunks, formal ingestion, retrieval, citations and no-evidence answers require independent acceptance.',
  };
  const output = `${folder}/${docID}-structure-decision.json`;
  await save(output, decision);
  decisions.push({ doc, output, decision });
  console.log(JSON.stringify({ doc_id: docID, structure_accepted: true, points: expected.points.length,
    maximum_prefixed_tokens: longest.embedding_tokens, runtime_limit: runtimeLimit, evidence: output }));
}
for (const { doc, output } of decisions) {
  doc.revision_v5.structure_decision = { path: output, sha256: hash(await bytes(output)),
    master_sha256: doc.sha256, decided_at: at };
  doc.revision_v5.semantic_review = '当前63项全部PASS；哈希及依赖核验通过';
  doc.revision_v5.semantic_evidence_path = semanticPath;
  doc.revision_v5.structure_status = '结构通过；允许忠实原文隔离试切';
  doc.final_count_eligible = false;
  doc.exclusion_reason = '结构通过；当前版本真实试切、正式入库及检索验收尚未完成。';
}
await save('00-control/document-register.json', registry);
await save(`${folder}/summary.json`, { checked_at: at, documents: decisions.map(({ doc, output }) =>
  ({ doc_id: doc.doc_id, structure_accepted: true, evidence: output })), remote_mutation: false });
