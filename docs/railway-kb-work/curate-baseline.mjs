import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root, hash, save } from './run.mjs';

const records = [
  ['S0001', 'DOC0001', '铁路设备质量安全监督管理办法', 'CL', '01_equipment-quality.md'],
  ['S0002', 'DOC0002', '铁路旅客车票实名制管理办法', 'YS', '02_real-name-tickets.md'],
  ['S0003', 'DOC0003', '铁路旅客运输安全检查管理办法', 'YS', '03_passenger-security.md'],
  ['S0004', 'DOC0004', '铁路旅客运输规程', 'YS', '04_passenger-transport.md'],
  ['S0005', 'DOC0005', '铁路交通事故应急救援和调查处理条例', 'YS', '05_railway-emergency.md'],
  ['S0006', 'DOC0006', '铁路安全管理条例', 'GW', '06_railway-safety.md']
];
const docs = [];
const sources = [];

for (const [source_id, doc_id, title, domain, filename] of records) {
  const original_path = `01-originals/baseline/${filename}`;
  const raw = await readFile(path.join(root, original_path), 'utf8');
  const url = raw.match(/^来源：(.+)$/m)?.[1]?.trim() || '待核验';
  const sourceTitle = raw.match(/^# (.+)$/m)?.[1]?.trim() || title;
  const contentStart = raw.indexOf('---');
  const lines = raw.slice(contentStart >= 0 ? raw.indexOf('\n', contentStart + 3) + 1 : 0)
    .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const out = [
    `# ${title}`,
    '',
    `文档 ID：${doc_id}`,
    `主领域：${domain}`,
    `来源 ID：${source_id}`,
    `来源版本：按原件发布信息；效力状态待逐项核验`,
    `适用范围：以原文规定为准`,
    `来源 URL：${url}`,
    `原件路径：${original_path}`,
    ''
  ];
  let articles = 0;
  let pendingArticle = false;
  for (const line of lines) {
    if (/^第[一二三四五六七八九十百零〇两0-9]+章/.test(line)) {
      out.push(`## ${line}`, '');
      pendingArticle = false;
      continue;
    }
    const article = line.match(/^(第[一二三四五六七八九十百零〇两0-9]+条)[　\s]*(.*)$/);
    if (article) {
      if (source_id === 'S0005' && article[1] === '第三十三条') {
        out.push('## 已删除历史条款（不作为现行依据）', '');
        out.push('原件保留了第三十三条旧赔偿限额文本，原文明确标注“2012年11月9日删除”。本整理稿不复录该已删除限额，不能据此回答现行赔偿标准。', '');
        pendingArticle = false;
        continue;
      }
      out.push(`### ${article[1]}`, '');
      if (article[2]) out.push(article[2], '');
      out.push(`**来源定位：** ${source_id}，${article[1]}。`, '');
      articles++;
      pendingArticle = true;
      continue;
    }
    if (/^#/.test(line) || /^发布网站：|^来源：|^采集时间：|^版本说明：/.test(line)) continue;
    if (pendingArticle) out.push(line, '');
  }
  const master_path = `03-domains/${domain}/${doc_id}-${title}.md`;
  const body = `${out.join('\n').trim()}\n`;
  await mkdir(path.dirname(path.join(root, master_path)), { recursive: true });
  await writeFile(path.join(root, master_path), body, 'utf8');
  docs.push({
    doc_id, source_id, title, domain, count_as_valid: true, status: '待结构验收',
    original_path, master_path, source_url: url, article_count: articles,
    sha256: hash(body), extraction_review_required: false,
    note: source_id === 'S0005' ? '删除条款从检索稿隔离；原件保留' : ''
  });
  sources.push({
    source_id, title: sourceTitle, publisher: '国家铁路局 / 原文所载发布机关',
    url, original_path, access_date: '2026-11-15',
    status: url === '待核验' ? '来源地址待核验' : '官方来源快照；效力逐项核验',
    domain
  });
}

await save('00-control/baseline-curation.json', { docs, sources });
console.log(JSON.stringify({ docs: docs.length, domains: Object.fromEntries(['GW','XH','GD','CL','YS'].map(d => [d, docs.filter(x => x.domain === d).length])) }, null, 2));
