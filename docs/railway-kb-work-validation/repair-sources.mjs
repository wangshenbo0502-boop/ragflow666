import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { root, parseHTML, load, save, hash } from './run.mjs';
import { page, nodes, attr, text } from './collect.mjs';

const sources = await load('00-control/selected-sources.json');
const register = await load('00-control/document-register.json');
const updates = [
  {
    doc_id: 'DOC0010', source_id: 'S0028', domain: 'GW',
    title: '高速铁路基础设施运用状态检测管理办法',
    url: 'https://xxgk.mot.gov.cn/2020/jigou/fgs/202006/t20200623_3308061.html',
    expected: 37, version: '交通运输部令2018年第19号；2018-08-31公布，2018-10-01施行',
    scope: '设计开行时速250公里以上（含预留）、初期运营时速200公里以上的客运列车专线铁路基础设施运用状态检测。',
    previous: 'S0010',
  },
  {
    doc_id: 'DOC0016', source_id: 'S0029', domain: 'GD',
    title: '铁路专用产品质量监督抽查管理办法',
    url: 'https://source.nra.gov.cn/jglz/sbjg/fgsb/202602/t20260224_350762.shtml',
    expected: 55, version: '国铁设备监规〔2026〕3号；2026-02-09印发，2026-03-15施行',
    scope: '境内生产、销售或使用的铁路专用产品质量监督抽查；不提供特定型号检修参数。',
    previous: 'S0018',
  },
];
for (const item of updates) {
  const doc = register.find(d => d.doc_id === item.doc_id);
  const history = `05-review/history/pre-repair-${doc.doc_id}.md`;
  if (!(await readFile(path.join(root, history)).catch(() => null))) {
    await save(history, await readFile(path.join(root, doc.master_path)));
  }
  const html = await page(item.url);
  const tree = parseHTML(html);
  const container = nodes(tree, n => ['Zoom', 'Zoom1'].includes(attr(n, 'id')))[0];
  if (!container) throw Error(`No official article container: ${item.source_id}`);
  const body = text(container).replace(/^[\t 　]+/gm, '').replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n').trim();
  const count = [...body.matchAll(/^第[一二三四五六七八九十百]+条/gm)].length;
  if (count !== item.expected) throw Error(`${item.source_id}: ${count} articles`);
  const sourcePath = `01-originals/web/${item.source_id}.txt`;
  await save(`01-originals/web/${item.source_id}.html`, html);
  await save(sourcePath, body + '\n');
  let normalized = body;
  const corrections = [];
  if (item.doc_id === 'DOC0010') {
    // The scanned promulgated text retains the hyphen omitted in the HTML rendition.
    normalized = body.replace('（GSMR）', '（GSM-R）');
    corrections.push({ article: '第十条', official_html: 'GSMR', corrected: 'GSM-R',
      evidence: 'S0010-1.pdf，PDF页序5；原件图像已核对。' });
  }
  const normalizedPath = `02-normalized/reviewed/${item.doc_id}.txt`;
  await save(normalizedPath, normalized + '\n');
  const record = {
    ...item, collected: new Date().toISOString(), fetched_url: item.url,
    original_path: sourcePath, characters: body.length, sha256: hash(body + '\n'),
    publisher: item.doc_id === 'DOC0010' ? '交通运输部' : '国家铁路局',
    source_identity: item.doc_id === 'DOC0010' ? '同一2018版官方HTML交叉核对，不新增计数' : '替代2023版，不新增文献计数',
  };
  const sourceIndex = sources.findIndex(s => s.source_id === item.source_id);
  if (sourceIndex < 0) sources.push(record); else sources[sourceIndex] = record;
  Object.assign(doc, {
    source_id: item.source_id, original_path: sourcePath,
    normalized_path: normalizedPath, previous_source_ids: [item.previous],
    source_url: item.url, article_count: count, version: item.version, scope: item.scope,
    count_as_valid: true, status: '待归档', extraction_review_required: false,
    exclusion_reason: '', source_characters: normalized.length,
    version_verification: '已回读官方全文及施行条款；未发现该存档文本之外的适用结论，不将网站转载日期当公布日期。',
  });
  await save(`05-review/${doc.doc_id}-source-repair.json`, {
    doc_id: doc.doc_id, checked_at: new Date().toISOString(),
    old_source_id: item.previous, current_source_id: item.source_id,
    source_url: item.url, original_preserved: true, history_path: history,
    official_articles: count, normalized_sha256: hash(normalized + '\n'), corrections,
    scan_review: item.doc_id === 'DOC0010'
      ? { pages: 10, missing_articles_restored: ['第十一条', '第十二条'],
          corrupted_numbers_fixed: ['第二十条', '第三十一条'],
          cross_page_articles: [5, 8, 10, 12, 27, 33] }
      : { historical_pdf_pages: 23, current_articles: 55, historical_articles: 59,
          historical_status: '2026-03-15起废止；国铁设备监规〔2023〕18号，2023-07-25印发',
          earlier_unverified_metadata_rejected: ['2026年第2号', '2026-01-26', '2023年第14号', '2023-07-04', '新版第二十六条为5日异议期'],
          verified_deadlines: '2026版第三十二条：5日内送达检测报告；自收到检验结果通知单之日起15日内申请异议处理。' },
  });
  console.log(JSON.stringify({ doc_id: doc.doc_id, source: item.source_id, articles: count }));
}
const annexDoc = register.find(d => d.doc_id === 'DOC0014');
annexDoc.count_as_valid = false;
annexDoc.status = '待复核';
annexDoc.exclusion_reason = '附件1-8已在49页PDF中取得；复杂表格尚未全部视觉核对，不计最终有效数。';
annexDoc.attachment_path = '01-originals/attachments/S0016-1.pdf';
await save('00-control/selected-sources.json', sources);
await save('00-control/document-register.json', register);
