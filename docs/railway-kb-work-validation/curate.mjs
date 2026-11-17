import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root, load, hash, save } from './run.mjs';

const domains = {
  GW: '工务与基础设施',
  XH: '通信信号与列车控制',
  GD: '牵引供电与电气设备',
  CL: '机车车辆与运用检修',
  YS: '运输组织与安全管理'
};
const sources = await load('00-control/selected-sources.json');
const docs = [];

for (const source of sources.filter(s => s.original_path)) {
  const raw = await readFile(path.join(root, source.original_path), 'utf8');
  const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const title = source.title.replace(/（2026）|（2025）|（2024）/g, '');
  const output = [
    `# ${title}`,
    '',
    `文档 ID：${source.source_id}`,
    `主领域：${source.domain} ${domains[source.domain]}`,
    `来源版本：${source.metadata?.PubDate || '详见原文发布信息，待逐项核验'}`,
    `适用范围：以原文规定为准；不得外推至原文范围以外`,
    `来源 URL：${source.fetched_url || source.url}`,
    `原件路径：${source.original_path}`,
    `原文字符数：${source.characters || raw.length}`,
    ''
  ];

  let articleCount = 0;
  let chapterCount = 0;
  let currentArticle = false;
  let firstTitle = true;
  for (const line of lines) {
    if (firstTitle && (line === title || line.includes(title))) {
      firstTitle = false;
      continue;
    }
    if (/^第[一二三四五六七八九十百零〇两0-9]+章/.test(line)) {
      output.push(`## ${line}`, '');
      chapterCount++;
      currentArticle = false;
      continue;
    }
    const article = line.match(/^(第[一二三四五六七八九十百零〇两0-9]+条)[　\s]*(.*)$/);
    if (article) {
      output.push(`### ${article[1]}`, '');
      if (article[2]) output.push(article[2], '');
      output.push(`**来源定位：** ${source.source_id}，${article[1]}。`, '');
      articleCount++;
      currentArticle = true;
      continue;
    }
    if (/^【PDF文件页序\d+】$/.test(line)) {
      output.push(`## ${line.replace(/[【】]/g, '')}`, '');
      currentArticle = false;
      continue;
    }
    if (/^(附件\s*\d+|[一二三四五六七八九十]+、|[一二三四五六七八九十]+．)/.test(line)) {
      output.push(`## ${line}`, '');
      chapterCount++;
      currentArticle = false;
      continue;
    }
    if (!currentArticle && /^(中华人民共和国.*令|国家铁路局文件|国铁.*通知|铁路.*目录)$/.test(line)) {
      output.push(`## ${line}`, '');
      chapterCount++;
      continue;
    }
    output.push(line, '');
  }

  const body = `${output.join('\n').trim()}\n`;
  const relative = `03-domains/${source.domain}/${source.source_id}-${title.replace(/[\\/:*?"<>|]/g, '-')}.md`;
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), body, 'utf8');
  const extractionReview = /pdfjs-text-layer; visual review pending/.test(source.extraction || '');
  docs.push({
    doc_id: source.source_id,
    source_id: source.source_id,
    title,
    domain: source.domain,
    count_as_valid: !extractionReview,
    status: extractionReview ? '待复核' : '待结构验收',
    exclusion_reason: extractionReview ? 'PDF文本层尚未完成逐页视觉复核，不计入有效文档' : '',
    original_path: source.original_path,
    master_path: relative,
    source_url: source.fetched_url || source.url,
    source_characters: source.characters || raw.length,
    article_count: articleCount,
    section_count: chapterCount,
    extraction_review_required: extractionReview,
    sha256: hash(body)
  });
}
await save('00-control/document-register.json', docs);
console.log(JSON.stringify({
  curated: docs.length,
  eligible_pending_review: docs.filter(d => d.count_as_valid).length,
  held_for_source_review: docs.filter(d => !d.count_as_valid).length,
  domains: Object.fromEntries(Object.keys(domains).map(d => [d, docs.filter(x => x.domain === d).length]))
}, null, 2));
