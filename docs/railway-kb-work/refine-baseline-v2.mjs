import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { root, load, save, hash } from './run.mjs';

const register = await load('00-control/document-register.json');
const selected = register.filter(d => d.source_id <= 'S0005');
const overrides = {
  S0001: { version: '交通运输部令2023年第7号；2023-09-01施行', scope: '中华人民共和国境内铁路设备质量安全监督管理；不提供具体设备检修作业步骤。' },
  S0002: { version: '交通运输部令2022年第37号；2023-01-01施行', scope: '中华人民共和国境内铁路旅客车票实名购买、查验活动。' },
  S0003: { version: '交通运输部令2023年第21号；2024-02-01施行', scope: '中华人民共和国境内铁路旅客运输安全检查工作。' },
  S0004: { version: '交通运输部令2022年第_fix', scope: '中华人民共和国境内铁路旅客运输；运输企业另行公布的具体业务规则仍须结合对应规则核验。' },
  S0005: { version: '国务院令第501号；2007-09-01施行；按2012-11-09修订文本整理', scope: '铁路机车车辆运行事故的应急救援和调查处理；历史删除条文不作为现行赔偿限额依据。' },
};
overrides.S0004.version = '交通运输部令2022年第37号；2023-01-01施行';

function cleanLine(s) {
  return s.replace(/^[\s　]+/, '').trim();
}
function titleFrom(text, sourceID, article) {
  const lead = cleanLine(text).replace(/^[（(]?[一二三四五六七八九十]+[）)、，.．]\s*/, '');
  const firstClause = lead.split(/[。；;]/, 1)[0].replace(/[：:，,]\s*$/, '');
  const title = [...firstClause].slice(0, 24).join('');
  return `${article}｜${title || '补充规定'}`;
}

for (const doc of selected) {
  const raw = await readFile(path.join(root, doc.original_path), 'utf8');
  const sourceLines = raw.split(/\r?\n/).map(cleanLine).filter(Boolean);
  const title = doc.title;
  const meta = overrides[doc.source_id];
  const url = doc.source_url;
  const output = [
    `# ${title}`, '',
    `文档 ID：${doc.doc_id}`,
    '资料性质：官方规章原文整理',
    `主领域：${doc.domain}`,
    `来源 ID：${doc.source_id}`,
    `来源版本：${meta.version}`,
    `适用范围：${meta.scope}`,
    '效力状态：按所列公布及施行信息整理；截至整理日的现行效力及后续修订仍须以主管部门最新公布文本核验。',
    `原文地址：${url}`,
    `原件路径：${doc.original_path}`,
    '整理日期：2026-11-15',
    '',
    '## 阅读范围', '',
    `本文按官方原文条款整理《${title}》，保留条款编号、限制、例外和原文定位。本文不推导原文未规定的现场操作步骤、实时信息或其他版本结论。`,
    '',
  ];
  let chapter = '';
  let articleCount = 0;
  let pending = [];
  for (const line of sourceLines) {
    if (/^第[一二三四五六七八九十百零〇两0-9]+章/.test(line)) {
      if (pending.length) output.push(...pending, '');
      pending = [];
      chapter = line;
      output.push(`## ${line}`, '');
      continue;
    }
    const m = line.match(/^(第[一二三四五六七八九十百零〇两0-9]+条)[\s　]*(.*)$/);
    if (m) {
      if (pending.length) output.push(...pending, '');
      pending = [];
      const article = m[1];
      let body = m[2];
      if (doc.source_id === 'S0005' && article === '第三十三条') {
        body = '本条赔偿责任限额规定已于2012年11月9日删除。原始存档中仍可见被删除的历史文字；为避免将其误作现行赔偿标准，本检索整理稿不收录已删除的限额数字。请勿据此条推断现行赔偿责任限额。';
      }
      output.push(`### ${titleFrom(body, doc.source_id, article)}`, '',
        `**原文条款：** ${article}`,
        `**适用范围：** ${meta.scope}`,
        `**来源定位：** ${doc.source_id}，《${title}》${chapter ? `，${chapter}` : ''}，${article}。`,
        `**原文地址：** ${url}`, '',
        body, '');
      articleCount++;
      continue;
    }
    if (/^\(2012年11月9日删除\)|^（2012年11月9日删除）/.test(line)) continue;
    if (!chapter && /^(中华人民共和国.*令|.*年.*月.*日)$/.test(line)) {
      pending.push(line);
      continue;
    }
    if (/^发布网站：|^来源：|^采集时间：|^版本说明：|^---$/.test(line)) continue;
    if (doc.source_id === 'S0005' && line.startsWith('（2012年11月9日删除）')) continue;
    if (doc.source_id === 'S0005' && pending.length && pending.some(x => x.startsWith('第三十三条'))) continue;
    output.push(line, '');
  }
  const body = `${output.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
  const filename = path.basename(doc.master_path);
  await save(doc.master_path, body);
  doc.sha256 = hash(body);
  doc.status = '待整理';
  doc.article_count = articleCount;
  doc.reconstruction_date = '2026-11-15';
  doc.version = meta.version;
  doc.scope = meta.scope;
  doc.note = doc.source_id === 'S0005'
    ? '检索稿已隔离2012年删除的第三十三条限额正文；原件保留。第三十五条的历史条款引用需结合2012年修订文本核验。'
    : '按真实条款内容生成检索标题；条款正文及来源定位保留。';
  console.log(JSON.stringify({ doc_id: doc.doc_id, source_id: doc.source_id, filename, articleCount, sha256: doc.sha256 }));
}
await save('00-control/document-register.json', register);
await save('00-control/baseline-reconstruction-batch-01.json', selected.map(d => ({
  doc_id: d.doc_id, source_id: d.source_id, title: d.title, master_path: d.master_path,
  article_count: d.article_count, sha256: d.sha256, status: d.status, note: d.note,
})));
