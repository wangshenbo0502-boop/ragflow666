import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const Root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(path.join(Root, 'web/package.json'));
const { parse } = require('parse5');
const Sources = [
  ['railway-safety', '铁路安全管理条例', 'safety', 'xzzf/202111/t20211111_261218.shtml'],
  ['railway-emergency', '铁路交通事故应急救援和调查处理条例', 'safety', 'xzzf/202111/t20211111_261219.shtml'],
  ['passenger-transport', '铁路旅客运输规程', 'passenger', 'bmgz/202211/t20221117_338894.shtml'],
  ['passenger-security', '铁路旅客运输安全检查管理办法', 'passenger', 'bmgz/202401/t20240102_344299.shtml'],
  ['real-name-tickets', '铁路旅客车票实名制管理办法', 'passenger', 'bmgz/202211/t20221125_339122.shtml'],
  ['equipment-quality', '铁路设备质量安全监督管理办法', 'equipment', 'bmgz/202308/t20230828_342877.shtml'],
];

function find(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.childNodes ?? []) {
    const match = find(child, predicate);
    if (match) return match;
  }
}

function text(node) {
  if (['script', 'style', 'noscript'].includes(node.tagName)) return '';
  if (node.nodeName === '#text') return node.value;
  const body = (node.childNodes ?? []).map(text).join('');
  return ['p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3'].includes(node.tagName)
    ? `${body}\n`
    : body;
}

const output = path.join(Root, 'web/public/railway');
await mkdir(output, { recursive: true });
const manifest = [];
for (const [id, title, category, resource] of Sources) {
  const url = `https://www.nra.gov.cn/xxgk/gkml/ztjg/gfzd/${resource}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${title}: HTTP ${response.status}`);
  const html = await response.text();
  const document = parse(html);
  const content = find(document, (node) =>
    node.attrs?.some(({ name, value }) =>
      name === 'id' && value === 'Zoom',
    ),
  );
  if (!content) throw new Error(`${title}: official article container missing`);
  const body = text(content).replace(/[ \t\u00a0]+/g, ' ').replace(/ +$/gm, '').replace(/\n\s*\n/g, '\n\n').trim();
  if (body.length < 1000 || !body.includes('第一条')) {
    throw new Error(`${title}: incomplete article; refuse to import`);
  }
  const collectedAt = new Date().toISOString();
  const entry = {
    id, title, category, url, publisher: '国家铁路局',
    collectedAt, characters: body.length,
    sha256: '',
    file: `${id}.md`,
    versionStatus: '官方网页存档，适用版本需由使用单位复核',
  };
  const markdown = `# ${title}\n\n发布网站：国家铁路局\n\n来源：${url}\n\n采集时间：${collectedAt}\n\n版本说明：${entry.versionStatus}。本资料用于知识查询与培训，不包含现场设备检修规程。\n\n---\n\n${body}\n`;
  entry.sha256 = createHash('sha256').update(markdown).digest('hex');
  await writeFile(path.join(output, entry.file), markdown, 'utf8');
  manifest.push(entry);
  console.log(`${title}: ${body.length} characters`);
}
await writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
