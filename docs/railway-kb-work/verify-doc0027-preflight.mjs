import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Tokenizer } from './06-tools/node_modules/@huggingface/tokenizers/dist/tokenizers.mjs';
import { hash, load, root, save } from './run.mjs';

const at = new Date().toISOString();
const docId = process.argv[2] || 'DOC0027';
assert.ok(['DOC0026', 'DOC0027'].includes(docId));
const folder = `05-review/${docId}-preflight-${at.replaceAll(/[:.]/gu, '-')}`;
const bytes = relative => readFile(path.resolve(root, relative));
const normalize = text => text.replaceAll('\\|', '|').replaceAll('<br>', '\n').replaceAll(/\s+/gu, '');
const doc = (await load('00-control/document-register.json')).find(item => item.doc_id === docId);
assert.ok(doc);
const expectedPath = doc.structure_v3.expected_path;
const nativePath = doc.structure_v2.source_audit;
const expected = await load(expectedPath);
const native = await load(nativePath);
const master = await readFile(path.resolve(root, doc.master_path), 'utf8');
const bindings = {
  original: { path: doc.original_path, sha256: hash(await bytes(doc.original_path)) },
  master: { path: doc.master_path, sha256: hash(master) },
  expected: { path: expectedPath, sha256: hash(await bytes(expectedPath)) },
  native: { path: nativePath, sha256: hash(await bytes(nativePath)) },
  original_pdf: { path: `05-review/successor-visual/${doc.source_id}-original.pdf`,
    sha256: hash(await bytes(`05-review/successor-visual/${doc.source_id}-original.pdf`)) },
};
assert.equal(bindings.original.sha256, expected.source_sha256);
assert.equal(bindings.original.sha256, native.original_sha256);
assert.equal(bindings.master.sha256, doc.sha256);
assert.equal((master.match(/^# /gmu) || []).length, 1);
assert.equal(expected.knowledge_points.length, doc.structure_v3.knowledge_points);
assert.equal(new Set(expected.knowledge_points.map(point => point.knowledge_point_id)).size,
  expected.knowledge_points.length);
const headings = [...master.matchAll(/^(#{1,6}) (.+)$/gmu)];
assert.equal(headings.filter(match => match[1] === '###').length, expected.knowledge_points.length);
for (let i = 1; i < headings.length; i++) {
  assert.ok(headings[i][1].length <= headings[i - 1][1].length + 1, 'Heading level skipped');
}
const verificationPath = '05-review/successor-semantic-review/cache-verification.json';
const verification = await load(verificationPath);
const adjudicationPath = '05-review/successor-semantic-adjudication-v2.json';
const adjudication = await load(adjudicationPath);
const alignmentPath = doc.structure_v3.master_alignment?.evidence_path;
const alignment = alignmentPath ? (await load(alignmentPath)).documents.find(item => item.doc_id === doc.doc_id) : null;
if (alignment) {
  assert.equal(alignment.after_master_sha256, bindings.master.sha256);
  assert.equal(alignment.expected_sha256, bindings.expected.sha256);
  assert.equal(alignment.native_sha256, bindings.native.sha256);
  assert.equal(alignment.original_sha256, bindings.original.sha256);
  assert.equal(alignment.all_expected_candidate_texts_unchanged, true);
}
const batches = new Map();
for (const item of verification.batch_evidence.filter(item => item.doc_id === doc.doc_id)) {
  assert.equal(hash(await bytes(item.path)), item.sha256, `Cached batch changed: ${item.path}`);
  batches.set(item.path, await load(item.path));
}
const tokenizerPath = path.resolve(root, '../../deps/huggingface.co/BAAI/bge-m3/tokenizer.json');
const tokenizerBytes = await readFile(tokenizerPath);
const tokenizer = new Tokenizer(JSON.parse(tokenizerBytes), {});
const points = [];
for (const point of expected.knowledge_points) {
  const start = master.indexOf(`### ${point.knowledge_point_id} `);
  assert.ok(start >= 0);
  const next = master.indexOf('\n### ', start + 1);
  const section = master.slice(start, next < 0 ? undefined : next);
  // Article text can be carried in the heading; compare the entire section.
  assert.ok(normalize(section).includes(normalize(point.text)), `${point.knowledge_point_id}: incomplete master section`);
  const judgment = verification.judgments.find(item => item.doc_id === doc.doc_id
    && item.knowledge_point_id === point.knowledge_point_id);
  assert.ok(judgment);
  const batch = batches.get(judgment.evidence_path);
  assert.ok(batch);
  const input = batch.input.items.find(item => item.knowledge_point_id === point.knowledge_point_id);
  assert.ok(input);
  let candidate = point.text;
  for (const line of input.candidate_shared_context_lines) {
    assert.ok(candidate.includes(line + '\n'));
    candidate = candidate.replace(line + '\n', '');
  }
  assert.equal(candidate, input.candidate_remaining_text);
  const decision = adjudication.decisions.find(item => item.knowledge_point_id === point.knowledge_point_id);
  if (judgment.status !== 'PASS') {
    assert.equal(decision?.decision, 'FAITHFUL_SOURCE_RETAIN');
    assert.equal(decision.candidate_text_sha256, hash(point.text));
    for (const [key, binding] of [['original', bindings.original], ['master', bindings.master],
      ['native', bindings.native], ['expected', bindings.expected]]) {
      const adjudicatedHash = key === 'master' && alignment
        ? alignment.before_master_sha256 : binding.sha256;
      assert.equal(decision[`${key}_sha256`], adjudicatedHash);
    }
  }
  const table = native.tables.find(item => item.table_id === point.native_table_id);
  for (const cell of [...(point.native_cell_mapping || []), ...(point.external_merge_origins || [])]) {
    const sourceCell = table?.rows.flatMap(row => row.cells).find(item => item.cell_id === cell.cell_id);
    assert.deepEqual(cell, sourceCell, `Native cell differs: ${cell.cell_id}`);
  }
  for (const context of point.common_context || []) {
    const sourceBlock = native.blocks.find(block => block.type === 'paragraph' && block.paragraph === context.paragraph);
    assert.ok(sourceBlock);
    assert.equal(normalize(sourceBlock.text), normalize(context.text));
    assert.ok(point.text.includes(context.text.trim()));
  }
  const text = `文档：${doc.title}（${doc.doc_id}）；版本：${doc.version}；来源：${doc.source_id}；定位：${point.source_location}\n知识点：${point.knowledge_point_id} ${point.heading}\n${point.text}`;
  const count = tokenizer.encode(text).ids.length;
  assert.equal(count, point.embedding_tokens_with_full_prefix);
  assert.ok(count < 8192);
  points.push({ knowledge_point_id: point.knowledge_point_id, text_sha256: hash(point.text),
    embedding_tokens: count, model_status: judgment.status, boundary: judgment.boundary,
    semantic_evidence_path: judgment.evidence_path, adjudication: decision?.decision,
    boundary_review: judgment.status === 'PASS' ? judgment.finding : decision.rationale,
    source_location: point.source_location, text });
}
for (const block of expected.paragraph_coverage) {
  assert.notEqual(block.classification, 'uncovered-substantive-paragraph');
  assert.ok(normalize(master).includes(normalize(block.text)));
}
let nonemptyCells = 0;
for (const table of native.tables) {
  const text = normalize(expected.knowledge_points.filter(point => point.native_table_id === table.table_id)
    .map(point => point.text).join('\n'));
  for (const cell of table.rows.flatMap(row => row.cells)) {
    if (!normalize(cell.text)) continue;
    nonemptyCells++;
    assert.ok(text.includes(normalize(cell.text)), `Cell coverage missing: ${cell.cell_id}`);
  }
}
if (docId === 'DOC0027') {
const excerptPath = '05-review/successor-visual/S0035-T03-R88C3-excerpt.json';
const excerpt = await load(excerptPath);
assert.equal(excerpt.source_sha256, bindings.original.sha256);
assert.equal(excerpt.source_text_matches_native, true);
assert.equal(excerpt.excerpt_text_matches_source, true);
assert.equal(hash(await readFile(excerpt.pdf_path)), excerpt.pdf_sha256);
const excerptVisual = { ...excerpt, visual_checked_at: at,
  png_path: '05-review/successor-visual/S0035-T03-R88C3-excerpt.png',
  png_sha256: hash(await bytes('05-review/successor-visual/S0035-T03-R88C3-excerpt.png')),
  visual_review_status: 'Viewed: complete text legible, including the final character of 精神慰藉.',
  source_unchanged: true,
  limitation: 'Display-only excerpt from the readonly original range, not an official replacement or a claim about the cause of clipping.' };
await save(`${folder}/excerpt-visual-review.json`, excerptVisual);
const observations = new Map([
  [15, 'Prior visual review: LTE dedicated test software requirement and remark cells are blank; no values inferred.'],
  [25, 'Section 6.3 delivery inspection: three items, first key; section 7 safety/civilized production: fourteen items; 7.1 item 4 continues on page 26.'],
  [26, 'Continuation retains prohibitions concerning equipment and data; 7.1 items 5-9, 7.2 two items, 7.3 three items. Final cell text clipped in full-document rendering; resolved by readonly native-cell excerpt.'],
  [27, 'Blank body with page number only; not treated as lost substantive text.'],
  [28, 'Application form includes applicant/unit/agent/application/materials; receiving-authority fields remain distinct.'],
  [29, 'Receipt signature and date fields only.'],
  [30, 'Six enterprise-review form items; answer cells unfilled.'],
  [31, 'Blank equipment form, eight headers retained.'],
  [32, 'Personnel details has twelve headers; statistics has five columns and a merged blank total column.'],
]);
const pages = [];
for (let page = 1; page <= 32; page++) {
  const imagePath = `05-review/successor-visual/S0035-page-${String(page).padStart(2, '0')}.png`;
  pages.push({ page, image_path: imagePath, image_sha256: hash(await bytes(imagePath)),
    observation: observations.get(page) || 'Page viewed in the preceding continuation; detailed page-specific notes were not retained in the handover.',
    evidence_origin: page <= 24 ? 'Previous continuation visual inspection, carried forward in handover'
      : 'Previous continuation pages 25-32 visual inspection, carried forward in handover' });
}
await save(`${folder}/visual-review.json`, { recorded_at: at, doc_id: doc.doc_id, bindings, pages,
  full_document_pages_viewed: 32, excerpt_review_path: `${folder}/excerpt-visual-review.json`,
  scope: 'All rendered pages were viewed in the continuing task. Records distinguish retained observations from pages lacking detailed notes. This does not claim every cell was independently visually transcribed.',
  original_unchanged: true });
} else {
  const notesPath = '05-review/successor-visual/DOC0026-page-observations-2026-11-17.json';
  const notes = await load(notesPath);
  const boundedPath = '05-review/successor-visual/bounded-review-v1.json';
  const bounded = (await load(boundedPath)).documents.find(item => item.doc_id === docId);
  assert.equal(notes.doc_id, docId);
  assert.equal(notes.original_sha256, bindings.original.sha256);
  assert.equal(notes.pdf_sha256, bindings.original_pdf.sha256);
  assert.equal(bounded.original_sha256, bindings.original.sha256);
  assert.equal(bounded.pdf_sha256, bindings.original_pdf.sha256);
  assert.equal(bounded.expected_sha256, bindings.expected.sha256);
  assert.equal(bounded.native_sha256, bindings.native.sha256);
  const pages = [];
  for (let page = 1; page <= notes.total_pages; page++) {
    const note = notes.pages.find(item => item.page === page);
    assert.ok(note?.observation && note.evidence_origin);
    const imagePath = `05-review/successor-visual/${doc.source_id}-page-${String(page).padStart(2, '0')}.png`;
    const imageHash = hash(await bytes(imagePath));
    if (note.evidence_origin === 'bounded-review-v1') {
      assert.equal(bounded.pages.find(item => item.page === page)?.image_sha256, imageHash);
    }
    pages.push({ ...note, image_path: imagePath, image_sha256: imageHash });
  }
  assert.equal(pages.length, 37);
  assert.equal(notes.pages.length, pages.length);
  await save(`${folder}/visual-review.json`, { recorded_at: at, doc_id: docId, bindings, pages,
    full_document_pages_viewed: pages.length, notes_path: notesPath,
    notes_sha256: hash(await bytes(notesPath)), reused_bounded_evidence: boundedPath,
    scope: notes.scope, original_unchanged: true });
}

const key = (await readFile(path.resolve(root, '../../.cache/reranker.api-key'), 'utf8')).trim();
async function reranker(route, body) {
  const response = await fetch(`http://127.0.0.1:8082${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  assert.equal(response.status, 200, `Reranker ${route} status ${response.status}`);
  return response.json();
}
const props = await reranker('/props');
const contextLimit = props.default_generation_settings.n_ctx;
assert.equal(props.model_alias, 'bge-reranker-v2-m3');
const query = `${docId === 'DOC0026' ? '信号' : '通信'}设备生产企业的质量保证体系审查有哪些条件、例外和关键项目？`;
const queryTokens = (await reranker('/tokenize', { content: query, add_special: false })).tokens.length;
for (const point of points) {
  point.reranker_document_tokens = (await reranker('/tokenize', { content: point.text, add_special: false })).tokens.length;
  point.query_pair_tokens_with_reserve = point.reranker_document_tokens + queryTokens + 8;
  assert.ok(point.query_pair_tokens_with_reserve < contextLimit, `${point.knowledge_point_id}: reranker budget exceeded`);
}
const longest = points.reduce((best, item) => item.reranker_document_tokens > best.reranker_document_tokens ? item : best);
const probe = await reranker('/v1/rerank', { model: props.model_alias, query,
  documents: [longest.text], top_n: 1 });
assert.equal(probe.results.length, 1);
assert.ok(Number.isFinite(probe.results[0].relevance_score));
assert.ok(probe.usage.prompt_tokens >= longest.reranker_document_tokens + queryTokens,
  'Reranker usage suggests truncation');
assert.ok(probe.usage.prompt_tokens < contextLimit);
await save(`${folder}/reranker-budget.json`, { checked_at: at, doc_id: doc.doc_id,
  model: props.model_alias, build_info: props.build_info, context_limit: contextLimit,
  tokenization_requests: points.length + 1, new_rerank_requests: 1, query,
  query_tokens: queryTokens, reserved_pair_special_tokens: 8, longest_id: longest.knowledge_point_id,
  longest_document_tokens: longest.reranker_document_tokens,
  real_probe_response: probe, candidate_budget_verified: true,
  limitation: 'Budget bound to current complete candidate prefixes and this query; inspect actual chunks and actual query lengths again after parsing. Not retrieval acceptance.',
  points: points.map(({ text, ...point }) => point) });
const report = { checked_at: at, doc_id: doc.doc_id, bindings,
  deterministic_checks: { unique_points: points.length, heading_levels_valid: true,
    paragraph_coverage: expected.paragraph_coverage.length, nonempty_native_cells: nonemptyCells,
    native_tables: native.tables.length, native_mapping_exact: true,
    candidate_sections_complete: true, tokenizer_sha256: hash(tokenizerBytes),
    embedding_maximum_tokens: Math.max(...points.map(point => point.embedding_tokens)),
    embedding_model_runtime_limit_verified: false },
  semantic_cache: { path: verificationPath, sha256: hash(await bytes(verificationPath)),
    master_alignment_path: alignmentPath,
    reused_batches: batches.size, pass: points.filter(point => point.model_status === 'PASS').length,
    adjudicated_faithful_source: points.filter(point => point.adjudication).length,
    adjudication_path: adjudicationPath, sha256_adjudication: hash(await bytes(adjudicationPath)),
    new_model_review_requests: 0 },
  long_boundary_reviews: points.filter(point => point.embedding_tokens > 900).map(({ text, ...point }) => point),
  visual_evidence: `${folder}/visual-review.json`,
  reranker_budget_evidence: `${folder}/reranker-budget.json`,
  candidate_reranker_budget_verified: true, source_original_changed: false,
  structure_accepted: false, formal_import: false, retrieval_accepted: false,
  remaining: ['Verify embedding runtime limit and non-truncating real probe.',
    'Bound current official version/effectiveness judgment to inspected sources; no global absence-of-amendment claim.',
    'Record structure decision before trial; inspect actual chunks and their budgets before formal import.'] };
await save(`${folder}/summary.json`, report);
console.log(JSON.stringify({ folder, points: points.length, long_points: report.long_boundary_reviews.length,
  semantic_pass: report.semantic_cache.pass, adjudicated: report.semantic_cache.adjudicated_faithful_source,
  native_cells: nonemptyCells, reranker_max_document_tokens: longest.reranker_document_tokens,
  reranker_usage: probe.usage, structure_accepted: false }));
