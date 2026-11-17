import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {load, save, root, parseHTML, hash} from './run.mjs';
import {page, nodes, attr, text} from './collect.mjs';

const require = createRequire(path.resolve(root, '../../web/package.json'));
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
const list = await load('00-control/selected-sources.json');
const extra = [
  ['S0025', 'CL', '铁路机车车辆设计制造维修进口许可办法', 'https://source.nra.gov.cn/jglz/sbjg/fgsb/202204/t20220405_292242.shtml'],
  ['S0026', 'CL', '铁路专用设备缺陷产品召回管理办法', 'https://source.nra.gov.cn/jglz/sbjg/fgsb/202204/t20220405_292248.shtml'],
  ['S0027', 'GW', '高速铁路安全防护管理办法', '202207/t20220719_328628.shtml'],
];
for (const [source_id, domain, title, suffix] of extra) {
  const existing = list.find(x => x.source_id === source_id);
  const item = existing || {
    source_id, domain, title,
    url: suffix.startsWith('https://') ? suffix : 'https://www.nra.gov.cn/xxgk/gkml/ztjg/gfzd/bmgz/' + suffix,
    selection_reason: '补齐冻结问题集中的许可、召回及基础设施安全证据'
  };
  Object.assign(item, {
    domain, title,
    url: suffix.startsWith('https://') ? suffix : 'https://www.nra.gov.cn/xxgk/gkml/ztjg/gfzd/bmgz/' + suffix,
  });
  if (!existing) list.push(item);
}
await save('00-control/selected-sources.json', list);

if (process.argv[2] === 'attachments') {
  for (const id of ['S0010', 'S0016', 'S0018', 'S0019']) {
    const item = list.find(x => x.source_id === id);
    try {
      let html;
      try { html = await readFile(path.join(root, `01-originals/web/${id}.html`), 'utf8'); }
      catch { html = await page(item.url); }
      const links = nodes(parseHTML(html), n => n.tagName === 'a')
        .map(n => attr(n, 'href')).filter(x => x && /\.pdf(?:$|\?)/i.test(x));
      if (!links.length) throw Error('页面未暴露可下载PDF附件；图像目录暂不作为已核验全文');
      item.attachments = [];
      for (const [index, link] of [...new Set(links)].entries()) {
        const url = new URL(link, item.url).href;
        const response = await fetch(url, {signal: AbortSignal.timeout(60000)});
        if (!response.ok) throw Error(`HTTP ${response.status}: ${url}`);
        const data = new Uint8Array(await response.arrayBuffer());
        const original_path = `01-originals/attachments/${id}-${index + 1}.pdf`;
        await save(original_path, Buffer.from(data));
        const pdf = await pdfjs.getDocument({data, useSystemFonts: true, disableFontFace: true}).promise;
        const pages = [];
        for (let p = 1; p <= pdf.numPages; p++) {
          const content = await (await pdf.getPage(p)).getTextContent();
          let line = '';
          const lines = [];
          for (const token of content.items) {
            line += token.str;
            if (token.hasEOL) { lines.push(line); line = ''; }
          }
          if (line) lines.push(line);
          pages.push({pdf_page: p, text: lines.join('\n')});
        }
        const extracted = pages.map(p => `【PDF文件页序${p.pdf_page}】\n${p.text}`).join('\n\n');
        const text_path = `01-originals/attachments/${id}-${index + 1}.txt`;
        await save(text_path, extracted);
        await save(`01-originals/attachments/${id}-${index + 1}-pages.json`, pages);
        item.attachments.push({url, original_path, text_path, pages: pdf.numPages, sha256: hash(data), characters: extracted.length});
        if (['S0010', 'S0018'].includes(id) && extracted.length > 1500) {
          Object.assign(item, {original_path: text_path, characters: extracted.length, collected: new Date().toISOString(), fetched_url: url, extraction: 'pdfjs-text-layer; visual review pending'});
          delete item.error;
        }
        console.log(id, pdf.numPages, extracted.length, text_path);
      }
    } catch (error) {
      item.error = error.message;
      console.log(id, 'REVIEW', error.message);
    }
    await save('00-control/selected-sources.json', list);
  }
}
if (process.argv[2] === 'image') {
  const item = list.find(x => x.source_id === 'S0015');
  const html = await readFile(path.join(root, '01-originals/web/S0015.html'), 'utf8');
  const zoom = nodes(parseHTML(html), n => ['Zoom', 'Zoom1'].includes(attr(n, 'id')))[0];
  const image = nodes(zoom, n => n.tagName === 'img')[0];
  const url = new URL(attr(image, 'src'), item.url).href;
  const response = await fetch(url);
  if (!response.ok) throw Error(`Image HTTP ${response.status}`);
  await save('01-originals/attachments/S0015.jpg', Buffer.from(await response.arrayBuffer()));
  console.log(url);
}
