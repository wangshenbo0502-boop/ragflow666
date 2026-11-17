import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Tokenizer } from './06-tools/node_modules/@huggingface/tokenizers/dist/tokenizers.mjs';
import { hash, load, root, save } from './run.mjs';
import { semanticTablePoints } from './successor-semantic-tables.mjs';
import { standaloneTableNotes, tableContext } from './successor-table-context.mjs';

const registry = await load('00-control/document-register.json');
const candidates = await load('04-chunks/expected/successor-v2-table-split-candidates.json');
const tokenizerBytes = await readFile(path.resolve(root, '../../deps/huggingface.co/BAAI/bge-m3/tokenizer.json'));
const tokenizer = new Tokenizer(JSON.parse(tokenizerBytes), {});
const now = new Date().toISOString();
const history = `05-review/history/successor-v3-${now.replaceAll(/[:.]/gu, '-')}`;
const ids = ['DOC0025', 'DOC0026', 'DOC0027', 'DOC0028'];
const controls = ['document-register.json', 'domain-register.md', 'structure-register.md', 'progress.md'];
const prepared = [];
const normalize = value => value.replaceAll(/\s+/gu, '');
const clean = value => String(value || '').replaceAll(/\s+/gu, ' ').trim();

function replaceNativeTable(master, point, sourceTable) {
  const start = master.indexOf(`### ${point.knowledge_point_id} `);
  assert.ok(start >= 0, `${point.knowledge_point_id}: table heading missing`);
  const tableStart = master.indexOf('\n| 原列1 ', start);
  assert.ok(tableStart >= 0, `${point.knowledge_point_id}: source table body missing`);
  let end = tableStart + 1;
  while (master[end] === '|') {
    const next = master.indexOf('\n', end);
    end = next < 0 ? master.length : next + 1;
  }
  assert.equal((master.slice(tableStart, end).match(/^\| /gmu) || []).length, sourceTable.row_count + 2);
  return `${master.slice(0, start)}### ${point.knowledge_point_id} ${point.heading}\n\n${point.text}\n\n${master.slice(end)}`;
}

function splitApplicationForm(point, table, document, context) {
  const groups = [
    { id: 1, title: '个人申请人信息', rows: [1, 4] },
    { id: 2, title: '申请单位信息', rows: [5, 8] },
    { id: 3, title: '委托代理人信息', rows: [9, 12] },
    { id: 4, title: '行政许可申请事项与材料目录', rows: [13, 15] },
  ];
  const lines = point.text.split('\n');
  const headerIndex = lines.findIndex(line => /^\| 原列1 \|/u.test(line));
  assert.ok(headerIndex >= 0, `${table.table_id}: application form grid missing`);
  const header = lines.slice(headerIndex, headerIndex + 2);
  const bodyRows = lines.slice(headerIndex + 2).filter(line => /^\| /u.test(line));
  assert.equal(bodyRows.length, table.row_count, `${table.table_id}: application form row count mismatch`);
  return groups.map(group => {
    const [first, last] = group.rows;
    const id = `${document.doc_id}-${table.table_id}-R${String(first).padStart(3, '0')}-${String(last).padStart(3, '0')}`;
    const text = [
      `文档：${document.title}（${document.doc_id}）；版本：${document.version}；来源：${document.source_id}。`,
      `表格：国家铁路局行政许可申请书（${table.table_id}）；本片为${group.title}填写区，原附件表格第${first}-${last}行。`,
      '原表列网格、合并关系及空白均按原件保留；空白为待填写项，不推定为默认值。',
      ...context.map(block => `${document.source_id}原文段落${block.paragraph}：${block.text}`),
      `原表第${first}-${last}行：`,
      ...header,
      ...bodyRows.slice(first - 1, last),
      `来源定位：${table.table_id}，原生表格第${first}-${last}行。`,
    ].join('\n');
    return {
      ...point, knowledge_point_id: id, heading: `国家铁路局行政许可申请书 / ${group.title}`,
      heading_path: [document.title, point.heading, group.title],
      source_location: `${table.table_id}，原生表格第${first}-${last}行`,
      native_row_ids: Array.from({ length: last - first + 1 }, (_, index) => first + index),
      parent_knowledge_point_id: point.knowledge_point_id,
      text,
      review_status: '原表行分组候选；待视觉及语义复核；未试切；未导入',
    };
  });
}

function replaceWithTableChildren(master, parent, children, table) {
  const start = master.indexOf(`### ${parent.knowledge_point_id} `);
  assert.ok(start >= 0, `${parent.knowledge_point_id}: table heading missing`);
  const tableStart = master.indexOf('\n| 原列1 ', start);
  assert.ok(tableStart >= 0, `${parent.knowledge_point_id}: source table body missing`);
  let end = tableStart + 1;
  while (master[end] === '|') {
    const next = master.indexOf('\n', end);
    end = next < 0 ? master.length : next + 1;
  }
  assert.equal((master.slice(tableStart, end).match(/^\| /gmu) || []).length, table.row_count + 2);
  const replacement = children.map(child =>
    `### ${child.knowledge_point_id} ${child.heading}\n\n${child.text}\n\n`).join('');
  return `${master.slice(0, start)}${replacement}${master.slice(end)}`;
}

for (const docID of ids) {
  const document = registry.find(item => item.doc_id === docID);
  assert.ok(document, `${docID}: missing registry entry`);
  const expected = await load(`04-chunks/expected/${docID}-successor-v2.json`);
  const original = await readFile(path.join(root, document.original_path));
  assert.equal(hash(original), expected.source_sha256, `${docID}: original changed`);
  const groups = candidates.tables.filter(item => item.doc_id === docID);
  const oldMaster = await readFile(path.join(root, document.master_path), 'utf8');
  const v2Master = document.structure_v3?.v2_snapshot_path
    || (document.structure_v3 && `${document.structure_v3.history_snapshot}/${document.master_path}`);
  let master = v2Master ? await readFile(path.join(root, v2Master), 'utf8') : oldMaster;
  const source = await load(document.structure_v2.source_audit);
  const parentTables = [];
  const replacements = new Map();
  for (const group of groups) {
    const parent = expected.knowledge_points.find(item => item.native_table_id === group.table_id);
    assert.ok(parent, `${group.table_id}: missing original point`);
    assert.equal(group.source_sha256 || group.original_sha256, expected.source_sha256);
    assert.equal(group.coverage_verified, true);
    assert.equal(group.entries.length, group.entry_count);
    const prefix = `### ${parent.knowledge_point_id} `;
    const start = master.indexOf(prefix);
    assert.ok(start >= 0 && (start === 0 || master[start - 1] === '\n'), `${parent.knowledge_point_id}: no heading`);
    const afterStart = master.indexOf('\n', start);
    const boundary = /\n#{1,3} /gu;
    boundary.lastIndex = afterStart;
    const next = boundary.exec(master);
    const end = next ? next.index + 1 : master.length;
    const native = source.tables.find(table => table.table_id === group.table_id);
    assert.ok(native, `${group.table_id}: missing native table`);
    const sectionRows = native.rows.filter(row => /^[一二三四五六七八九十]+$/u.test(clean(row.cells[0]?.text)));
    const entries = group.entries.map(entry => {
      assert.equal(entry.parent_knowledge_point_id, parent.knowledge_point_id);
      const subject = entry.kind === 'equipment'
        ? entry.cell_mapping.find(cell => /设备名称/u.test(cell.header))?.original_value
        : entry.text.match(/内容=([^\n]+)/u)?.[1];
      const heading = `${entry.heading} / ${subject || entry.table_title}（原表行${entry.native_row_ids.join('-')}）`
        .replaceAll(/[\r\n]+/gu, ' ');
      const context = entry.common_context.filter(paragraph => !/^产品质量保证体系和安全管理制度项目及审查表-\d+$/u.test(clean(paragraph.text))
        || clean(paragraph.text) === entry.table_title);
      const removedContext = entry.common_context.filter(paragraph => !context.includes(paragraph));
      for (const paragraph of removedContext) {
        assert.match(clean(paragraph.text), /^产品质量保证体系和安全管理制度项目及审查表-\d+$/u,
          `${entry.knowledge_point_id}: non-title context must not be removed`);
      }
      let body = entry.text;
      for (const paragraph of removedContext) body = body.replace(`${entry.source_id}原文段落${paragraph.paragraph}：${paragraph.text}\n`, '');
      for (const paragraph of context) assert.ok(body.includes(paragraph.text),
        `${entry.knowledge_point_id}: retained scope paragraph absent`);
      const sectionRow = entry.kind === 'assessment' ? sectionRows.find(row => {
        const cells = row.cells.slice(0, 2).map(cell => clean(cell.text));
        return cells.join(' ') === entry.section;
      }) : null;
      const sectionMetadata = sectionRow ? sectionRow.cells.filter(cell => clean(cell.text)).map(cell => ({
        cell_id: cell.cell_id, column: cell.column, text: clean(cell.text),
      })) : [];
      if (sectionMetadata.length) body += `\n原表分部汇总行（${group.table_id}-R${sectionRow.row}，不由拆分行数推算）：${sectionMetadata.map(cell => `C${cell.column}=${cell.text}`).join('；')}`;
      const rendered = `${body}\n父表知识点：${parent.knowledge_point_id}；审校状态：待逐格语义和视觉复核，非真实切片。`;
      const point = { ...entry, heading,
        heading_path: [document.title, entry.table_title, heading], text: rendered,
        common_context: context, section_summary_cells: sectionMetadata,
        excluded_neighbor_title_paragraphs: removedContext,
        review_status: '待逐格语义/视觉复核；未试切；未导入',
        embedding_tokens_with_special_tokens: tokenizer.encode(rendered).ids.length };
      assert.ok(point.embedding_tokens_with_special_tokens <= 8192, `${point.knowledge_point_id}: embedding overflow`);
      return point;
    });
    const semanticEntries = semanticTablePoints(parent, native, document, tableContext(source, native)) || entries;
    assert.ok(semanticEntries.length);
    const completeCandidateText = normalize(semanticEntries.map(entry => entry.text).join('\n'));
    for (const row of native.rows) for (const cell of row.cells) {
      if (normalize(cell.text)) assert.ok(completeCandidateText.includes(normalize(cell.text)),
        `${cell.cell_id}: original nonempty cell absent from candidates`);
    }
    replacements.set(parent.knowledge_point_id, semanticEntries);
    parentTables.push({ ...parent, status: '父表关联；不重复作为完整表切片',
      child_knowledge_point_ids: semanticEntries.map(point => point.knowledge_point_id) });
    const section = semanticEntries.map(point => `### ${point.knowledge_point_id} ${point.heading}\n\n${point.text}\n\n`).join('');
    master = master.slice(0, start) + section + master.slice(end);
  }
  const points = expected.knowledge_points.flatMap(point => replacements.get(point.knowledge_point_id) || [{ ...point }]);
  const formChildren = [];
  for (const point of points.filter(point => point.kind === 'source_table')) {
    const table = source.tables.find(item => item.table_id === point.native_table_id);
    assert.ok(table, `${point.knowledge_point_id}: native table absent`);
    const context = tableContext(source, table);
    const contextText = context.map(block => `${document.source_id}原文段落${block.paragraph}：${block.text}`).join('\n');
    point.common_context = context;
    const gridStart = point.text.indexOf('\n\n**原表列数：**');
    assert.ok(gridStart >= 0, `${point.knowledge_point_id}: native grid metadata absent`);
    // The extractor's preceding-paragraph window can include a previous product title.
    const caption = `来源表格 ${table.table_id}；${table.row_count}行、${table.grid_columns}列；本表适用说明以上述附件内共同前提为准。`;
    point.text = `文档：${document.title}（${docID}）；版本：${document.version}；来源：${document.source_id}；定位：${point.source_location}\n相邻原文与本附件共同前提（不扩张到其他附件）：\n${contextText}\n\n${caption}${point.text.slice(gridStart)}`;
    if (/^专业技术人员应当/u.test(point.heading)) point.heading = '附件3专业技术人员要求';
    if (point.native_table_id === 'S0034-T04') {
      assert.ok(context.some(block => block.paragraph === 1199), 'Signal hardware note must accompany personnel table T04');
    }
    if (point.native_table_id === 'S0034-T02') {
      assert.ok(!context.some(block => block.paragraph === 1199), 'Personnel note must not be assigned to catalog T02');
      assert.ok(context.some(block => block.paragraph === 342), 'Catalog standard-update note missing');
    }
    const children = semanticTablePoints(point, table, document, context);
    if (!children) continue;
    replacements.set(point.knowledge_point_id, children);
    parentTables.push({ ...point, status: '父表关联；按原生语义分组，不重复作为完整表切片',
      child_knowledge_point_ids: children.map(child => child.knowledge_point_id) });
    master = replaceWithTableChildren(master, point, children, table);
  }
  const semanticParents = new Set(parentTables.map(point => point.knowledge_point_id));
  const semanticChildren = points.flatMap(point => replacements.get(point.knowledge_point_id) || [point])
    .filter(point => !semanticParents.has(point.knowledge_point_id));
  points.splice(0, points.length, ...semanticChildren);
  const titleIndex = source.blocks.findIndex(block => block.type === 'paragraph'
    && normalize(block.text) === normalize(document.title));
  assert.ok(titleIndex > 0, `${docID}: original regulation title absent`);
  const notice = source.blocks.slice(0, titleIndex).filter(block => block.type === 'paragraph' && clean(block.text));
  const noticePoint = {
    doc_id: docID, knowledge_point_id: `${docID}-NOTICE`, domain_code: document.domain,
    kind: 'publication_notice', heading: '印发通知、发文机关和发布日期',
    source_ids: [document.source_id], source_version: document.version,
    source_paragraphs: notice.map(block => block.paragraph),
    source_location: `${document.source_id}原文段落${notice[0].paragraph}-${notice.at(-1).paragraph}`,
    text: `文档：${document.title}；版本：${document.version}；此处为印发通知，不将印发日期当作施行日期。\n${notice.map(block => `${block.label ? `${block.label} ` : ''}${block.text.trim()}`).join('\n\n')}`,
  };
  const introStart = master.indexOf('## 正文与附件\n');
  const firstChapter = master.indexOf('## 第一章 ', introStart);
  assert.ok(introStart >= 0 && firstChapter > introStart, `${docID}: notice replacement boundaries absent`);
  master = `${master.slice(0, introStart)}## 印发通知\n\n### ${noticePoint.knowledge_point_id} ${noticePoint.heading}\n\n${noticePoint.text}\n\n${master.slice(firstChapter)}`;
  points.unshift(noticePoint);
  for (const note of standaloneTableNotes.filter(item => item.source_id === source.source_id)) {
    const paragraph = source.blocks.find(block => block.type === 'paragraph' && block.paragraph === note.paragraph);
    assert.ok(paragraph && clean(paragraph.text), `${note.table_id}: standalone source note absent`);
    const sourceText = paragraph.text.trim();
    const point = {
      doc_id: docID, knowledge_point_id: `${docID}-SOURCE-NOTE-P${note.paragraph}`, domain_code: document.domain,
      kind: 'source_note_pending_attribution', heading: note.heading,
      source_ids: [document.source_id], source_version: document.version,
      source_paragraphs: [note.paragraph], adjacent_native_table_id: note.table_id,
      source_location: `${note.source_id}原文段落${note.paragraph}，${note.table_id}后、下一附件前`,
      attribution_review: note.reason,
      text: `文档：${document.title}；版本：${document.version}；来源：${document.source_id}。\n原文注释（不扩张适用范围）：${sourceText}\n整理者归属说明：${note.reason}\n来源定位：${note.source_id}原文段落${note.paragraph}（Word段落${paragraph.word_paragraph}），${note.table_id}后、下一附件前。`,
      review_status: '原文已保留；注释适用归属待核；未试切；未导入',
    };
    const noteIndex = master.indexOf(sourceText);
    const lastChild = points.findLastIndex(item => item.native_table_id === note.table_id);
    assert.ok(lastChild >= 0, `${note.table_id}: source-note insertion boundary absent`);
    const pointMarkdown = `### ${point.knowledge_point_id} ${point.heading}\n\n${point.text}\n\n`;
    if (noteIndex >= 0) {
      assert.equal(master.indexOf(sourceText, noteIndex + sourceText.length), -1,
        `${note.table_id}: duplicate source note before context separation`);
      master = master.replace(sourceText, pointMarkdown.trimEnd());
    } else {
      const lastChildHeading = `### ${points[lastChild].knowledge_point_id} `;
      const lastChildStart = master.indexOf(lastChildHeading);
      assert.ok(lastChildStart >= 0, `${note.table_id}: final child heading absent`);
      const nextHeading = master.indexOf('\n### ', lastChildStart + lastChildHeading.length);
      assert.ok(nextHeading >= 0, `${note.table_id}: next attachment boundary absent`);
      master = `${master.slice(0, nextHeading + 1)}${pointMarkdown}${master.slice(nextHeading + 1)}`;
    }
    assert.equal(master.split(sourceText).length - 1, 1,
      `${note.table_id}: source note must occur exactly once after context separation`);
    points.splice(lastChild + 1, 0, point);
  }
  if (docID === 'DOC0027') {
    const paragraphs = [618, 619].map(number => source.blocks.find(block => block.type === 'paragraph' && block.paragraph === number));
    assert.ok(paragraphs.every(Boolean), 'Communication personnel source paragraphs absent');
    const personnel = {
      doc_id: docID, knowledge_point_id: `${docID}-ANNEX3-PERSONNEL`, domain_code: document.domain,
      kind: 'personnel_requirements', heading: '附件3专业技术人员资格、专业和比例要求',
      source_ids: [document.source_id], source_version: document.version, source_paragraphs: [618, 619],
      source_location: 'S0035附件3，原文段落618-619（Word段落717-718）',
      text: `文档：${document.title}；版本：${document.version}；适用范围：本细则附件3专业技术人员要求。\n${paragraphs.map(block => block.text.trim()).join('\n\n')}\n来源定位：S0035附件3，原文段落618-619；两段共同保留，不将比例与人员资格分离。`,
    };
    const originalParagraphs = paragraphs.map(block => block.text.trim()).join('\n\n');
    assert.ok(master.includes(originalParagraphs), 'Communication personnel paragraphs absent from master');
    master = master.replace(originalParagraphs, `### ${personnel.knowledge_point_id} ${personnel.heading}\n\n${personnel.text}`);
    const next = points.findIndex(point => point.native_table_id === 'S0035-T03');
    assert.ok(next > 0, 'Communication attachment4 table boundary missing');
    points.splice(next, 0, personnel);
  }
  assert.equal(points.filter(point => point.kind === 'article').length, 27);
  for (const point of expected.knowledge_points.filter(point => point.kind === 'article')) {
    assert.deepEqual(points.find(item => item.knowledge_point_id === point.knowledge_point_id), point);
  }
  const unique = new Set(points.map(point => point.knowledge_point_id));
  assert.equal(unique.size, points.length, `${docID}: duplicate knowledge IDs`);
  assert.equal((master.match(/^# /gmu) || []).length, 1);
  assert.equal((master.match(/^### DOC/gmu) || []).length, points.length);
  for (const point of points) {
    assert.ok(master.includes(`### ${point.knowledge_point_id} `), `${point.knowledge_point_id}: absent from master`);
    if (point.parent_knowledge_point_id) assert.ok(normalize(master).includes(normalize(point.text)));
  }
  for (const point of points) {
    const modelText = `文档：${document.title}（${docID}）；版本：${document.version}；来源：${document.source_id}；定位：${point.source_location}\n知识点：${point.knowledge_point_id} ${point.heading}\n${point.text}`;
    point.embedding_tokens_with_full_prefix = tokenizer.encode(modelText).ids.length;
  }
  const expectedPath = `04-chunks/expected/${docID}-successor-v3.json`;
  const normalizeSource = value => normalize(value.replaceAll('\\|', '|').replaceAll('<br>', '\n'));
  const masterText = normalizeSource(master);
  const pointText = points.map(point => ({ id: point.knowledge_point_id, text: normalizeSource(point.text) }));
  const paragraphCoverage = source.blocks.filter(block => block.type === 'paragraph' && clean(block.text)).map(block => {
    const value = normalizeSource(block.text);
    assert.ok(masterText.includes(value), `${docID}: source paragraph ${block.paragraph} absent from master`);
    const matches = pointText.filter(point => point.text.includes(value)).map(point => point.id);
    const structural = /^第[一二三四五六七八九十百零〇]+章/u.test(clean(block.text))
      || /^附件(?:\s*\d+|[：:])/u.test(clean(block.text))
      || /^\d+[.．、]/u.test(clean(block.text)) && /^(?:[1-8])[.．、](?:铁路|专业|产品|国家)/u.test(clean(block.text))
      || value === normalize(document.title);
    return { paragraph: block.paragraph, word_paragraph: block.word_paragraph, text: block.text.trim(),
      classification: matches.length ? 'candidate-text' : structural ? 'structure-retained-in-master' : 'uncovered-substantive-paragraph',
      knowledge_point_ids: matches };
  });
  const uncovered = paragraphCoverage.filter(block => block.classification === 'uncovered-substantive-paragraph');
  assert.equal(uncovered.length, 0, `${docID}: uncovered source paragraphs: ${uncovered.map(block => block.paragraph).join(',')}`);
  for (const table of source.tables) {
    const tableText = normalizeSource(points.filter(point => point.native_table_id === table.table_id).map(point => point.text).join('\n'));
    for (const row of table.rows) for (const cell of row.cells) {
      if (normalizeSource(cell.text)) assert.ok(tableText.includes(normalizeSource(cell.text)),
        `${cell.cell_id}: nonempty source cell not covered`);
    }
  }
  prepared.push({ docID, document, oldMaster, master,
    expectedPath, expected: { ...expected, generated_at: now, revision: 'successor-v3',
      previous_expected_path: `04-chunks/expected/${docID}-successor-v2.json`,
      status: '拆分已落实的预期候选；未通过全篇语义/视觉、效力和真实试切验收',
      paragraph_coverage: paragraphCoverage,
      parent_tables: parentTables, knowledge_points: points },
    audit: { doc_id: docID, domain: document.domain, master_path: document.master_path,
      old_master_sha256: hash(oldMaster), master_sha256: hash(master), original_sha256: hash(original),
      v2_snapshot_path: v2Master || `${history}/${document.master_path}`,
      expected_path: expectedPath, old_point_count: expected.knowledge_points.length,
      article_count: 27, split_table_count: groups.length,
      row_point_count: groups.reduce((sum, group) => sum + group.entries.length, 0),
      semantic_group_count: points.filter(point => point.parent_knowledge_point_id).length,
      semantic_parent_table_count: parentTables.length,
      preserved_other_point_count: points.filter(point => !point.parent_knowledge_point_id).length,
      point_count: points.length,
      paragraph_count: paragraphCoverage.length,
      substantive_uncovered_paragraphs: uncovered,
      paragraph_coverage_verified: true,
      all_nonempty_native_cells_covered: true,
      maximum_prefixed_tokens: Math.max(...points.map(point => point.embedding_tokens_with_full_prefix)),
      points_over_900: points.filter(point => point.embedding_tokens_with_full_prefix > 900).map(point => ({ id: point.knowledge_point_id, tokens: point.embedding_tokens_with_full_prefix })),
      points_over_8192: points.filter(point => point.embedding_tokens_with_full_prefix > 8192).map(point => point.knowledge_point_id),
      structure_accepted: false, trial_executed: false, formal_import_executed: false } });
}

for (const item of prepared) {
  if (item.document.structure_v3) {
    await save(`${history}/${item.expectedPath}`, await readFile(path.join(root, item.expectedPath)));
  }
}
if (registry.some(document => ids.includes(document.doc_id) && document.structure_v3)) {
  await save(`${history}/05-review/successor-masters-v3.json`,
    await readFile(path.join(root, '05-review/successor-masters-v3.json')));
}
for (const control of controls) await save(`${history}/00-control/${control}`, await readFile(path.join(root, '00-control', control)));
for (const item of prepared) await save(`${history}/${item.document.master_path}`, item.oldMaster);
for (const item of prepared) {
  await save(item.document.master_path, item.master);
  await save(item.expectedPath, item.expected);
  item.document.status = '待复核';
  item.document.sha256 = item.audit.master_sha256;
  item.document.structure_v3 = { at: now, knowledge_points: item.audit.point_count,
    expected_path: item.expectedPath, history_snapshot: history,
    v2_snapshot_path: item.audit.v2_snapshot_path,
    structure_status: '待精修/待复核；非结构通过', trial_status: '未试切', formal_import_status: '未导入' };
}
await save('00-control/document-register.json', registry);
for (const filename of ['domain-register.md', 'structure-register.md']) {
  const relative = `00-control/${filename}`;
  const previous = await readFile(path.join(root, relative), 'utf8');
  await save(relative, `${previous.trimEnd()}\n\n## 替代细则 v3 语义分组候选（${now}）\n\n以下为当前本地主副本的候选数，不构成结构通过、真实切片或有效数量验收。条款ID未变，整表父ID保留，不与子知识点重复切片。\n\n| doc_id | 主领域 | 候选总数 | 语义分组数 | 分组原表数 | 当前预期清单 | 状态 |\n| --- | --- | --- | --- | --- | --- | --- |\n${prepared.map(({ audit }) => `| ${audit.doc_id} | ${audit.domain} | ${audit.point_count} | ${audit.semantic_group_count} | ${audit.semantic_parent_table_count} | ${audit.expected_path} | 待逐格语义/视觉、效力核验；未试切、未导入 |`).join('\n')}\n`);
}
const report = { checked_at: now, history_snapshot: history, original_files_unchanged: true,
  formal_dataset_modified: false, final_acceptance: false,
  tokenizer_sha256: hash(tokenizerBytes), reranker_budget_verified: false,
  token_scope: 'Document/version/source/location/point heading prefix and complete candidate text; not actual pipeline output.',
  documents: prepared.map(item => item.audit) };
await save('05-review/successor-masters-v3.json', report);
const progress = await readFile(path.join(root, '00-control/progress.md'), 'utf8');
await save('00-control/progress.md', `${progress.trimEnd()}\n\n## 替代细则 v3 语义分组落实（${now}）\n\n- 四篇当前复核稿已用${prepared.reduce((sum, item) => sum + item.audit.semantic_group_count, 0)}个语义分组替换${prepared.reduce((sum, item) => sum + item.audit.semantic_parent_table_count, 0)}个整表点；共${prepared.reduce((sum, item) => sum + item.audit.point_count, 0)}个预期候选点。108个法规条款ID和正文保持不变，父表ID及完整原表文本保存在v3关联清单，旧主副本、预期清单和审计均已快照保留。\n- 已修复不同产品区段串用旧表头的问题；设备表只携带本区段表头、速度档及合并原格。登记表SHA-256对应当前主副本，不使用缺失哈希上传。\n- 对照检查了标题数量、稳定ID、源文件哈希、原文段落、非空原格和嵌入token预算。机器检查不等于逐格业务或法规语义终审；超过900 tokens的完整项目须语义复核，不机械拆散。\n- 原件、正式库、旧记录及生产设置未改。四篇继续不计有效量，未试切、未导入，未通过结构或检索验收。\n- 下一步：全表语义边界与源行映射检查、疑点核对、实际重排服务复查；结构验收后才隔离试切。证据：\`05-review/successor-masters-v3.json\`。\n`);
console.log(JSON.stringify(report, null, 2));
