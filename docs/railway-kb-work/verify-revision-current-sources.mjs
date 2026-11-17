import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { attr, nodes, text } from './collect.mjs';
import { articlesFrom, compact } from './reconstruct-v3.mjs';
import { hash, load, parseHTML, root, save } from './run.mjs';

const started = new Date();
const folder = `05-review/revision-current-official-${started.toISOString().replace(/[:.]/g, '-')}`;
const definitions = [
  { doc_id: 'DOC0022', catalog_page: 9,
    url: 'https://xxgk.mot.gov.cn/gz/202112/t20211223_3632653.html' },
  { doc_id: 'DOC0023', catalog_page: 10,
    url: 'https://xxgk.mot.gov.cn/gz/202112/t20211224_3632922.html' },
];
const register = await load('00-control/document-register.json');
const previous = await load('05-review/revision-current-official-2026-11-16T14-47-05-635Z/evidence.json');
async function snapshot(url, label) {
  const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
  assert.equal(response.status, 200, url);
  const bytes = Buffer.from(await response.arrayBuffer());
  const snapshotPath = `${folder}/${label}`;
  await save(snapshotPath, bytes);
  return { requested_url: url, final_url: response.url, http_status: response.status,
    checked_at: new Date().toISOString(), snapshot_path: snapshotPath,
    sha256: hash(bytes), bytes: bytes.length };
}
async function htmlSnapshot(url, label) {
  const record = await snapshot(url, label);
  const html = await readFile(path.join(root, record.snapshot_path), 'utf8');
  const tree = parseHTML(html);
  return { record, html, tree };
}
const records = [];
for (const definition of definitions) {
  const doc = register.find(item => item.doc_id === definition.doc_id);
  assert.ok(doc);
  const catalogURL = `https://xxgk.mot.gov.cn/2020/gz/index_${definition.catalog_page}.html`;
  const catalog = await htmlSnapshot(catalogURL, `catalog-${definition.catalog_page}.html`);
  const listed = nodes(catalog.tree, node => node.tagName === 'a').find(node => {
    const href = attr(node, 'href');
    return href && new URL(href, catalogURL).href === definition.url && text(node).trim() === doc.title;
  });
  assert.ok(listed, `${doc.doc_id}: absent from current official catalog`);
  const official = await htmlSnapshot(definition.url, `${doc.doc_id}.html`);
  const article = nodes(official.tree, node =>
    (attr(node, 'class') || '').split(/\s+/).includes('TRS_UEDITOR'));
  assert.equal(article.length, 1, 'Require one complete official article container');
  const body = text(article[0]).trim() + '\n';
  const title = nodes(official.tree, node => node.tagName === 'title').map(text).join('').trim();
  assert.equal(title, doc.title);
  const version = nodes(official.tree, node =>
    (attr(node, 'class') || '').split(/\s+/).includes('tit_tz')).map(text).join('').trim();
  const bodyPath = `${folder}/${doc.doc_id}.txt`;
  await save(bodyPath, body);
  const expectedPath = (doc.revision_v5 || doc.revision_v4).expected_path;
  const expectedBytes = await readFile(path.join(root, expectedPath));
  const expected = JSON.parse(expectedBytes);
  const master = await readFile(path.join(root, doc.master_path));
  assert.equal(hash(master), doc.sha256, 'Current master hash mismatch');
  const articles = articlesFrom(body);
  assert.deepEqual(articles.map(item => item.article), expected.points.map(item => item.article));
  const comparisons = expected.points.map(point => {
    const source = articles.find(item => item.article === point.article);
    const equal = compact(source.body) === compact(point.source_body);
    const quotesOnly = !equal && compact(source.body).replace(/[“”]/gu, '"') ===
      compact(point.source_body).replace(/[“”]/gu, '"');
    return { knowledge_point_id: point.knowledge_point_id, article: point.article,
      official_body_sha256: hash(source.body), local_body_sha256: hash(point.source_body),
      exact_ignoring_whitespace: equal, quotes_only: quotesOnly,
      ...(equal ? {} : { official_body: source.body, local_body: point.source_body }),
      semantic_decision: equal ? 'Text identity only; not semantic approval' : 'Requires source adjudication' };
  });
  const attachments = [];
  for (const link of nodes(official.tree, node => node.tagName === 'a')) {
    const href = attr(link, 'href');
    if (!href || !/\.pdf$/iu.test(new URL(href, definition.url).pathname)) continue;
    const attachmentURL = new URL(href, definition.url).href;
    const cached = previous.records.find(item => item.doc_id === doc.doc_id)?.attachments
      .find(item => item.requested_url === attachmentURL);
    assert.ok(cached, 'Unrecognized attachment requires fresh source and visual review');
    const bytes = await readFile(path.join(root, cached.snapshot_path));
    assert.equal(hash(bytes), cached.sha256);
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
    attachments.push({ ...cached, link_text: text(link).trim(), reused: true,
      link_rechecked_at: new Date().toISOString(),
      reuse_scope: 'Unchanged official attachment URL; cached bytes/hash and qualified visual review reused. Remote PDF bytes not downloaded again.' });
  }
  assert.equal(attachments.length, 1);
  records.push({ doc_id: doc.doc_id, title, official_version_statement: version,
    current_catalog: catalog.record, catalog_link_verified: true, official_page: official.record,
    body_path: bodyPath, body_sha256: hash(body), attachments,
    master_path: doc.master_path, master_sha256: hash(master),
    expected_path: expectedPath, expected_sha256: hash(expectedBytes),
    article_count: articles.length, comparisons,
    source_status: 'Listed in the official current-effective regulation catalog at the recorded access time',
    semantic_review_passed: false, formal_import_passed: false });
}
const evidence = { checked_at: new Date().toISOString(), records,
  scope: 'Two freshly retrieved official MOT current-effective catalog pages and linked full texts, with unchanged PDF links and qualified cached PDF evidence; article comparison against current local candidates.',
  limitations: ['Official current catalog evidence is not an exhaustive search of all later notices.',
    'Literal differences require adjudication against the amendment and consolidated originals.',
    'No local master, expected points, document register, pipeline or remote KB was changed.'],
  elapsed_ms: Date.now() - started.getTime(), model_requests: 0, remote_mutation: false };
await save(`${folder}/evidence.json`, evidence);
console.log(JSON.stringify({ evidence_path: `${folder}/evidence.json`, records: records.map(record => ({
  doc_id: record.doc_id, articles: record.article_count,
  equal: record.comparisons.filter(item => item.exact_ignoring_whitespace).length,
  quotes_only: record.comparisons.filter(item => item.quotes_only).length,
  adjudication: record.comparisons.filter(item => !item.exact_ignoring_whitespace)
    .map(item => item.knowledge_point_id), pdf_path: record.attachments[0].snapshot_path,
})), remote_mutation: false }, null, 2));
