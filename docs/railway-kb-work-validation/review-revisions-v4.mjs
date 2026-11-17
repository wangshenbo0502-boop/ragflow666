import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { hash, load, parseHTML, root, save } from './run.mjs';
import { attr, nodes, page, text } from './collect.mjs';

const definitions = [
  { source_id: 'S0030', doc_id: 'DOC0022', previous_source_id: 'S0025',
    url: 'https://www.nra.gov.cn/xxgk/gkml/ztjg/gfzd/bmgz/202206/t20220624_327466.shtml',
    title: '交通运输部关于修改《铁路机车车辆设计制造维修进口许可办法》的决定及重新公布全文',
    expected: ['交通运输部令2019年第3号', '2019年3月5日', '5年、8年、10年'],
    version: '交通运输部令2019年第3号；2019-02-03公布，2019-03-05施行' },
  { source_id: 'S0031', doc_id: 'DOC0023', previous_source_id: 'S0026',
    url: 'https://www.nra.gov.cn/xxgk/gkml/ztjg/gfzd/bmgz/202206/t20220624_327465.shtml',
    title: '交通运输部关于修改《铁路专用设备缺陷产品召回管理办法》的决定及重新公布全文',
    attachment_url: 'https://www.nra.gov.cn/xxgk/gkml/ztjg/gfzd/bmgz/202206/P020220624365785849781.pdf' },
];
const checks = [];
async function immutable(relative, bytes) {
  const existing = await readFile(path.join(root, relative)).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (existing) assert.equal(hash(existing), hash(bytes), `Snapshot changed: ${relative}`);
  else await save(relative, bytes);
}
for (const entry of definitions) {
  const previous = await readFile(path.join(root, `01-originals/web/${entry.previous_source_id}.txt`));
  const html = await page(entry.url);
  const tree = parseHTML(html);
  const container = nodes(tree, node => ['Zoom', 'Zoom1'].includes(attr(node, 'id')))[0];
  assert.ok(container, `${entry.source_id}: official article container missing`);
  const body = text(container).replace(/^[\t 　]+/gm, '').replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n').trim() + '\n';
  for (const expected of entry.expected || []) assert.ok(body.includes(expected), expected);
  await immutable(`01-originals/web/${entry.source_id}.html`, Buffer.from(html));
  await immutable(`01-originals/web/${entry.source_id}.txt`, Buffer.from(body));
  const report = { ...entry, checked_at: new Date().toISOString(),
    original_path: `01-originals/web/${entry.source_id}.txt`, sha256: hash(body),
    previous_sha256: hash(previous), original_preserved: true,
    latest_effectiveness_verified: false, remote_mutation: false };
  if (entry.attachment_url) {
    assert.ok(nodes(tree, node => node.tagName === 'a').some(node => {
      const href = attr(node, 'href');
      return href && new URL(href, entry.url).href === entry.attachment_url;
    }), 'Attachment must be linked from official page');
    const response = await fetch(entry.attachment_url, { signal: AbortSignal.timeout(45000) });
    assert.ok(response.ok, `PDF HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
    report.attachment_path = `01-originals/attachments/${entry.source_id}-1.pdf`;
    report.attachment_sha256 = hash(bytes);
    await immutable(report.attachment_path, bytes);
  }
  checks.push(report);
  console.log(JSON.stringify(report));
}
await save('05-review/revision-source-acquisition-v4.json', {
  checked_at: new Date().toISOString(), sources: checks,
  status: '官方修正来源已取得；全文、现行汇编及候选切片逐条核对后才可交付入库',
  remote_mutation: false, original_sources_preserved: true,
});
