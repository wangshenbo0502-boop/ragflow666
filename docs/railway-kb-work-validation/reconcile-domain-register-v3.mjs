import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { hash, load, root, save, table } from './run.mjs';

const registerPath = '00-control/domain-register.md';
const original = await readFile(path.join(root, registerPath), 'utf8');
const documents = await load('00-control/document-register.json');
const sources = await load('00-control/source-register.json');
const sourceIDs = new Set(sources.map(source => source.source_id));
const oldRows = original.split(/\r?\n/u).filter(line => /^\| DOC\d{4} \|/u.test(line))
  .map(line => line.split('|').slice(1, -1).map(cell => cell.trim()));
const unique = new Map();
const changes = [];
for (const doc of documents) {
  assert.ok(!unique.has(doc.doc_id), `Duplicate document ${doc.doc_id}`);
  assert.ok(sourceIDs.has(doc.source_id), `${doc.doc_id} unknown source`);
  const candidates = oldRows.filter(row => row[0] === doc.doc_id);
  const existing = candidates.find(row => row[7] === doc.master_path) || candidates.at(-1);
  assert.ok(existing, `${doc.doc_id} missing domain record`);
  assert.equal(existing[3], doc.domain, `${doc.doc_id} domain conflict`);
  const bytes = await readFile(path.join(root, doc.master_path));
  const text = bytes.toString('utf8');
  assert.equal(hash(bytes), doc.sha256, `${doc.doc_id} master hash mismatch`);
  assert.ok(text.includes(doc.doc_id) && text.includes(doc.source_id), `${doc.doc_id} master identity mismatch`);
  await access(path.join(root, doc.original_path));
  const oldSources = (doc.previous_source_ids || []).join('、');
  const row = [doc.doc_id, doc.source_id, doc.title, doc.domain, existing[4],
    existing[5], doc.original_path, doc.master_path,
    `${doc.version}；现行效力待逐项核验${oldSources ? `；旧载体/前版来源${oldSources}保留` : ''}`,
    '登记一致性通过；领域语义、版本效力和最终检索验收未完成'];
  unique.set(doc.doc_id, row);
  changes.push({ doc_id: doc.doc_id, previous_row_count: candidates.length,
    duplicate_rows_removed: candidates.length - 1,
    prior_source_id: existing[1], current_source_id: doc.source_id,
    prior_original_path: existing[6], current_original_path: doc.original_path,
    master_path: doc.master_path, master_sha256: hash(bytes),
    original_exists: true, classification_changed: false });
}
assert.equal(oldRows.length - [...unique.keys()].reduce((sum, id) =>
  sum + oldRows.filter(row => row[0] === id).length, 0), 0, 'Unregistered old document IDs');
const report = { checked_at: new Date().toISOString(),
  scope: 'Local register identity, uniqueness, source and path reconciliation only; not a new semantic classification audit.',
  previous_rows: oldRows.length, current_rows: unique.size,
  duplicate_rows_removed: oldRows.length - unique.size,
  current_source_ids: [...new Set(documents.map(doc => doc.source_id))],
  domain_counts: Object.fromEntries(['GW', 'XH', 'GD', 'CL', 'YS'].map(domain =>
    [domain, documents.filter(doc => doc.domain === domain).length])),
  final_valid_document_count: null,
  originals_and_masters_unchanged: true, user_app_modified: false,
  changes };
if (!process.argv.includes('--check')) {
  const history = '05-review/history/pre-reconcile-v3-domain-register.md';
  try { await access(path.join(root, history)); }
  catch { await save(history, original); }
  await save(registerPath, '# 五领域归档登记\n\n' +
    '本表以document-register.json当前24篇候选资料为身份和路径依据，每个doc_id仅一行。原件、历史版本及旧登记快照保留；修复重复行和来源/路径不代表完成领域正文语义、版本效力或有效文献计数验收。沿用既有主领域，不在本次对账中重新分类。\n\n' +
    table(['doc_id', 'source_id', '标题', '主领域', '辅助领域', '既有判断依据（本轮未重新分类）',
      '原件路径', '当前主副本路径', '版本状态', '处理状态'], [...unique.values()]));
  await save('05-review/domain-register-reconciliation-v3.json', report);
}
console.log(JSON.stringify({ mode: process.argv.includes('--check') ? 'check' : 'write',
  previous_rows: report.previous_rows, current_rows: report.current_rows,
  duplicate_rows_removed: report.duplicate_rows_removed,
  domain_counts: report.domain_counts, originals_and_masters_unchanged: true }));
