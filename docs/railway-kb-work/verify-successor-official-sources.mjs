import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { hash, load, parseHTML, root, save } from './run.mjs';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const folder = `05-review/successor-official-${stamp}`;
const register = await load('00-control/document-register.json');
const selected = register.filter(doc => ['DOC0025', 'DOC0026', 'DOC0027', 'DOC0028'].includes(doc.doc_id));
const directoryURL = 'https://www.nra.gov.cn/xxgk/gkml/ztjg/gfzd/gfxw/zuti/xzxk/';
const jointURL = new URL('202603/t20260305_350842.shtml', directoryURL).href;
const text = node => {
  if (['#comment', 'script', 'style'].includes(node.nodeName)) return '';
  if (node.nodeName === '#text') return node.value;
  return (node.childNodes || []).map(text).join('');
};
const walk = (node, visit) => {
  visit(node);
  for (const child of node.childNodes || []) walk(child, visit);
};
async function page(url, label) {
  const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
  assert.equal(response.status, 200, url);
  const bytes = Buffer.from(await response.arrayBuffer());
  const html = bytes.toString('utf8');
  const dom = parseHTML(html);
  const links = [];
  const metadata = {};
  let title;
  let article;
  walk(dom, node => {
    if (node.nodeName === 'title') title = text(node).trim();
    const attrs = Object.fromEntries((node.attrs || []).map(attr => [attr.name, attr.value]));
    if (node.nodeName === 'meta' && attrs.name) metadata[attrs.name] = attrs.content;
    if (node.nodeName === 'a' && attrs.href) {
      try { links.push({ title: text(node).trim(), url: new URL(attrs.href, url).href }); } catch {}
    }
    const classes = (attrs.class || '').split(/\s+/);
    if (classes.includes('gksqxz_main_content')
      || (!article && classes.includes('TRS_Editor'))) article = text(node).trim();
  });
  await save(`${folder}/${label}.html`, bytes);
  return {
    requested_url: url, final_url: response.url, http_status: response.status,
    snapshot_path: `${folder}/${label}.html`, snapshot_sha256: hash(bytes),
    title, metadata, article_text: article, links,
  };
}

// Sequential requests keep the official site load small and make failures attributable.
const directory = await page(directoryURL, 'licensing-directory');
const joint = await page(jointURL, 'joint-notice');
assert.ok(joint.article_text?.includes('2026年4月1日'), 'Joint notice effective date missing');
assert.ok(joint.article_text?.includes('废止'), 'Joint notice repeal statement missing');
const documents = [];
for (const doc of selected) {
  const official = await page(doc.source_url, doc.source_id);
  assert.ok(official.title.includes(doc.title), `Title mismatch: ${doc.doc_id}`);
  const candidates = official.links.filter(link => /\.(docx?|pdf)$/i.test(new URL(link.url).pathname));
  const originalBytes = await readFile(path.join(root, doc.original_path));
  const attachments = [];
  for (const [index, attachment] of candidates.entries()) {
    const response = await fetch(attachment.url, { signal: AbortSignal.timeout(45000) });
    assert.equal(response.status, 200, attachment.url);
    const bytes = Buffer.from(await response.arrayBuffer());
    const snapshotPath = `${folder}/${doc.source_id}-attachment-${index + 1}${path.extname(new URL(attachment.url).pathname)}`;
    await save(snapshotPath, bytes);
    attachments.push({ ...attachment, http_status: response.status, bytes: bytes.length,
      snapshot_path: snapshotPath, sha256: hash(bytes), matches_local_original: hash(bytes) === hash(originalBytes) });
  }
  assert.ok(attachments.some(item => item.matches_local_original), `No original match: ${doc.doc_id}`);
  documents.push({ doc_id: doc.doc_id, source_id: doc.source_id,
    local_original_path: doc.original_path, local_original_sha256: hash(originalBytes),
    official_page: official, attachments, listed_in_current_directory:
      directory.links.some(link => link.url === doc.source_url),
    source_identity_verified: true,
    legal_effectiveness: 'Official identity, stated effective date and joint-notice repeal relationship verified; later amendment search is bounded to the fetched licensing directory.',
  });
}
const result = {
  checked_at: new Date().toISOString(), directory, joint_notice: joint, documents,
  search_scope: 'The current NRA administrative-licensing directory and the four individual pages and joint notice, including their linked attachments. No site-wide, national legal database or regulator interpretation search was performed.',
  not_inferred: ['A template/comment value such as -1 does not establish legal effectiveness.',
    'Absence of a later entry in this directory does not prove absence of any later amendment.',
    'Publication on March 6 is distinct from issue on February 28 and effect on April 1.'],
  source_originals_changed: false, registers_changed: false,
  structure_or_import_approved: false,
};
await save(`${folder}/evidence.json`, result);
console.log(JSON.stringify({ evidence_path: `${folder}/evidence.json`,
  documents: documents.map(item => ({ doc_id: item.doc_id,
    source_identity_verified: item.source_identity_verified,
    matched_attachments: item.attachments.filter(a => a.matches_local_original).length })),
  joint_notice_text: joint.article_text, search_scope: result.search_scope }, null, 2));
