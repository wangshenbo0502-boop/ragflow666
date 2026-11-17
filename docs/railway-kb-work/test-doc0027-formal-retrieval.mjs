import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { api, hash, load, rows, save } from './run.mjs';

const appID = '3b0470c7c4fb414dab6d32c19dfee8da';
const sourcePath = '05-review/DOC0027-formal-retrieval-diagnostic-2026-11-17.json';
const source = await load(sourcePath);
const qualityPath = '05-review/DOC0027-formal-quality-2026-11-17.json';
const qualityBytes = await readFile(new URL(qualityPath, import.meta.url));
const quality = JSON.parse(qualityBytes);
const actual = await load('04-chunks/actual/DOC0027-successor-formal.json');
const ledger = await load('00-control/successor-import-ledger.json');
const formalRecord = ledger.documents.find(item => item.doc_id === 'DOC0027'
  && item.phase === 'formal' && item.document_id === source.document_id);
const appBefore = await api(`/searches/${appID}`);
const searchConfig = appBefore.search_config;

assert.equal(source.dataset_id, '09f44dca26524a8790913faca5b8265e');
assert.equal(source.document_id, '33ea398a0b4b4bfa8bc96a4278b3bd0a');
assert.equal(quality.quality_accepted, true);
assert.equal(quality.accepted_business_chunks, 200);
assert.equal(actual.phase, 'formal');
assert.equal(actual.document_id, source.document_id);
assert.equal(formalRecord?.status, 'chunk-quality-accepted');
assert.equal(searchConfig.use_rerank, true);
assert.match(searchConfig.rerank_id || '', /^[a-f0-9]{32}$/u);

const questions = [];
for (const item of source.questions) {
  const response = await api('/datasets/search', 'POST', {
    dataset_ids: [source.dataset_id],
    question: item.question,
    page_size: 5,
    knn_top_k: 128,
    knn_num_candidates: 256,
    use_kg: false,
    similarity_threshold: 0.1,
    vector_similarity_weight: 0.5,
    rerank_candidates_count: 64,
    rerank_id: searchConfig.rerank_id,
  });
  const top5 = rows(response).slice(0, 5).map((chunk, index) => {
    const text = chunk.content || chunk.content_with_weight || '';
    return {
      rank: index + 1,
      chunk_id: chunk.id,
      document_id: chunk.document_id,
      point_id: text.match(/DOC0027-(?:[A-Z0-9-]+)/u)?.[0] || null,
      similarity: chunk.similarity,
      text,
      text_sha256: hash(text),
    };
  });
  const requiredEvidence = item.required_points.map(pointID => {
    const hits = top5.filter(chunk => chunk.document_id === source.document_id
      && chunk.point_id === pointID);
    assert.equal(hits.length, 1, `${item.test_id}: required point ${pointID} not uniquely in Top-5`);
    return { point_id: pointID, chunk_id: hits[0].chunk_id };
  });
  if (item.test_id === 'N01') {
    const target = top5.find(chunk => chunk.point_id === item.required_points[0]);
    assert.ok(target.text.includes('〔原表空白〕'), 'N01 must retrieve the explicit source blank');
    assert.ok(!/无要求|不需要|无需配置/u.test(target.text));
  }
  questions.push({
    test_id: item.test_id,
    question: item.question,
    required_points: item.required_points,
    top5,
    required_evidence: requiredEvidence,
    retrieval_passed: true,
  });
}

const appAfter = await api(`/searches/${appID}`);
assert.equal(hash(JSON.stringify(appBefore)), hash(JSON.stringify(appAfter)),
  'Search application configuration changed during the test');
const checkedAt = new Date().toISOString();
const evidence = {
  checked_at: checkedAt,
  scope: 'DOC0027 formal XH retrieval diagnostic using the currently enabled reranker; no generated answers or citation review.',
  dataset_id: source.dataset_id,
  document_id: source.document_id,
  source_diagnostic: {
    path: sourcePath,
    sha256: hash(await readFile(new URL(sourcePath, import.meta.url))),
  },
  formal_chunk_quality: {
    path: qualityPath,
    sha256: hash(qualityBytes),
    accepted_business_chunks: quality.accepted_business_chunks,
    phase: actual.phase,
    ledger_status: formalRecord.status,
  },
  rerank: {
    enabled: searchConfig.use_rerank,
    model_id: searchConfig.rerank_id,
    candidate_count: 64,
  },
  parameters: {
    page_size: 5,
    knn_top_k: 128,
    knn_num_candidates: 256,
    use_kg: false,
    similarity_threshold: 0.1,
    vector_similarity_weight: 0.5,
  },
  questions,
  passed: questions.length === 5 && questions.every(item => item.retrieval_passed),
  application_unchanged: true,
  answer_quality_accepted: false,
  citation_quality_accepted: false,
  final_regression_accepted: false,
};
const evidencePath = `05-review/DOC0027-formal-retrieval-current-${checkedAt.replaceAll(':', '-').replaceAll('.', '-')}.json`;
await save(evidencePath, evidence);
console.log(JSON.stringify({
  checked_at: checkedAt,
  evidence: evidencePath,
  rerank_enabled: evidence.rerank.enabled,
  questions_passed: questions.filter(item => item.retrieval_passed).length,
  questions_total: questions.length,
  required_evidence: questions.map(item => ({
    test_id: item.test_id,
    points: item.required_evidence.map(point => point.point_id),
  })),
  answer_and_citation_review: 'pending',
}, null, 2));
