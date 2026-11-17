import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { hash, load, root, save } from './run.mjs';

const auditDir = '05-review/successor-structure';
const register = await load('00-control/document-register.json');
const domainRegister = await readFile(path.join(root, '00-control/domain-register.md'), 'utf8');
const specs = [
  ['S0033', 'DOC0025', 'GW'],
  ['S0034', 'DOC0026', 'XH'],
  ['S0035', 'DOC0027', 'XH'],
  ['S0036', 'DOC0028', 'GD'],
];
const escCell = value => String(value).replaceAll('|', '\\|').replace(/\r?\n/gu, '<br>');
const emptyCell = '〔原表该单元格为空；未推定含义〕';
const points = [];
const outcomes = [];
const snapshot = `05-review/history/successor-v2-repair-${new Date().toISOString().replaceAll(/[:.]/gu, '-')}`;
for (const relative of [
  '00-control/document-register.json', '00-control/domain-register.md',
  '00-control/structure-register.md', '00-control/import-register.md',
  '00-control/source-register.md', '00-control/source-register.json',
  '00-control/progress.md', '05-review/successor-masters-v2.json',
  '05-review/successor-draft-audit-v2.json',
  '04-chunks/expected/successor-v2-knowledge-points.json',
  ...specs.flatMap(([, docID]) => [
    register.find(item => item.doc_id === docID).master_path,
    `04-chunks/expected/${docID}-successor-v2.json`,
  ]),
]) {
  await save(`${snapshot}/${relative}`, await readFile(path.join(root, relative)));
}

function tableMarkdown(table) {
  const width = table.grid_columns;
  const matrix = [];
  const cells = new Map(table.rows.flatMap(row => row.cells).map(cell => [cell.cell_id, cell]));
  for (const row of table.rows) {
    const values = Array(width).fill('');
    for (const cell of row.cells) {
      const text = cell.text.trim();
      for (let offset = 0; offset < cell.column_span; offset++) {
        const column = cell.column + offset - 1;
        values[column] = offset === 0
          ? (text || emptyCell)
          : `〔横向合并自C${cell.column}〕`;
      }
      if (cell.vertical_merge === 'continue') {
        const origin = cells.get(cell.origin_cell_id);
        assert.ok(origin, `${cell.cell_id}: unresolved vertical merge origin`);
        const marker = `〔纵向合并续格，自R${origin.row}C${origin.column}〕`;
        values[cell.column - 1] = `${text ? `${text} ` : ''}${marker}`;
      }
    }
    matrix.push(values.map(escCell));
  }
  return [
    `**原表列数：** ${width}；**原表行数：** ${table.row_count}。`,
    '',
    '下表按原生网格展开。`〔横向合并自…〕`、`〔纵向合并续格…〕`只标示原表合并关系；空白不推定为“同上”、零或“不适用”。',
    '',
    `| ${Array.from({ length: width }, (_, index) => `原列${index + 1}`).join(' | ')} |`,
    `| ${Array(width).fill('---').join(' | ')} |`,
    ...matrix.map(row => `| ${row.join(' | ')} |`),
  ].join('\n');
}

for (const [sourceID, docID, domain] of specs) {
  const audited = await load(`${auditDir}/${sourceID}-native-tables-v2.json`);
  const spec = audited;
  const doc = register.find(item => item.doc_id === docID);
  assert.ok(doc, `${docID}: missing document register`);
  assert.equal(audited.doc_id, docID);
  assert.equal(audited.official_attachment_matches, true);
  const body = await readFile(path.join(root, audited.original_path));
  assert.equal(hash(body), audited.original_sha256, `${sourceID}: original hash changed`);
  const sourceText = await readFile(path.join(root, `01-originals/attachments/${sourceID}-1.txt`), 'utf8');
  assert.ok(sourceText.includes(doc.title), `${sourceID}: extracted text does not identify the regulation`);

  const blocks = audited.blocks;
  let sequence = 0;
  let articleID = 0;
  let tableIndex = 0;
  const sections = [];
  let currentArticle = null;
  const content = [
    `# ${doc.title}`, '',
    `文档 ID：${docID}`,
    `资料性质：官方行政规范性文件原件结构整理稿`,
    `主领域：${domain}`,
    `来源 ID：${sourceID}`,
    `来源版本：${doc.version}`,
    `适用范围：${doc.scope}`,
    `效力状态：国家铁路局发布页及附件已核对；具体现行效力和业务适用仍待终审`,
    `整理日期：2026-11-16`,
    '',
    '## 阅读范围',
    '',
    '本稿按官方附件的正文顺序整理，保留条款、附件表格、表格空白和合并单元格标记，用于后续逐项语义复核。它不是法规全文的替代证明；需要作出许可判断时必须回到官方原件及现行制度。',
    '',
    '原件中的通知、正文和附件一并保留。自动编号按只读 Word 展示标签恢复；表格中的数值、单位、适用速度等级、外协条件和备注尚未完成人工逐格复核。',
    '',
    '## 正文与附件',
    '',
  ];
  for (const block of blocks) {
    if (block.type === 'paragraph') {
      const text = block.text.trim();
      if (!text) continue;
      const fullText = `${block.label ? `${block.label} ` : ''}${text}`;
      const chapter = fullText.match(/^第([一二三四五六七八九十百零〇]+)章\s*(.*)$/u);
      const article = fullText.match(/^第([一二三四五六七八九十百零〇]+)条/u);
      const attachment = fullText.match(/^附件([一二三四五六七八九十百零〇\d]+)\s*(.*)$/u);
      if (chapter) {
        content.push(`## ${fullText}`, '');
        currentArticle = null;
        continue;
      }
      if (/^附件[：:]/u.test(fullText)) {
        currentArticle = null;
        content.push('## 原文附件目录', '', fullText, '');
        continue;
      }
      if (article) {
        articleID++;
        sequence++;
        currentArticle = `${docID}-K${String(sequence).padStart(3, '0')}`;
        points.push({
          doc_id: docID, knowledge_point_id: currentArticle, domain_code: domain,
          kind: 'article', heading: fullText, source_ids: [sourceID],
          source_location: `${doc.version}，${fullText.match(/^第[^，。；：]+条/u)?.[0]}`,
          text: fullText,
        });
        content.push(`### ${currentArticle} ${fullText}`, '');
        continue;
      }
      if (attachment) {
        currentArticle = null;
        content.push(`## ${fullText}`, '');
        continue;
      }
      if (/^(国家铁路局|国家铁路|第[一二三四五六七八九十百零〇\d]+部分)/u.test(fullText)) {
        if (currentArticle && !/^第[一二三四五六七八九十百零〇\d]+部分/u.test(fullText)) {
          const point = points.find(item => item.knowledge_point_id === currentArticle);
          point.text += `\n\n${fullText}`;
          content.push(fullText, '');
        } else {
          content.push(`## ${fullText}`, '');
        }
        if (/^第[一二三四五六七八九十百零〇\d]+部分/u.test(fullText)) currentArticle = null;
        continue;
      }
      if (currentArticle) {
        const point = points.find(item => item.knowledge_point_id === currentArticle);
        point.text += `\n\n${fullText}`;
      }
      content.push(`${fullText}`, '');
      continue;
    }
    const table = audited.tables.find(item => item.table_id === block.table_id);
    assert.ok(table, `${block.table_id}: audit table missing`);
    tableIndex++;
    sequence++;
    const tablePoint = `${docID}-K${String(sequence).padStart(3, '0')}`;
    const preceding = table.preceding_paragraphs.map(item => item.text.trim()).filter(Boolean).slice(-2);
    const heading = preceding.at(-1) || `原生表格 ${tableIndex}`;
    const text = `来源表格 ${table.table_id}；${table.row_count}行、${table.grid_columns}列。${preceding.join('；')}`;
    points.push({
      doc_id: docID, knowledge_point_id: tablePoint, domain_code: domain,
      kind: 'source_table', heading, source_ids: [sourceID],
      source_location: `${doc.version}，${table.table_id}，原附件表格顺序 ${tableIndex}`,
      native_table_id: table.table_id, source_text_complete: true,
      text: `${text}\n\n${tableMarkdown(table)}`,
    });
    content.push(`### ${tablePoint} ${heading}`, '',
      `**原文定位：** ${table.table_id}，原生 Word 表格第1至${table.row_count}行，共${table.grid_columns}列。`,
      '', tableMarkdown(table), '');
  }
  const annexError = sourceText.match(/晨云提议/u);
  if (sourceID === 'S0036') {
    assert.ok(annexError, 'Known source anomaly disappeared from extracted original');
    content.push(
      '## 待核验事项', '',
      '- 附件3专业技术人员要求表中，备注栏含官方附件原文“晨云提议”。官方发布页重新下载的附件与本地原件 SHA-256 一致；该文字不作为已确认的人员条件解释。未经发布机关澄清，不删除、不改写该原件文字。', '',
    );
  } else {
    content.push('## 待核验事项', '',
      '- 表格已保留原生单元格文本、行列位置和合并关系；数值、单位、适用范围、速度等级、外协条件、空白含义及表注仍须人工逐格复核。', '',
    );
  }
  content.push('## 来源清单', '',
    '| 来源 ID | 标题与发布者 | 版本 | 原文地址 | 原件路径 |',
    '| --- | --- | --- | --- | --- |',
    `| ${sourceID} | ${doc.title}，国家铁路局 | ${doc.version} | ${doc.source_url} | ${audited.original_path} |`,
    '',
    `官方发布页：${audited.official_page.url}`,
    `官方附件 SHA-256：${audited.original_sha256}`,
    '',
    '> 本文件是审计和结构整理稿，未通过逐项事实复核、有效性终审、试切或正式入库验收；不得单独作为当前业务依据。',
    '');

  const masterPath = `03-domains/${domain}/${docID}_${doc.title}_复核稿.md`;
  await save(masterPath, content.join('\n'));
  const expected = points.filter(point => point.doc_id === docID);
  await save(`04-chunks/expected/${docID}-successor-v2.json`, {
    doc_id: docID, domain_code: domain, source_id: sourceID,
    source_sha256: audited.original_sha256, master_path: masterPath,
    generated_at: new Date().toISOString(),
    status: '预期知识点清单；待逐点语义、来源定位、长度预算人工复核；非真实系统切片',
    knowledge_points: expected,
  });
  doc.master_path = masterPath;
  doc.article_count = articleID;
  doc.status = '结构化主副本已生成；待逐条、逐表人工语义复核及效力终审';
  doc.exclusion_reason = '未通过表格语义复核、效力终审及切片验收，不计入有效文献量；正式库旧版未替换。';
  doc.extraction_review_required = true;
  doc.structure_v2 = {
    at: new Date().toISOString(), knowledge_points: expected.length,
    articles_detected: articleID, native_tables: tableIndex,
    expected_path: `04-chunks/expected/${docID}-successor-v2.json`,
    source_audit: `${auditDir}/${sourceID}-native-tables-v2.json`,
    structure_status: '自动结构导出通过；语义/表格人工审核未完成',
    trial_status: '未试切', formal_import_status: '未导入',
  };
  outcomes.push({
    doc_id: docID, domain, master_path: masterPath, source_sha256: audited.original_sha256,
    articles: articleID, tables: tableIndex, knowledge_points: expected.length,
    source_anomaly: sourceID === 'S0036' ? '官方附件含“晨云提议”，原样记录并阻塞解释' : null,
  });
}

const batches = [];
const grouped = new Map();
for (const point of points) {
  if (!grouped.has(point.doc_id)) grouped.set(point.doc_id, []);
  grouped.get(point.doc_id).push(point);
}
for (const [docID, items] of grouped) {
  batches.push({ doc_id: docID, points: items.length, table_points: items.filter(item => item.kind === 'source_table').length });
}
await save('04-chunks/expected/successor-v2-knowledge-points.json', {
  checked_at: new Date().toISOString(), status: 'Generated from official-hash-matched originals; pending human fact review',
  documents: batches, count: points.length,
  warning: 'Knowledge-point extraction and Markdown structure are drafts, not semantic acceptance or a chunker result.',
});
await save('00-control/document-register.json', register);
const mapRows = outcomes.map(item =>
  `| ${item.doc_id} | ${register.find(row => row.doc_id === item.doc_id).title} | ${item.domain} |  | 核心对象为对应设备类别生产许可 | ${item.doc_id}官方附件 | ${item.master_path} | 国铁设备监规〔2026〕细则；官方附件哈希匹配 | 自动结构稿，逐条逐表待复核 |`);
if (!domainRegister.includes('DOC0025')) {
  await save('00-control/domain-register.md',
    `${domainRegister.trimEnd()}\n\n## 替代细则结构整理候选（非有效文献验收）\n\n| doc_id | 标题 | 主领域 | 辅助领域 | 正文判断依据 | 原路径 | 当前主副本路径 | 版本状态 | 处理结果 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n${mapRows.join('\n')}\n`);
}
const structurePath = '00-control/structure-register.md';
let structure = await readFile(path.join(root, structurePath), 'utf8');
structure = structure.replace(
  /^\| DOC0014 \|[^\r\n]*$/mu,
  '| DOC0014 | S0016 | 铁路运输基础设备生产企业审批实施细则 | GD | 49 | 历史版本已停用 | 原文切片留存；2026-04-01起已废止，不作现行依据 |',
);
if (!structure.includes('## 四项替代细则结构化候选')) {
  const lines = outcomes.map(item =>
    `| ${item.doc_id} | ${register.find(row => row.doc_id === item.doc_id).source_id} | ${register.find(row => row.doc_id === item.doc_id).title} | ${item.domain} | ${item.knowledge_points}（${item.articles}条款+${item.tables}张表） | 未上传；结构草稿 | 官方原件哈希、正文顺序及表格网格机器核对通过；人工语义复核待完成 |`);
  structure += `\n## 四项替代细则结构化候选\n\n自动导出保留官方原文段落、自动编号和原生表格网格/合并关系；下列数量为候选知识点，尚未通过逐格语义复核。不得视为结构验收通过或真实系统切片。\n\n| doc_id | source_id | 标题 | 主领域 | 候选知识点数 | 系统状态 | 机器核验范围 |\n| --- | --- | --- | --- | --- | --- | --- |\n${lines.join('\n')}\n`;
}
await save(structurePath, structure);
const importPath = '00-control/import-register.md';
let importRegister = await readFile(path.join(root, importPath), 'utf8');
if (!importRegister.includes('## 四项替代细则 v2 结构候选')) {
  const lines = outcomes.map(item =>
    `| ${item.doc_id} | ${item.domain} | ${path.basename(item.master_path)} | ${item.source_sha256} | 66ff4d9d5ff748af8e83080bd7482f04 | 未创建 | ${register.find(row => row.doc_id === item.doc_id).source_id} | 未入库 | 结构草稿；语义复核待完成 | 未上传 | 未执行 | 未执行 | 未核验 |`);
  importRegister += `\n## 四项替代细则 v2 结构候选\n\n这四份主副本与预期知识点仅用于逐条逐表人工复核。原库中的旧资料和历史版本不变；本批尚未隔离试切，不可与DOC0022/0023的试切记录混淆。\n\n| doc_id | 主领域 | 文件名 | SHA-256 | 目标库 ID | 系统文档 ID | 来源 | 管道版本 | 结构复核 | 上传 | 解析 | 切片数 | 核验状态 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n${lines.join('\n')}\n`;
}
await save(importPath, importRegister);
const sourceMarkdownPath = '00-control/source-register.md';
let sourceMarkdown = await readFile(path.join(root, sourceMarkdownPath), 'utf8');
for (const item of outcomes) {
  const sourceID = register.find(row => row.doc_id === item.doc_id).source_id;
  const audit = await load(`${auditDir}/${sourceID}-native-tables-v2.json`);
  const status = '官方附件SHA-256与本地原件匹配；正文顺序、原生表格网格和合并关系已审计，语义/效力待复核';
  sourceMarkdown = sourceMarkdown.replace(
    new RegExp(`^(\\| ${sourceID} \\|[^\\r\\n]*\\| 2026-11-16 \\| )[^|]*(\\| S0016 \\|[^\\r\\n]*)$`, 'mu'),
    `$1${status}$2`,
  );
  assert.ok(sourceMarkdown.includes(`| ${sourceID} |`), `${sourceID}: source markdown row missing`);
  assert.equal(audit.official_attachment_matches, true);
}
await save(sourceMarkdownPath, sourceMarkdown);
const sources = await load('00-control/source-register.json');
for (const item of outcomes) {
  const sourceID = item.doc_id === 'DOC0025' ? 'S0033'
    : item.doc_id === 'DOC0026' ? 'S0034'
      : item.doc_id === 'DOC0027' ? 'S0035' : 'S0036';
  const row = sources.find(source => source.source_id === sourceID);
  row.status = '官方发布页与附件复下哈希匹配；原生表格/自动编号审计完成，主副本生成；逐单元格语义复核与效力终审待完成';
  row.official_attachment_sha256_verified = true;
  row.structure_audit_path = `${auditDir}/${sourceID}-native-tables-v2.json`;
}
await save('00-control/source-register.json', sources);
const progressPath = '00-control/progress.md';
let progress = await readFile(path.join(root, progressPath), 'utf8');
const progressTitle = '## 替代细则官方附件复核与结构化主副本 v2（2026-11-16）';
const progressEntry = `${progressTitle}\n\n- 四份替代细则均从国家铁路局官方发布页重新下载附件并逐字节 SHA-256 比对，全部匹配本地原件；原件未改动。\n- Word 正文非空段落与结构导出按顺序一致；共导出 ${outcomes.reduce((n, item) => n + item.tables, 0)} 张原生表格、${outcomes.reduce((n, item) => n + item.knowledge_points, 0)} 个候选知识点。行列网格、自动编号、空白单元格与横纵合并映射均保留。\n- DOC0025–DOC0028 已生成结构化 Markdown 复核稿和预期知识点清单；四篇仍不计有效文献量，均未试切、未正式导入、未替代原库旧版。\n- S0036 附件3备注“晨云提议”经官方附件哈希确认是官方文件中的真实文字；保留并标待澄清，不据此臆断。\n- 表格自动转换仅完成结构与文本完整性检查，不等于逐格核实适用条件、阈值、单位、脚注与视觉版面。下一步人工逐篇审表、抽核正文和来源效力，通过后才做隔离试切。\n`;
const progressStart = progress.indexOf(progressTitle);
if (progressStart < 0) {
  progress = `${progress.trimEnd()}\n\n${progressEntry}`;
} else {
  const nextHeading = progress.indexOf('\n## ', progressStart + progressTitle.length);
  progress = `${progress.slice(0, progressStart)}${progressEntry}${nextHeading < 0 ? '' : progress.slice(nextHeading + 1)}`;
}
await save(progressPath, progress);
await save('05-review/successor-masters-v2.json', {
  checked_at: new Date().toISOString(), sources_officially_hash_matched: true,
  originals_modified: false, formal_dataset_modified: false,
  final_acceptance: false, documents: outcomes,
});
console.log(JSON.stringify({ documents: outcomes, knowledge_point_count: points.length }, null, 2));
