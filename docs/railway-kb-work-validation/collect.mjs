import { parseHTML, save, load } from './run.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from './run.mjs';

export function nodes(node, predicate, result = []) {
  if (predicate(node)) result.push(node);
  for (const child of node.childNodes || []) nodes(child, predicate, result);
  return result;
}
export function text(node) {
  if (['script', 'style', 'noscript'].includes(node.tagName)) return '';
  if (node.nodeName === '#text') return node.value;
  const content = (node.childNodes || []).map(text).join('');
  return ['p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3'].includes(node.tagName) ? content + '\n' : content;
}
export const attr = (node, name) => node.attrs?.find(a => a.name === name)?.value;
export async function page(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
      'Referer': 'https://www.nra.gov.cn/'
    },
    signal: AbortSignal.timeout(45000)
  });
  if (!r.ok) throw Error(`${r.status} ${url}`);
  return r.text();
}
if (process.argv[2] === 'list') {
  const results = [];
  const base = 'https://www.nra.gov.cn/xxgk/gkml/ztjg/gfzd/';
  for (const category of ['bmgz', 'gfzd', 'xzzf']) {
    for (let i = 0; i < 5; i++) {
      const url = `${base}${category}/${i ? `index_${i}.shtml` : ''}`;
      try {
        const html = await page(url);
        await save(`01-originals/catalogs/${category}-${i}.html`, html);
        for (const a of nodes(parseHTML(html), n => n.tagName === 'a')) {
          const href = attr(a, 'href');
          const title = (attr(a, 'title') || text(a)).trim();
          if (href && /铁路|接触网|信号|机车|车辆|供电|隧道|桥梁/.test(title) && /t\d+_/.test(href)) {
            results.push({ title, url: new URL(href, url).href });
          }
        }
      } catch (e) { console.log('CATALOG_ERROR', e.message); }
    }
  }
  const unique = [...new Map(results.map(r => [r.url, r])).values()];
  await save('00-control/candidates.json', unique);
  for (const r of unique) console.log(r.title, r.url);
}
if (process.argv[2] === 'fetch') {
  const list = await load('00-control/selected-sources.json');
  const first = Number(process.argv[3] || 0);
  for (const item of list.slice(first, first + 5)) {
    if (item.collected) continue;
    try {
      let html = await page(item.url);
      await save(`01-originals/web/${item.source_id}.html`, html);
      let tree = parseHTML(html);
      let zoom = nodes(tree, n => ['Zoom', 'Zoom1'].includes(attr(n, 'id')))[0];
      let body = zoom && text(zoom).replace(/[ \t\u00a0]+/g, ' ').replace(/ +$/gm, '').replace(/\n\s*\n/g, '\n\n').trim();
      let fetchedUrl = item.url;
      if ((!body || body.length < 1000) && /www\.nra\.gov\.cn/.test(item.url)) {
        const match = html.match(/https:\/\/xxgk\.mot\.gov\.cn\/[^\\'"<\s]+\.html(?:#[^\\'"<\s]+)?/);
        if (match) {
          fetchedUrl = match[0].replace(/&amp;/g, '&');
          html = await page(fetchedUrl);
          await save(`01-originals/web/${item.source_id}-linked.html`, html);
          tree = parseHTML(html);
          zoom = nodes(tree, n => ['Zoom', 'Zoom1'].includes(attr(n, 'id')))[0];
          body = zoom && text(zoom).replace(/[ \t\u00a0]+/g, ' ').replace(/ +$/gm, '').replace(/\n\s*\n/g, '\n\n').trim();
        }
      }
      if (!zoom) throw Error('Official article container missing');
      if (body.length < 1000) throw Error(`Only ${body.length} characters; inspect attachments`);
      const metadata = Object.fromEntries(nodes(tree, n => n.tagName === 'meta').map(n => [attr(n, 'name'), attr(n, 'content')]));
      Object.assign(item, { collected: new Date().toISOString(), fetched_url: fetchedUrl, metadata, characters: body.length,
        original_path: `01-originals/web/${item.source_id}.txt` });
      delete item.error;
      await save(item.original_path, body);
      console.log(JSON.stringify({ ...item, metadata: undefined }));
    } catch (e) {
      item.error = e.message;
      console.log('SOURCE_ERROR', item.source_id, e.message);
    }
    await save('00-control/selected-sources.json', list);
  }
}
if (process.argv[2] === 'read') {
  const list = await load('00-control/selected-sources.json');
  for (const item of list.slice(Number(process.argv[3] || 0), Number(process.argv[3] || 0) + 5)) {
    if (item.original_path) console.log('\nSOURCE', item.source_id, item.title, '\n',
      await readFile(path.join(root, item.original_path), 'utf8'));
  }
}
