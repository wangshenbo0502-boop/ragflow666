import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { api, hash, load, originalDataset, root, rows, save, table } from './run.mjs';

const norm = text => String(text).replace(/\*\*([^*]+)\*\*/gu, '$1')
  .replaceAll('`', '').replace(/\s+/gu, '');
const inputs = await load('00-control/acceptance-v3-context-inputs.json');
const results = await load('00-control/acceptance-v3-context-retrieval.json');
const register = await load('00-control/document-register.json');
const points = new Map();
const files = [];
for (const doc of register) {
  const expected = await load(doc.structure_v3.expected_path);
  const bytes = await readFile(path.join(root, doc.master_path));
  files.push({ doc_id: doc.doc_id, master_hash_matches: hash(bytes) === doc.sha256,
    expected_hash_matches: expected.master_sha256 === doc.sha256 });
  for (const point of expected.points) points.set(point.knowledge_point_id, point);
}
const audited = inputs.questions.map(question => {
  const result = results.find(item => item.test_id === question.test_id);
  const evidence = question.required.map(required => {
    const current = points.get(required.knowledge_point_id);
    const matching = result.top5.filter(chunk => chunk.knowledge_point_id === required.knowledge_point_id);
    const supporting = result.top5.filter(chunk => norm(chunk.content).includes(norm(required.evidence_text)));
    const currentSupporting = result.top5.filter(chunk => norm(chunk.content).includes(norm(current.body)));
    return { point: required.knowledge_point_id,
      frozen_body_matches_current: norm(current.body) === norm(required.evidence_text),
      frozen_body_sha256: hash(required.evidence_text), current_body_sha256: hash(current.body),
      id_ranks: matching.map(chunk => chunk.rank),
      frozen_body_ranks: supporting.map(chunk => chunk.rank),
      current_body_ranks: currentSupporting.map(chunk => chunk.rank) };
  });
  return { test_id: question.test_id, question: question.question, answerable: question.answerable,
    recorded_complete: result.evidence_complete,
    recomputed_frozen_complete: question.answerable ? evidence.every(item => item.frozen_body_ranks.length) : null,
    current_body_complete: question.answerable ? evidence.every(item => item.current_body_ranks.length) : null,
    evidence };
});
const report = { checked_at: new Date().toISOString(),
  scope: '保留冻结预期和原始成绩；另列当前正文比对，禁止用知识点ID代替完整证据。',
  files, frozen_signature: hash(JSON.stringify(inputs)),
  recorded_complete: audited.filter(item => item.recorded_complete).length,
  recomputed_frozen_complete: audited.filter(item => item.recomputed_frozen_complete).length,
  current_body_complete: audited.filter(item => item.current_body_complete).length,
  expectation_drift: audited.filter(item => item.evidence.some(e => !e.frozen_body_matches_current))
    .map(item => item.test_id),
  recorded_score_disagreements: audited.filter(item => item.recorded_complete !== item.recomputed_frozen_complete)
    .map(item => item.test_id), questions: audited };
await save('05-review/retrieval-integrity-v3.json', report);
await save('05-review/retrieval-integrity-v3.md', '# 检索验收完整性审计\n\n' +
  `冻结预期重算 ${report.recomputed_frozen_complete}/58；原登记 ${report.recorded_complete}/58；` +
  `当前正文对照 ${report.current_body_complete}/58（诊断值，不替换冻结成绩）。\n\n` +
  table(['题号', '冻结成绩', '当前正文命中', '预期有修订', '逐点排名：冻结/当前'],
    audited.filter(q => q.answerable).map(q => [q.test_id, q.recomputed_frozen_complete,
      q.current_body_complete, q.evidence.some(e => !e.frozen_body_matches_current),
      q.evidence.map(e => `${e.point}: ${e.frozen_body_ranks.join(',') || '-'} / ${e.current_body_ranks.join(',') || '-'}`).join('; ')])));
console.log(JSON.stringify({ ...report, files: undefined, questions: undefined }, null, 2));

if (process.argv.includes('--live-top20')) {
  const target = '05-review/retrieval-baseline-top20-v3.json';
  const diagnostic = await load(target).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return { started_at: new Date().toISOString(), parameters: { ...inputs.parameters, page_size: 20 },
      scope: '正式基线参数；仅诊断已暴露回归失败题，不是独立留出。', results: [] };
  });
  for (const question of inputs.questions.filter(q => q.answerable &&
    !audited.find(a => a.test_id === q.test_id).current_body_complete)) {
    if (diagnostic.results.some(r => r.test_id === question.test_id)) continue;
    const raw = await api('/datasets/search', 'POST', {
      dataset_ids: [originalDataset], question: question.question, ...diagnostic.parameters,
    });
    const chunks = rows(raw);
    const evidence = question.required.map(required => {
      const current = points.get(required.knowledge_point_id);
      const rank = chunks.findIndex(chunk => norm(chunk.content || chunk.content_with_weight)
        .includes(norm(current.body)));
      return { point: required.knowledge_point_id, rank: rank < 0 ? null : rank + 1 };
    });
    const item = { test_id: question.test_id, evidence, chunks };
    diagnostic.results.push(item);
    await save(target, diagnostic);
    console.log(JSON.stringify({ test_id: item.test_id, evidence }));
  }
}
