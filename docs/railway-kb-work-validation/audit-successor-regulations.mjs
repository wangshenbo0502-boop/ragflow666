import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { hash, load, root, save } from './run.mjs';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const JSZip = require('jszip');
const { DOMParser } = require('@xmldom/xmldom');
const specs = [
  { source: 'S0033', doc: 'DOC0025', title: '铁路道岔设备生产企业审批实施细则', number: '国铁设备监规〔2026〕4号', domain: 'GW', file: '01-originals/attachments/S0033-1.docx', expected: ['铁路道岔设备目录', 'TXDC'] },
  { source: 'S0034', doc: 'DOC0026', title: '铁路信号设备生产企业审批实施细则', number: '国铁设备监规〔2026〕5号', domain: 'XH', file: '01-originals/attachments/S0034-1.docx', expected: ['铁路信号设备目录', '铁路信号设备生产企业审查表'] },
  { source: 'S0035', doc: 'DOC0027', title: '铁路通信设备生产企业审批实施细则', number: '国铁设备监规〔2026〕6号', domain: 'XH', file: '01-originals/attachments/S0035-1.docx', expected: ['铁路通信设备目录', '铁路通信设备生产企业审查表'] },
  { source: 'S0036', doc: 'DOC0028', title: '铁路牵引供电设备生产企业审批实施细则', number: '国铁设备监规〔2026〕7号', domain: 'GD', file: '01-originals/attachments/S0036-1.doc', expected: [] },
];
const noticeURL = 'https://www.nra.gov.cn/xxgk/gkml/ztjg/gfzd/gfxw/zuti/xzxk/202603/t20260305_350842.shtml';
const noticePath = '01-originals/web/S0032.html';
const noticeBytes = await readFile(new URL(noticePath, `file:///${root.replaceAll('\\', '/')}`));
const noticeText = noticeBytes.toString('utf8')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
  .replace(/<[^>]+>/gu, ' ')
  .replace(/&nbsp;|&#160;/giu, ' ')
  .replace(/&ldquo;|&rdquo;/giu, '"')
  .replace(/&amp;/giu, '&')
  .replace(/\s+/gu, ' ')
  .trim();
assert.match(noticeText, /自2026年4月1日起施行/u);
assert.match(noticeText, /国铁设备监规〔2025〕14号/u);
assert.match(noticeText, /同时废止/u);

const sourceRegister = await load('00-control/source-register.json');
const documentRegister = await load('00-control/document-register.json');
const fullRegister = await load('00-control/document-register-full.json');
const extracted = [];
for (const spec of specs) {
  const bytes = await readFile(new URL(spec.file, `file:///${root.replaceAll('\\', '/')}`));
  let body = null;
  if (spec.file.endsWith('.docx')) {
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file('word/document.xml').async('string');
    const document = new DOMParser().parseFromString(xml, 'application/xml');
    body = Array.from(document.getElementsByTagName('w:p'), paragraph =>
      Array.from(paragraph.getElementsByTagName('w:t'), node => node.textContent).join(''))
      .filter(Boolean).join('\n');
    for (const expected of spec.expected) assert.ok(body.includes(expected), `${spec.source}: missing ${expected}`);
    await save(`01-originals/attachments/${spec.source}-1.txt`, body + '\n');
  } else {
    body = await readFile(new URL(`01-originals/attachments/${spec.source}-1.txt`, `file:///${root.replaceAll('\\', '/')}`), 'utf8').catch(() => null);
  }
  if (body) assert.ok(body.includes(spec.title), `${spec.source}: title missing from extracted body`);
  extracted.push({
    ...spec,
    sha256: hash(bytes),
    bytes: bytes.length,
    extraction: body
      ? `${spec.file.endsWith('.docx') ? 'DOCX' : 'DOC'}正文已提取；附件目录、表格和全部条款仍待逐项语义复核`
      : '旧式DOC原件已保存；当前环境无可靠提取器，未推测正文',
    extracted_path: body ? `01-originals/attachments/${spec.source}-1.txt` : null,
    extracted_sha256: body ? hash(body) : null,
    characters: body?.length ?? null,
    annex_references: body ? [...new Set(body.match(/附件[1-8]/gu) || [])] : [],
  });
}

const sourceRows = [
  { source_id: 'S0032', title: '国家铁路局关于印发四项设备生产企业审批实施细则并废止原总则细则的公告', publisher: '国家铁路局', url: noticeURL, original_path: noticePath, published: '2026-03-03', version: '四项细则分别为国铁设备监规〔2026〕4、5、6、7号；自2026-04-01施行；国铁设备监规〔2025〕14号同时废止', scope: '四项专业细则生效与原总则细则废止关系', domain: 'GD', access_date: '2026-11-16', sha256: hash(noticeBytes), status: '官方通知正文已核对；明确2026-04-01施行及原细则同时废止', relation: 'supersedes', previous_source_ids: ['S0016'], count_as_additional_document: false, attachments: [] },
  ...specs.map(spec => {
    const item = extracted.find(entry => entry.source === spec.source);
    return {
      source_id: spec.source, title: `国家铁路局关于印发《${spec.title}》的通知`, publisher: '国家铁路局',
      url: `https://www.nra.gov.cn/xxgk/gkml/ztjg/gfzd/gfxw/zuti/xzxk/202603/${spec.source === 'S0033' ? 't20260305_350843.shtml' : spec.source === 'S0034' ? 't20260306_350846.shtml' : spec.source === 'S0035' ? 't20260306_350847.shtml' : 't20260306_350848.shtml'}`,
      original_path: item.file, attachment_path: item.file, attachment_sha256: item.sha256,
      published: '2026-02-28', version: `${spec.number}；2026-02-28印发，2026-04-01施行`,
      scope: spec.title, domain: spec.domain, access_date: '2026-11-16',
      status: item.extraction, relation: 'supersedes_part_of', previous_source_ids: ['S0016'],
      count_as_additional_document: false, attachments: [{ path: item.file, sha256: item.sha256, extracted_path: item.extracted_path }],
    };
  }),
];
for (const row of sourceRows) {
  const index = sourceRegister.findIndex(item => item.source_id === row.source_id);
  if (index < 0) sourceRegister.push(row);
  else sourceRegister[index] = { ...sourceRegister[index], ...row };
}

const old = documentRegister.find(item => item.doc_id === 'DOC0014');
assert.ok(old, 'DOC0014 must exist');
Object.assign(old, {
  count_as_valid: false,
  status: '已废止；历史原件与原库版本保留并停用作当前依据',
  exclusion_reason: '国家铁路局2026-03-03通知明确国铁设备监规〔2025〕14号自2026-04-01起废止；四项专业细则分别替代其适用设备范围。',
  superseded_by_doc_ids: ['DOC0025', 'DOC0026', 'DOC0027', 'DOC0028'],
  superseded_by_source_id: 'S0032',
  historical_original_preserved: true,
});
const fullOld = fullRegister.expanded?.find(item => item.doc_id === 'DOC0014')
  || fullRegister.baseline.find(item => item.doc_id === 'DOC0014');
Object.assign(fullOld, old);

for (const spec of specs) {
  const item = extracted.find(entry => entry.source === spec.source);
  const doc = {
    doc_id: spec.doc,
    source_id: spec.source,
    title: spec.title,
    domain: spec.domain,
    count_as_valid: false,
    status: item.extraction,
    exclusion_reason: '候选待完整正文、附件表格、效力及结构验收；未整理主文档、未试切、未入正式库。',
    original_path: item.file,
    master_path: null,
    source_url: sourceRows.find(source => source.source_id === spec.source).url,
    attachment_sha256: item.sha256,
    extracted_path: item.extracted_path,
    article_count: null,
    annex_references: item.annex_references,
    version: `${spec.number}；2026-02-28印发，2026-04-01施行`,
    scope: spec.title,
    supersedes_source_id: 'S0016',
    extraction_review_required: true,
  };
  const index = documentRegister.findIndex(existing => existing.doc_id === spec.doc);
  if (index < 0) documentRegister.push(doc);
  else documentRegister[index] = { ...documentRegister[index], ...doc };
  const fullIndex = fullRegister.expanded.findIndex(existing => existing.doc_id === spec.doc);
  if (fullIndex < 0) fullRegister.expanded.push(doc);
  else fullRegister.expanded[fullIndex] = { ...fullRegister.expanded[fullIndex], ...doc };
}
fullRegister.count = {
  ...fullRegister.count,
  current_candidates: documentRegister.filter(item => item.count_as_valid).length,
  expansion_candidates: documentRegister.filter(item => item.count_as_valid && Number(item.doc_id.slice(3)) > 6).length,
  valid_candidates_not_finally_accepted: documentRegister.filter(item => item.count_as_valid).length,
  superseded_excluded_candidates: documentRegister.filter(item => item.count_as_valid === false && item.status.startsWith('已废止')).length,
  new_unaccepted_successor_documents: specs.length,
};
await save('00-control/source-register.json', sourceRegister);
await save('00-control/document-register.json', documentRegister);
await save('00-control/document-register-full.json', fullRegister);
const sourceMarkdown = await readFile(new URL('00-control/source-register.md', `file:///${root.replaceAll('\\', '/')}`), 'utf8');
const sourceLines = sourceRows.map(row => `| ${row.source_id} | ${row.title} | ${row.publisher} | ${row.published} | ${row.version} | ${row.domain} | ${row.url} | ${row.original_path} | ${row.access_date} | ${row.status} | ${row.previous_source_ids?.join(', ') || ''} | ${row.source_id === 'S0032' ? 'S0033-S0036' : ''} | ${row.relation} |`);
const knownSourceIDs = new Set([...sourceMarkdown.matchAll(/^\| (S\d{4}) \|/gmu)].map(match => match[1]));
const newSourceLines = sourceLines.filter(line => !knownSourceIDs.has(line.split('|')[1].trim()));
if (newSourceLines.length) {
  await save('00-control/source-register.md', `${sourceMarkdown.trimEnd()}\n${newSourceLines.join('\n')}\n\nS0016原件及旧知识库文档保留；S0032已核实其于2026-04-01废止，当前检索效力状态应按superseded处理。\n`);
}
const docLines = specs.map(spec => {
  const item = extracted.find(entry => entry.source === spec.source);
  return `| ${spec.doc} | ${spec.title} | ${spec.source} | ${spec.doc} | 待核验，不计入已验收量 | ${item.file} | 待整理 | ${spec.domain} | 新增官方替代细则 | 待正文/附件复核 | ${item.extraction} | 未上传 | 待核验效力、附件与试切 |`;
});
const docMarkdown = await readFile(new URL('00-control/document-register.md', `file:///${root.replaceAll('\\', '/')}`), 'utf8');
const knownDocIDs = new Set([...docMarkdown.matchAll(/^\| (DOC\d{4}) \|/gmu)].map(match => match[1]));
const newDocLines = docLines.filter(line => !knownDocIDs.has(line.split('|')[1].trim()));
if (newDocLines.length) {
  await save('00-control/document-register.md', `${docMarkdown.trimEnd()}\n${newDocLines.join('\n')}\n\nDOC0014：2025版总则细则已于2026-04-01废止。原件、原库历史文件和旧切片保留，但不作为当前有效依据；新四项细则均未计入验收量。\n`);
}
await save('05-review/official-successor-regulations-v1.json', {
  checked_at: new Date().toISOString(),
  notice: { source_id: 'S0032', url: noticeURL, original_path: noticePath, sha256: hash(noticeBytes), text: noticeText },
  successors: extracted,
  old_document: { doc_id: 'DOC0014', count_as_valid: false, preserved: true, original_dataset_mutated: false },
  status: '废止关系已由官方通知核实；新细则的正文、附件、结构、试切和正式入库尚未验收',
});
console.log(JSON.stringify({ notice_sha256: hash(noticeBytes), old_document: old, successors: extracted }, null, 2));
