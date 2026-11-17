import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { root, load, save, hash, domains, table } from './run.mjs';

const register = await load('00-control/document-register.json');
const sources = await load('00-control/selected-sources.json');
const pipeline = await load('00-control/domain-pipeline.json');
const docIDs = new Map(register.map((doc, i) => [doc.source_id, `DOC${String(i + 1).padStart(4, '0')}`]));
const domainNames = {
  GW: '工务与基础设施', XH: '通信信号与列车控制',
  GD: '牵引供电与电气设备', CL: '机车车辆与运用检修',
  YS: '运输组织与安全管理',
};
const review = [];

for (const doc of register) {
  const source = sources.find(item => item.source_id === doc.source_id);
  const priorPath = doc.master_path;
  const title = doc.title.replace(/（2026）|（2025）|（2024）/g, '');
  if (doc.source_id === 'S0014') doc.domain = 'YS';
  doc.doc_id = docIDs.get(doc.source_id);
  doc.count_as_valid = doc.source_id !== 'S0010' && doc.source_id !== 'S0018' || true;

  const sourceDate = source?.metadata?.PubDate || source?.metadata?.pubdate || '详见发布原文';
  const version = doc.source_id === 'S0016'
    ? '2025年4月27日发布；2025年6月1日起施行'
    : sourceDate;
  const scope = '适用范围以该规章原文为准；不得外推至其他线路、设备或版本。';
  const sourceURL = source?.fetched_url || source?.url || doc.source_url || '待核验';
  const raw = await readFile(path.join(root, doc.original_path), 'utf8');
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const out = [
    `# ${title}`, '',
    `文档 ID：${doc.doc_id}`, `资料性质：原文整理`,
    `主领域：${doc.domain} ${domainNames[doc.domain]}`,
    `来源 ID：${doc.source_id}`, `来源版本：${version}`,
    `适用范围：${scope}`, `效力状态：效力及现行状态待逐项核验`,
    `来源 URL：${sourceURL}`, `原件路径：${doc.original_path}`,
    '', '## 阅读范围', '',
    `整理并保留《${title}》可核验的正文条款；技术数值、附件内容和例外仅在原文明确支持时适用。`,
    '',
  ];

  let inArticle = false;
  let articleCount = 0;
  let pendingLocator = '';
  for (const line of lines) {
    if (/^第[一二三四五六七八九十百零〇两0-9]+章/.test(line)) {
      if (pendingLocator) out.push(`**来源定位：** ${pendingLocator}。`, '');
      out.push(`## ${line}`, '');
      inArticle = false;
      pendingLocator = '';
      continue;
    }
    const article = line.match(/^(第[一二三四五六七八九十百零〇两0-9]+条)[　\s]*(.*)$/);
    if (article) {
      if (pendingLocator) out.push(`**来源定位：** ${pendingLocator}。`, '');
      out.push(`### ${article[1]}`, '',
        `**文档与版本：** ${doc.doc_id}《${title}》；${version}。`,
        `**适用范围：** ${scope}`,
        `**来源原文：** ${sourceURL}`,
        `**知识点：** ${article[1]} 的完整规定；保留条内条件、例外和依赖语句。`, '');
      if (article[2]) out.push(article[2], '');
      articleCount++;
      inArticle = true;
      pendingLocator = `${doc.source_id}，${article[1]}`;
      continue;
    }
    if (/^【PDF文件页序\d+】$/.test(line)) {
      if (pendingLocator) out.push(`**来源定位：** ${pendingLocator}。`, '');
      out.push(`## ${line.replace(/[【】]/g, '')}`, '');
      pendingLocator = '';
      inArticle = false;
      continue;
    }
    if (/^(附件\s*\d+|[一二三四五六七八九十]+、|[一二三四五六七八九十]+．)/.test(line)) {
      if (pendingLocator) out.push(`**来源定位：** ${pendingLocator}。`, '');
      out.push(`## ${line}`, '');
      pendingLocator = `${doc.source_id}，${line}`;
      inArticle = false;
      continue;
    }
    if (/^#/.test(line) || /^发布网站：|^来源：|^采集时间：|^版本说明：/.test(line)) continue;
    if (!inArticle && !pendingLocator) {
      // Retain introductory publication text and substantive unnumbered sections.
      out.push(line, '');
      continue;
    }
    out.push(line, '');
  }
  if (pendingLocator) out.push(`**来源定位：** ${pendingLocator}。`, '');

  const body = `${out.join('\n').trim()}\n`;
  const filename = `${doc.doc_id}_${title.replace(/[\\/:*?"<>|]/g, '-')}.md`;
  const relative = `03-domains/${doc.domain}/${filename}`;
  await save(relative, body);
  doc.title = title;
  doc.master_path = relative;
  doc.source_url = sourceURL;
  doc.article_count = articleCount || doc.article_count;
  doc.sha256 = hash(body);
  doc.status = doc.extraction_review_required ? '待复核' : '待结构验收';
  doc.count_as_valid = !doc.extraction_review_required;
  doc.exclusion_reason = doc.extraction_review_required
    ? '附件文字层含OCR错字，逐页复核未完成，不计有效文档。'
    : '';
  review.push({
    doc_id: doc.doc_id, source_id: doc.source_id, title, domain: doc.domain,
    prior_path: priorPath, master_path: relative, source_url: sourceURL,
    source_version: version, article_count: doc.article_count,
    content_sha256: doc.sha256, state: doc.status,
    preservation_check: '已保留原件；需通过完整正文对照及真实切片覆盖审计',
    notes: doc.source_id === 'S0016'
      ? '保留网页开头的修订说明；附件1-8原件另存，待分批逐项转录并核验。'
      : doc.source_id === 'S0014'
        ? '按正文核心改归YS运输组织；辅助领域XH，含信号及电缆保护条款。'
        : '',
  });
}

await save('00-control/document-register.json', register);
await save('00-control/structure-register.json', review);
await save('00-control/structure-register.md', [
  '# 结构精修登记', '',
  '条款编号、原文定位、版本和来源 URL 在各条款块内重复登记，确保独立检索时上下文可见。来源与效力未核实项保持显式待核验。', '',
  table(
    ['doc_id', 'source_id', '标题', '主领域', '条款数', '状态', '修改与复核'],
    review.map(doc => [
      doc.doc_id, doc.source_id, doc.title, doc.domain, doc.article_count, doc.state,
      `${doc.notes} ${doc.preservation_check}`.trim(),
    ]),
  ),
].join('\n'));

const baseline = await load('00-control/baseline-curation.json');
const domainRows = [
  ...baseline.docs.map(doc => ({ ...doc, source_id: doc.source_id, primary: doc.domain })),
  ...register.map(doc => ({ ...doc, primary: doc.domain })),
];
const domainRegister = [
  '# 五领域归档登记', '',
  '| doc_id | source_id | 标题 | 主领域 | 辅助领域 | 判断依据 | 原件路径 | 当前主副本路径 | 版本状态 | 处理状态 |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...domainRows.map(doc => {
    const auxiliary = doc.source_id === 'S0014' ? 'XH' : '';
    const evidence = doc.source_id === 'S0014'
      ? '正文以施工组织、天窗协调和参建职责为核心；信号、电缆保护为跨域要求。'
      : `正文核心对象与直接约束内容属于${doc.primary}领域。`;
    return `| ${doc.doc_id} | ${doc.source_id} | ${doc.title} | ${doc.primary} | ${auxiliary} | ${evidence} | ${doc.original_path} | ${doc.master_path} | 原文版本已登记，效力状态待逐项核验 | ${doc.status || '待结构验收'} |`;
  }),
].join('\n') + '\n';
await save('00-control/domain-register.md', domainRegister);

const importRows = domainRows.map(doc => {
  const trial = Object.values(pipeline.trials).find(item => item.source_id === doc.source_id);
  return `| ${doc.doc_id} | ${doc.primary} | ${doc.master_path} | ${doc.sha256} | ${trial?.dataset_id || ''} | ${trial?.document_id || ''} | ${doc.source_id === 'S0016' ? '2025-04-27；2025-06-01施行' : '详见来源登记'} | ${trial ? pipeline.pipeline_version_id : ''} | ${doc.extraction_review_required ? '待复核' : '待结构验收'} | ${trial ? '试切副本待替换核验' : '未上传'} | ${trial?.latest?.ingestion_status || '未解析'} | 未执行 | ${trial ? '试验库；不计为正式领域导入' : ''} |`;
});
await save('00-control/import-register.md', [
  '# 上传与解析登记', '',
  '| doc_id | 主领域 | Markdown路径 | SHA-256 | 目标知识库ID | 系统文档ID | 版本 | 管道版本 | 结构复核 | 上传 | 解析 | 检索 | 备注 |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...importRows,
  '',
].join('\n'));

console.log(JSON.stringify({
  documents: register.length,
  eligibleCandidates: register.filter(doc => doc.count_as_valid).length,
  held: register.filter(doc => !doc.count_as_valid).map(doc => doc.source_id),
  domains: Object.fromEntries(Object.keys(domains).map(code => [code, domainRows.filter(doc => doc.primary === code).length])),
  targets: Object.fromEntries(Object.entries(pipeline.trials).map(([code, item]) => [code, item.dataset_id])),
}, null, 2));
