import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Tokenizer } from './06-tools/node_modules/@huggingface/tokenizers/dist/tokenizers.mjs';
import { hash, load, root, save } from './run.mjs';

const modelPath = path.resolve(root, '../../deps/huggingface.co/BAAI/bge-m3/tokenizer.json');
const modelBytes = await readFile(modelPath);
const tokenizer = new Tokenizer(JSON.parse(modelBytes), {});
const ledger = await load('00-control/revision-v3-ledger.json');
const register = await load('00-control/document-register.json');
const results = [];
for (const doc of register) {
  const record = ledger.documents.find(d => d.doc_id === doc.doc_id &&
    d.sha256 === doc.sha256 && d.phase === 'formal' && d.status === 'full-body-verified');
  if (!record) continue;
  const actual = await load(`04-chunks/actual/${doc.doc_id}-v3-formal.json`);
  const expected = await load(doc.structure_v3.expected_path);
  for (const chunk of actual.chunks) {
    if (actual.metadata_chunk_ids.includes(chunk.id)) continue;
    const id = chunk.content.match(/DOC\d{4}-K\d+(?!\d)/u)?.[0];
    const point = expected.points.find(p => p.knowledge_point_id === id);
    if (!point) throw Error(`Unknown point ${id}`);
    const tokens = tokenizer.encode(chunk.content).ids.length;
    results.push({ doc_id: doc.doc_id, knowledge_point_id: id, article: point.article,
      chunk_id: chunk.id, tokens_with_special_tokens: tokens, content_sha256: hash(chunk.content),
      within_embedding_limit: tokens <= 8192, semantic_length_review_required: tokens > 900 });
  }
}
const report = { checked_at: new Date().toISOString(), tokenizer_path: modelPath,
  tokenizer_sha256: hash(modelBytes), package: '@huggingface/tokenizers', special_tokens_included: true,
  embedding_limit: 8192, reranker_limit: null,
  reranker_status: '嵌入分词器不能代替实际重排模型tokenizer；重排预算尚待独立核验。',
  count: results.length, maximum: Math.max(0, ...results.map(r => r.tokens_with_special_tokens)),
  over_900: results.filter(r => r.semantic_length_review_required),
  over_limit: results.filter(r => !r.within_embedding_limit), results };
await save('04-chunks/token-audit-v3.json', report);
console.log(JSON.stringify({ count: report.count, max: report.maximum,
  over_900: report.over_900, over_limit: report.over_limit }));
