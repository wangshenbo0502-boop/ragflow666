import { api, hash, load, originalDataset, rows, save } from './run.mjs';

const bank = await load('00-control/question-bank.json');
const expectations = await load('00-control/retrieval-expectations.json');
const ledger = await load('00-control/original-import-ledger.json');
const documentIDs = new Map(ledger.documents.map(doc => [doc.document_id, doc.doc_id]));
const parameters = { page_size: 5, knn_top_k: 32, knn_num_candidates: 100, use_kg: false };
const manifestPath = '00-control/retrieval-run-manifest.json';
const resultsPath = '00-control/retrieval-run-results.json';
const signature = hash(JSON.stringify({ bank, expectations, parameters, dataset: originalDataset }));
const previous = await load(manifestPath).catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return null;
});
if (previous && previous.signature !== signature) {
  throw new Error('Frozen test inputs changed. Preserve this run and explicitly create a new audit.');
}
const manifest = previous || {
  started_at: new Date().toISOString(), dataset_id: originalDataset,
  signature, parameters, question_count: bank.questions.length,
  scope: 'Retrieval only. Document identity is diagnostic, not sufficient evidence or answer-quality acceptance.',
  holdout_policy: 'All 60 questions run once at fixed parameters; no tuning or repeat scoring on holdout questions.'
};
await save(manifestPath, manifest);
const results = await load(resultsPath).catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return [];
});
for (let start = 0; start < bank.questions.length; start += 5) {
  for (const [testID, domain, kind, question] of bank.questions.slice(start, start + 5)) {
    if (results.some(result => result.test_id === testID && !result.error)) continue;
    let result;
    try {
      const response = await api('/datasets/search', 'POST', {
        dataset_ids: [originalDataset], question, ...parameters
      });
      await save(`00-control/retrieval-raw/${testID}.json`, response);
      const top5 = rows(response).map((chunk, index) => ({
        rank: index + 1, chunk_id: chunk.id, document_id: chunk.document_id,
        doc_id: documentIDs.get(chunk.document_id) || 'UNKNOWN',
        similarity: chunk.similarity, content: chunk.content || chunk.content_with_weight || ''
      }));
      const expected = expectations[testID];
      result = {
        test_id: testID, domain, kind, question, expected,
        checked_at: new Date().toISOString(), top5,
        required_document_ids_present: expected.doc_ids.every(id => top5.some(chunk => chunk.doc_id === id)),
        evidence_acceptance: 'PENDING_ARTICLE_AND_SEMANTIC_REVIEW',
        answer_quality: 'NOT_TESTED_NO_GENERATED_ANSWER',
        raw_path: `00-control/retrieval-raw/${testID}.json`
      };
    } catch (error) {
      result = { test_id: testID, domain, question, error: error.message };
    }
    const index = results.findIndex(item => item.test_id === testID);
    if (index >= 0) results[index] = result;
    else results.push(result);
    await save(resultsPath, results);
    console.log(JSON.stringify({ test_id: testID, top5: result.top5?.map(chunk => ({
      doc_id: chunk.doc_id, article: chunk.content.match(/^### (.+)$/m)?.[1]
    })), error: result.error }));
  }
}
manifest.finished_at = new Date().toISOString();
manifest.successful_requests = results.filter(result => !result.error).length;
manifest.failed_requests = results.filter(result => result.error).length;
await save(manifestPath, manifest);
