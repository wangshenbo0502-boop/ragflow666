import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Tokenizer } from './06-tools/node_modules/@huggingface/tokenizers/dist/tokenizers.mjs';
import { hash, load, root, save } from './run.mjs';

const tokenizerPath = path.resolve(root, '../../deps/huggingface.co/BAAI/bge-m3/tokenizer.json');
const tokenizerBytes = await readFile(tokenizerPath);
const tokenizer = new Tokenizer(JSON.parse(tokenizerBytes), {});
const snapshot = `05-review/history/successor-table-split-${new Date().toISOString().replaceAll(/[:.]/gu, '-')}`;
for (const relative of [
  '04-chunks/expected/successor-v2-table-split-candidates.json',
  '05-review/successor-table-split-audit-v2.json',
]) {
  await save(`${snapshot}/${relative}`, await readFile(path.join(root, relative)));
}
const docs = [
  ['DOC0025', 'S0033', 'S0033-T02', 'equipment'],
  ['DOC0025', 'S0033', 'S0033-T08', 'assessment'],
  ['DOC0026', 'S0034', 'S0034-T03', 'equipment'],
  ['DOC0026', 'S0034', 'S0034-T05', 'assessment'],
  ['DOC0026', 'S0034', 'S0034-T06', 'assessment'],
  ['DOC0027', 'S0035', 'S0035-T02', 'equipment'],
  ['DOC0027', 'S0035', 'S0035-T03', 'assessment'],
  ['DOC0028', 'S0036', 'S0036-T02', 'equipment'],
  ['DOC0028', 'S0036', 'S0036-T07', 'assessment'],
];
const numeral = /^[一二三四五六七八九十]+[、.．、]/u;
const chineseSection = /^[一二三四五六七八九十]+$/u;
const clean = value => String(value || '').replaceAll(/[\t\r\n ]+/gu, ' ').trim();
const register = await load('00-control/document-register.json');

function sourceCell(cell, table) {
  const origin = cell.vertical_merge === 'continue' ? cell.origin_cell_id : cell.cell_id;
  const source = table.rows.flatMap(item => item.cells).find(item => item.cell_id === origin);
  assert.ok(source, `${cell.cell_id}: merge source missing`);
  return source;
}

function headerValues(row, table) {
  const result = Array(table.grid_columns).fill('');
  for (const cell of row.cells) {
    const source = sourceCell(cell, table);
    for (let n = 0; n < cell.column_span; n++) {
      result[cell.column - 1 + n] = clean(cell.text) || clean(source.text);
    }
  }
  return result;
}

function commonContext(source, table, kind) {
  const index = source.blocks.findIndex(block => block.table_id === table.table_id);
  let start = index - 1;
  for (; start >= 0; start--) {
    const block = source.blocks[start];
    if (block.type === 'paragraph' && /^附件\s*\d+$/u.test(clean(block.text))) break;
  }
  assert.ok(start >= 0, `${table.table_id}: missing attachment boundary`);
  const paragraphs = source.blocks.slice(start, index).filter(block => block.type === 'paragraph' && clean(block.text));
  const selected = kind === 'assessment' ? paragraphs : paragraphs.slice(0, 2);
  const after = [];
  for (let n = index + 1; n < source.blocks.length; n++) {
    const block = source.blocks[n];
    if (block.type === 'table' || /^附件\s*\d+$/u.test(clean(block.text))) break;
    if (/^(注[：:]|说明[：:]|备注[：:])/u.test(clean(block.text))) after.push(block);
  }
  return {
    paragraphs: [...selected, ...after].map(block => ({
      paragraph: block.paragraph, word_paragraph: block.word_paragraph,
      text: `${block.label ? `${block.label} ` : ''}${clean(block.text)}`,
    })),
    title: clean(table.preceding_paragraphs.at(-1)?.text || table.table_id),
  };
}

function columns(row, width, table) {
  const result = Array(width).fill(null);
  for (const cell of row.cells) {
    const origin = cell.vertical_merge === 'continue' ? cell.origin_cell_id : cell.cell_id;
    const source = table.rows.flatMap(item => item.cells).find(item => item.cell_id === origin);
    assert.ok(source, `${cell.cell_id}: merge source missing`);
    const value = clean(cell.text) || (cell.vertical_merge === 'continue' ? clean(source.text) : '');
    for (let n = 0; n < cell.column_span; n++) {
      result[cell.column - 1 + n] = n === 0 ? value
        : `〔横向合并自C${cell.column}；原文=${value || '空白'}〕`;
    }
  }
  return result;
}

function headerRows(table, sectionIndex) {
  const result = [];
  for (let i = sectionIndex + 1; i < table.rows.length; i++) {
    const values = columns(table.rows[i], table.grid_columns, table);
    if (/^\d+$/u.test(values[0] || '')) break;
    result.push({ row: table.rows[i].row, values });
  }
  return result;
}

function makeEntry({ docID, sourceID, table, row, section, category, headers, kind }) {
  const values = columns(row, table.grid_columns, table);
  const substantive = kind === 'assessment'
    ? [`序号=${values[0] || '原表空白'}`, `项目=${values[1] || category || '原表空白'}`,
      `内容=${values[2] || '原表空白'}`,
      ...values.slice(3).map((value, index) => `${headers[index + 3]}=${value || '〔原表该格为空；未推定含义〕'}`)]
    : values.map((value, index) => `${headers[index] || `原列${index + 1}`}=${value || '〔原表该格为空；未推定含义〕'}`);
  return {
    doc_id: docID, domain_code: ({ DOC0025: 'GW', DOC0026: 'XH', DOC0027: 'XH', DOC0028: 'GD' })[docID],
    source_id: sourceID, knowledge_point_id: null, kind,
    heading: [section, category].filter(Boolean).join(' / ') || table.table_id,
    source_location: `${table.table_id}，原生表格第${row.row}行`,
    native_table_id: table.table_id, native_row_ids: [row.row],
    section, category, text: null,
    _substantive: substantive,
  };
}

function assessmentEntries(docID, sourceID, table) {
  const entries = [];
  let section = '';
  let category = '';
  let headers = [];
  for (const row of table.rows) {
    const v = columns(row, table.grid_columns, table).map(clean);
    if (v[0] === '序号') {
      headers = v;
      continue;
    }
    if (chineseSection.test(v[0]) && v[1]) {
      section = `${v[0]} ${v[1]}`;
      category = '';
      continue;
    }
    if (/^\d+\.\d+/u.test(v[0]) && v[1]) category = `${v[0]} ${v[1]}`;
    const criterion = v[2];
    if (!criterion) continue;
    const entry = makeEntry({ docID, sourceID, table, row, section, category,
      headers, kind: 'assessment' });
    if (entries.length && !v[0] && !v[1]) {
      const previous = entries.at(-1);
      previous._substantive[2] += `；${criterion}`;
      assert.ok(row.cells.filter(cell => cell.column > 3).every(cell => !clean(cell.text)),
        `${table.table_id}: continuation has nonempty review fields`);
      previous.native_row_ids.push(row.row);
      previous.source_location = `${table.table_id}，原生表格第${previous.native_row_ids[0]}-${row.row}行`;
    } else {
      entry._substantive[2] = `类别=${section}；项目类别=${category || '原表未单列'}；${entry._substantive[2]}`;
      entries.push(entry);
    }
  }
  return entries;
}

function equipmentEntries(docID, sourceID, table) {
  const entries = [];
  let section = '';
  let sectionHeader = [];
  let sectionRows = [];
  let sectionNotes = [];
  const flush = () => {
    if (!sectionRows.length) return;
    const headers = Array.from({ length: table.grid_columns }, (_, col) => {
      const labels = sectionHeader.map(header => {
        const row = table.rows.find(item => item.row === header.row);
        return headerValues(row, table)[col];
      }).filter(Boolean);
      return [...new Set(labels)].join(' / ') || `原列${col + 1}`;
    });
    for (const row of sectionRows) {
      const entry = makeEntry({ docID, sourceID, table, row, section, category: '', headers, kind: 'equipment' });
      entry.cell_mapping = row.cells.map(cell => {
        const origin = sourceCell(cell, table);
        const labels = [...new Set(Array.from({ length: cell.column_span }, (_, n) => headers[cell.column - 1 + n]))];
        const mergedIntoHeader = cell.vertical_merge === 'continue'
          && sectionHeader.some(header => header.row === origin.row);
        const text = clean(cell.text) || (cell.vertical_merge === 'continue' ? clean(origin.text) : '');
        return {
          cell_id: cell.cell_id, origin_cell_id: origin.cell_id,
          column: cell.column, column_span: cell.column_span,
          header: labels.join('；'), original_value: text,
          merged_into_header: mergedIntoHeader,
          rendered_value: mergedIntoHeader
            ? `〔原表与表头${origin.cell_id}纵向合并；无单独填写的条件，不将表头文字解释为条件〕`
            : text || '〔原表该格为空；未推定含义〕',
        };
      });
      entry.section_note_cells = sectionNotes.flatMap(note => note.cells
        .filter(cell => clean(cell.text))
        .map(cell => ({ cell_id: cell.cell_id, row: note.row, text: clean(cell.text) })));
      entry._substantive = [`设备目录分组=${section}`,
        ...entry.section_note_cells.map(cell => `本分组原表注释（${cell.cell_id}，不扩张到其他分组）=${cell.text}`),
        ...entry.cell_mapping.map(cell => `${cell.header}=${cell.rendered_value}`)];
      entries.push(entry);
    }
    sectionRows = [];
    sectionNotes = [];
  };
  for (const row of table.rows) {
    const v = columns(row, table.grid_columns, table).map(clean);
    const sectionTitle = v.find(value => numeral.test(value) && !/^\d+$/u.test(value));
    if (sectionTitle) {
      flush();
      section = sectionTitle;
      sectionHeader = headerRows(table, table.rows.indexOf(row));
      continue;
    }
    if (/^\d+$/u.test(v[0] || '')) {
      sectionRows.push(row);
    } else if (!sectionHeader.some(header => header.row === row.row)
      && row.cells.some(cell => clean(cell.text))) {
      assert.ok(section && row.cells.length === 1
        && /^(备注|说明|注)[：:]/u.test(clean(row.cells[0].text)),
      `${table.table_id}-R${row.row}: unclassified nonempty equipment row`);
      sectionNotes.push(row);
    }
  }
  flush();
  return entries;
}

const reports = [];
for (const [docID, sourceID, tableID, kind] of docs) {
  const source = await load(`05-review/successor-structure/${sourceID}-native-tables-v2.json`);
  const table = source.tables.find(item => item.table_id === tableID);
  assert.ok(table, `${tableID}: missing source table`);
  assert.equal(hash(await readFile(path.join(root, source.original_path))), source.original_sha256,
    `${tableID}: source original changed`);
  const document = register.find(item => item.doc_id === docID);
  const expected = await load(`04-chunks/expected/${docID}-successor-v2.json`);
  const parent = expected.knowledge_points.find(item => item.native_table_id === tableID);
  assert.ok(parent, `${tableID}: missing parent knowledge point`);
  const context = commonContext(source, table, kind);
  const entries = kind === 'assessment'
    ? assessmentEntries(docID, sourceID, table)
    : equipmentEntries(docID, sourceID, table);
  assert.ok(entries.length, `${tableID}: no semantic rows extracted`);
  for (const entry of entries) {
    entry.parent_knowledge_point_id = parent.knowledge_point_id;
    entry.source_version = document.version;
    entry.source_ids = [sourceID];
    entry.document_title = document.title;
    entry.table_title = context.title;
    entry.common_context = context.paragraphs;
    entry.heading_path = [document.title, context.title, entry.heading];
    entry.knowledge_point_id = `${docID}-${tableID}-R${String(entry.native_row_ids[0]).padStart(3, '0')}`;
    entry.text = [
      `文档：${document.title}（${docID}）；版本：${document.version}；来源：${sourceID}；${entry.source_location}。`,
      `表格：${context.title}（${tableID}）；分组：${entry.heading || '原表未标明'}`,
      '共同适用说明及原表相邻注释（保留原文，不据此扩张单项适用范围）：',
      ...context.paragraphs.map(paragraph => `${sourceID}原文段落${paragraph.paragraph}：${paragraph.text}`),
      ...entry._substantive,
    ].join('\n');
    delete entry._substantive;
    entry.embedding_tokens_with_special_tokens = tokenizer.encode(entry.text).ids.length;
  }
  const sourceRows = kind === 'assessment'
    ? table.rows.filter(row => {
      const v = columns(row, table.grid_columns, table).map(clean);
      return v[0] !== '序号' && v[2] && !(chineseSection.test(v[0]) && v[1]);
    }).map(row => row.row)
    : table.rows.filter(row => /^\d+$/u.test(columns(row, table.grid_columns, table)[0] || '')).map(row => row.row);
  const coveredRows = [...new Set(entries.flatMap(entry => entry.native_row_ids))].sort((a, b) => a - b);
  assert.deepEqual(coveredRows, sourceRows, `${tableID}: row coverage differs`);
  const max = Math.max(...entries.map(entry => entry.embedding_tokens_with_special_tokens));
  reports.push({
    doc_id: docID, source_id: sourceID, table_id: tableID, kind,
    original_path: source.original_path, original_sha256: source.original_sha256,
    original_row_count: table.row_count, original_grid_columns: table.grid_columns,
    entry_count: entries.length, covered_row_count: coveredRows.length,
    source_rows: sourceRows, covered_rows: coveredRows,
    coverage_verified: true, maximum_entry_tokens: max,
    entries_over_900: entries.filter(entry => entry.embedding_tokens_with_special_tokens > 900).length,
    entries_over_8192: entries.filter(entry => entry.embedding_tokens_with_special_tokens > 8192).length,
    entries,
  });
}
const report = {
  checked_at: new Date().toISOString(), status: 'semantic-row-split candidates; content and visual review pending',
  previous_candidate_snapshot: snapshot,
  tokenizer_path: tokenizerPath, tokenizer_sha256: hash(tokenizerBytes),
  token_scope: 'Each candidate point including document, source, table, group, and original row context.',
  formal_dataset_modified: false, originals_modified: false,
  caveat: 'BGE-M3 tokenizer count does not establish reranker budget. Empty source cells are explicitly retained as blank; no blank is interpreted as zero, not applicable, or same-as-above.',
  tables: reports,
};
await save('04-chunks/expected/successor-v2-table-split-candidates.json', report);
await save('05-review/successor-table-split-audit-v2.json', {
  ...report, tables: reports.map(({ entries, ...summary }) => summary),
});
console.log(JSON.stringify(reports.map(({ entries, source_rows, covered_rows, ...summary }) => summary), null, 2));
