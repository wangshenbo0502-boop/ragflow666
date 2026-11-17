import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Tokenizer } from './06-tools/node_modules/@huggingface/tokenizers/dist/tokenizers.mjs';
import { hash, load, root, save } from './run.mjs';

const tokenizerPath = path.resolve(root, '../../deps/huggingface.co/BAAI/bge-m3/tokenizer.json');
const tokenizerBytes = await readFile(tokenizerPath);
const tokenizer = new Tokenizer(JSON.parse(tokenizerBytes), {});
const documents = [];
for (const [sourceID, docID] of [['S0033', 'DOC0025'], ['S0034', 'DOC0026'], ['S0035', 'DOC0027'], ['S0036', 'DOC0028']]) {
  const audit = await load(`05-review/successor-structure/${sourceID}-native-tables-v2.json`);
  assert.equal(hash(await readFile(path.join(root, audit.original_path))), audit.original_sha256);
  const expected = await load(`04-chunks/expected/${docID}-successor-v2.json`);
  const master = await readFile(path.join(root, expected.master_path), 'utf8');
  const points = expected.knowledge_points.map(point => ({
    knowledge_point_id: point.knowledge_point_id, kind: point.kind,
    native_table_id: point.native_table_id || null,
    characters: Array.from(point.text).length,
    embedding_tokens_with_special_tokens: tokenizer.encode(point.text).ids.length,
    unidentified_merge_origins: (point.text.match(/R\?C\?/gu) || []).length,
    article_contains_annex_list: point.kind === 'article' && /附件[：:]\s*1[.．]/u.test(point.text),
  }));
  const tableContext = audit.tables.map(table => {
    const index = audit.blocks.findIndex(block => block.table_id === table.table_id);
    const before = [];
    for (let i = index - 1; i >= 0; i--) {
      const block = audit.blocks[i];
      if (block.type === 'table') break;
      if (block.text.trim()) before.unshift({ paragraph: block.paragraph, label: block.label, text: block.text.trim() });
    }
    const after = [];
    for (let i = index + 1; i < audit.blocks.length; i++) {
      const block = audit.blocks[i];
      if (block.type === 'table') break;
      if (block.text.trim()) after.push({ paragraph: block.paragraph, label: block.label, text: block.text.trim() });
    }
    return { table_id: table.table_id, rows: table.row_count, columns: table.grid_columns,
      before, following_notes: after.filter(p => /^(注[：:]|说明[：:]|备注[：:])/u.test(p.text)),
      unresolved_source_origins: table.rows.flatMap(row => row.cells)
        .filter(cell => !cell.origin_cell_id).map(cell => cell.cell_id) };
  });
  documents.push({ doc_id: docID, source_id: sourceID, master_path: expected.master_path,
    master_sha256: hash(master), knowledge_points: points.length,
    table_count: tableContext.length, native_cells: audit.cell_count,
    over_900: points.filter(point => point.embedding_tokens_with_special_tokens > 900),
    over_embedding_limit: points.filter(point => point.embedding_tokens_with_special_tokens > 8192),
    unidentified_merge_origins: points.reduce((sum, point) => sum + point.unidentified_merge_origins, 0),
    annex_list_contamination: points.filter(point => point.article_contains_annex_list),
    maximum_embedding_tokens: Math.max(...points.map(point => point.embedding_tokens_with_special_tokens)),
    points, tables: tableContext });
}
const report = { checked_at: new Date().toISOString(), tokenizer_path: tokenizerPath,
  tokenizer_sha256: hash(tokenizerBytes), token_count_scope: 'Draft point text only; final chunk prefixes and query/pair budget are not included.',
  embedding_limit_reference: 8192, reranker_tokenizer_verified: false,
  acceptance: false, formal_dataset_modified: false, originals_modified: false, documents };
await save('05-review/successor-draft-audit-v2.json', report);
console.log(JSON.stringify(documents.map(({ points, tables, ...summary }) => summary), null, 2));
