import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { hash, load, parseHTML, root, save } from './run.mjs';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const { DOMParser } = require('@xmldom/xmldom');
const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const output = '05-review/successor-structure';
const children = (node, name) => Array.from(node.childNodes || [])
  .filter(child => child.nodeType === 1 && (!name || child.localName === name));
const first = (node, name) => children(node, name)[0];
const attr = (node, name) => node?.getAttributeNS(ns, name) || null;
const descendants = (node, name) => Array.from(node.getElementsByTagNameNS(ns, name));
const paragraphText = node => children(node).map(child => {
  if (child.localName === 't') return child.textContent;
  if (child.localName === 'tab') return '\t';
  if (child.localName === 'br' || child.localName === 'cr') return '\n';
  return paragraphText(child);
}).join('');
const printable = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('|', '&#124;').replace(/\r?\n/gu, '<br>');

function htmlLinks(html, base) {
  const result = [];
  function visit(node) {
    if (node.tagName === 'a') {
      const href = node.attrs?.find(item => item.name === 'href')?.value;
      if (href) {
        const url = new URL(href, base);
        if (/\.(docx?|pdf)$/iu.test(url.pathname)) result.push(url.href);
      }
    }
    for (const child of node.childNodes || []) visit(child);
  }
  visit(parseHTML(html));
  return [...new Set(result)];
}

async function fetchBytes(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
  assert.ok(response.ok, `${response.status}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

const sources = await load('00-control/source-register.json');
const prior = await load(`${output}/successor-structure-audit-v1.json`);
const results = [];
for (const spec of prior.sources) {
  const source = sources.find(item => item.source_id === spec.source_id);
  assert.ok(source?.url, `${spec.source_id}: missing registered URL`);
  const localBytes = await readFile(path.join(root, spec.original_path));
  assert.equal(hash(localBytes), spec.sha256, 'Original no longer matches prior audit');
  const pageBytes = await fetchBytes(source.url);
  const attachmentLinks = htmlLinks(pageBytes.toString('utf8'), source.url);
  const attachmentChecks = [];
  for (const url of attachmentLinks) {
    if (new URL(url).hostname !== new URL(source.url).hostname) continue;
    const bytes = await fetchBytes(url);
    attachmentChecks.push({ url, bytes: bytes.length, sha256: hash(bytes), matches_local: hash(bytes) === spec.sha256 });
    if (hash(bytes) === spec.sha256) {
      await save(`${output}/${spec.source_id}-official-redownload${path.extname(new URL(url).pathname)}`, bytes);
    }
  }
  assert.ok(attachmentChecks.some(item => item.matches_local), `${spec.source_id}: no official attachment matches`);
  await save(`${output}/${spec.source_id}-official-page-v2.html`, pageBytes);

  const metadata = await load(spec.metadata_path);
  const xml = await readFile(path.join(root, spec.structure_path), 'utf8');
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  const body = document.getElementsByTagNameNS(ns, 'body')[0];
  assert.ok(body, 'Missing Word body');
  const paragraphs = descendants(body, 'p');
  const paragraphIndex = new Map(paragraphs.map((paragraph, index) => [paragraph, index]));
  const normalize = value => value.replace(/[\s\u0007\u000b\u000c]/gu, '');
  const nonemptyWord = metadata.paragraphs.map((item, index) => ({ ...item, index }))
    .filter(item => normalize(item.text));
  const nonemptyXML = paragraphs.filter(item => normalize(paragraphText(item)));
  assert.equal(nonemptyWord.length, nonemptyXML.length, 'Nonempty Word/XML paragraph counts differ');
  assert.equal(metadata.paragraphs.filter(item => item.label && !normalize(item.text)).length, 0,
    'Numbered blank paragraphs require explicit mapping');
  const aligned = new Map();
  for (let i = 0; i < nonemptyXML.length; i++) {
    assert.equal(normalize(paragraphText(nonemptyXML[i])), normalize(nonemptyWord[i].text),
      `Nonempty paragraph ${i + 1} differs; cannot align labels`);
    aligned.set(nonemptyXML[i], nonemptyWord[i]);
  }
  function paragraphRecord(paragraph) {
    const index = paragraphIndex.get(paragraph);
    const word = aligned.get(paragraph);
    return {
      paragraph: index + 1,
      label: word?.label || '',
      text: paragraphText(paragraph),
      word_paragraph: word ? word.index + 1 : null,
      word_start: word?.start ?? null,
    };
  }

  const blocks = [];
  const tables = [];
  const warnings = [];
  for (const block of children(body)) {
    if (block.localName === 'p') {
      blocks.push({ type: 'paragraph', ...paragraphRecord(block) });
      continue;
    }
    if (block.localName !== 'tbl') continue;
    const id = `${spec.source_id}-T${String(tables.length + 1).padStart(2, '0')}`;
    const grid = first(block, 'tblGrid');
    const gridColumns = children(grid || {}, 'gridCol').length;
    const rows = [];
    let previous = [];
    for (const [rowIndex, row] of children(block, 'tr').entries()) {
      const properties = first(row, 'trPr');
      const before = Number(attr(first(properties || {}, 'gridBefore'), 'val') || 0);
      const after = Number(attr(first(properties || {}, 'gridAfter'), 'val') || 0);
      let column = before;
      const current = [];
      const cells = [];
      for (const cell of children(row, 'tc')) {
        const cellProperties = first(cell, 'tcPr');
        const span = Number(attr(first(cellProperties || {}, 'gridSpan'), 'val') || 1);
        const vertical = first(cellProperties || {}, 'vMerge');
        const merge = vertical ? attr(vertical, 'val') || 'continue' : null;
        const cellID = `${id}-R${rowIndex + 1}C${column + 1}`;
        const origin = merge === 'continue' ? previous[column] : cellID;
        if (merge === 'continue' && !origin) warnings.push(`${cellID}: vertical continuation has no predecessor`);
        const content = descendants(cell, 'p').map(paragraphRecord);
        const text = content.map(item => `${item.label ? item.label + ' ' : ''}${item.text}`).join('\n');
        const record = { cell_id: cellID, row: rowIndex + 1, column: column + 1,
          column_span: span, vertical_merge: merge, origin_cell_id: origin || null, text, paragraphs: content };
        cells.push(record);
        for (let offset = 0; offset < span; offset++) current[column + offset] = origin || cellID;
        column += span;
      }
      if (column + after !== gridColumns) warnings.push(`${id}-R${rowIndex + 1}: grid width ${column + after}, declared ${gridColumns}`);
      rows.push({ row: rowIndex + 1, repeated_header: !!first(properties || {}, 'tblHeader'),
        grid_before: before, grid_after: after, cells, resolved_origins: current });
      previous = current;
    }
    const context = blocks.filter(item => item.type === 'paragraph' && item.text.trim()).slice(-6);
    const record = { table_id: id, grid_columns: gridColumns, preceding_paragraphs: context,
      row_count: rows.length, rows, nested_tables: descendants(block, 'tbl').length };
    if (record.nested_tables) warnings.push(`${id}: nested tables require separate mapping`);
    tables.push(record);
    blocks.push({ type: 'table', table_id: id });
  }
  assert.equal(tables.length, metadata.table_count, 'Not all native tables were captured');
  const documentText = paragraphs.map(paragraphText).join('\n');
  const exportedText = blocks.map(block => block.type === 'paragraph' ? block.text
    : tables.find(table => table.table_id === block.table_id).rows.flatMap(row => row.cells.map(cell => cell.paragraphs.map(item => item.text).join('\n'))).join('\n')).join('\n');
  const canonical = value => value.replace(/\s/gu, '');
  assert.equal(canonical(exportedText), canonical(documentText), 'Structural export dropped or reordered main-body text');
  const anomalyCells = tables.flatMap(table => table.rows.flatMap(row => row.cells))
    .filter(cell => /晨云提议/u.test(cell.text)).map(cell => ({ cell_id: cell.cell_id, text: cell.text }));
  const report = {
    checked_at: new Date().toISOString(), source_id: spec.source_id, doc_id: spec.doc_id,
    original_path: spec.original_path, original_sha256: spec.sha256,
    official_page: { url: source.url, sha256: hash(pageBytes), path: `${output}/${spec.source_id}-official-page-v2.html` },
    attachment_checks: attachmentChecks, official_attachment_matches: true,
    word_pages: metadata.pages, paragraph_count: paragraphs.length,
    word_paragraph_count: metadata.paragraphs.length,
    paragraph_alignment: 'All nonempty paragraphs match one-to-one in order after whitespace normalization; extra Word empty/end-of-cell paragraphs are excluded only from label alignment.',
    auto_numbered_paragraphs: metadata.paragraphs.filter(item => item.label).length,
    native_table_count: tables.length,
    cell_count: tables.reduce((total, table) => total + table.rows.reduce((n, row) => n + row.cells.length, 0), 0),
    text_sequence_preserved: true, warnings, anomaly_cells: anomalyCells,
    limitation: 'Native XML/Word label alignment and merge topology audit, not full cell-by-cell semantic or visual acceptance. No master, trial or formal import is approved by this report.',
    blocks, tables,
  };
  await save(`${output}/${spec.source_id}-native-tables-v2.json`, report);
  const markdown = [
    `# ${spec.source_id} ${source.title}：原生表格复核稿`, '',
    '**状态：待逐表语义与可视复核；不是验收主副本，不上传知识库。**', '',
    `官方页：${source.url}`, `原件：${spec.original_path}`, `原件 SHA-256：${spec.sha256}`,
    `复下官方附件与本地原件一致；Word ${metadata.pages} 页，${tables.length} 张表。`, '',
    '坐标为原生 Word 表格网格，跨列和纵向合并关系单列保存；空白不推定为“同上”“不适用”或零。表内自动编号由只读 Word 段落记录恢复。', '',
  ];
  for (const table of tables) {
    markdown.push(`## ${table.table_id}`, '',
      ...table.preceding_paragraphs.map(item => `原文段落 P${item.paragraph}：${item.label ? item.label + ' ' : ''}${item.text}`), '',
      '| 单元格 | 跨列数 | 纵向合并 | 合并起点 | 原文（保留单元格内段落） |',
      '| --- | --- | --- | --- | --- |');
    for (const row of table.rows) for (const cell of row.cells) {
      markdown.push(`| ${cell.cell_id} | ${cell.column_span} | ${cell.vertical_merge || '无'} | ${cell.origin_cell_id || '待核'} | ${printable(cell.text)} |`);
    }
    markdown.push('');
  }
  await save(`${output}/${spec.source_id}-native-tables-v2.md`, markdown.join('\n') + '\n');
  assert.equal(hash(await readFile(path.join(root, spec.original_path))), spec.sha256, 'Original changed');
  const { blocks: omittedBlocks, tables: omittedTables, ...summary } = report;
  results.push(summary);
  console.log(JSON.stringify(summary));
}
await save(`${output}/successor-source-and-tables-audit-v2.json`, {
  checked_at: new Date().toISOString(), originals_modified: false,
  formal_dataset_modified: false, semantic_acceptance: false, sources: results,
});
