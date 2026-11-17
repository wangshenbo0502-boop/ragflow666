import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { hash, load, root, save, table } from './run.mjs';

const documents = await load('00-control/document-register.json');
const selected = await load('00-control/selected-sources.json');
const previous = await load('00-control/source-register.json');
const sources = new Map(previous.map(source => [source.source_id, { ...source }]));
assert.equal(sources.size, previous.length, 'Duplicate registered source ID');
assert.equal(new Set(documents.map(doc => doc.doc_id)).size, documents.length);

for (const docID of ['DOC0010', 'DOC0016']) {
  const doc = documents.find(item => item.doc_id === docID);
  const source = selected.find(item => item.source_id === doc.source_id);
  const repair = await load(`05-review/${docID}-source-repair.json`);
  assert.equal(repair.current_source_id, source.source_id);
  assert.ok(doc.previous_source_ids.includes(repair.old_source_id));
  const bytes = await readFile(path.join(root, source.original_path));
  assert.equal(hash(bytes), source.sha256, `${source.source_id} original hash`);
  const old = sources.get(repair.old_source_id);
  assert.ok(old, `Missing retained source ${repair.old_source_id}`);
  for (const attachment of old.attachments || []) {
    const content = await readFile(path.join(root, attachment.original_path));
    assert.equal(hash(content), attachment.sha256, `${old.source_id} attachment hash`);
  }
  const relation = docID === 'DOC0010' ? 'same_publication_crosscheck' : 'supersedes';
  sources.set(source.source_id, {
    ...sources.get(source.source_id),
    source_id: source.source_id, title: source.title, publisher: source.publisher,
    url: source.fetched_url || source.url, original_path: source.original_path,
    published: docID === 'DOC0010' ? '2018-08-31' : '2026-02-09',
    version: source.version, scope: source.scope, domain: source.domain,
    access_date: source.collected.slice(0, 10), sha256: source.sha256,
    status: '官方全文及施行条款已回读；截至审计日的后续修订/效力仍待核验',
    previous_source_ids: doc.previous_source_ids, relation,
    source_identity: source.source_identity, count_as_additional_document: false,
    evidence_path: `05-review/${docID}-source-repair.json`,
  });
  old.related_current_source_ids = [...new Set([
    ...(old.related_current_source_ids || []), source.source_id,
  ])];
  old.relation = relation === 'supersedes' ? 'superseded_by' : 'same_publication_crosscheck';
  old.count_as_additional_document = false;
  old.status = docID === 'DOC0010'
    ? '同一2018版PDF原件保留；与S0028官方HTML交叉核对，不新增文献计数'
    : '2023版历史原件保留；2026版第五十五条载明2026-03-15起废止旧版，不作当前依据';
  old.evidence_path = `05-review/${docID}-source-repair.json`;
}

const sorted = [...sources.values()].sort((a, b) => a.source_id.localeCompare(b.source_id));
const checks = [];
for (const doc of documents) {
  assert.ok(sources.has(doc.source_id), `${doc.doc_id} missing source`);
  for (const oldID of doc.previous_source_ids || []) assert.ok(sources.has(oldID));
  await access(path.join(root, doc.original_path));
  await access(path.join(root, doc.master_path));
  const markdown = await readFile(path.join(root, doc.master_path), 'utf8');
  assert.ok(markdown.includes(doc.source_id), `${doc.doc_id} master source mismatch`);
  checks.push({ doc_id: doc.doc_id, source_id: doc.source_id,
    previous_source_ids: doc.previous_source_ids || [],
    original_exists: true, master_exists: true, master_mentions_current_source: true });
}

async function preserve(relative) {
  const destination = `05-review/history/pre-reconcile-v3-${path.basename(relative)}`;
  try { await access(path.join(root, destination)); }
  catch { await save(destination, await readFile(path.join(root, relative))); }
}

if (!process.argv.includes('--check')) {
  for (const relative of ['00-control/source-register.json', '00-control/source-register.md']) {
    await preserve(relative);
  }
  await save('00-control/source-register.json', sorted);
  await save('00-control/source-register.md', '# 来源登记表\n\n' +
    '本表登记来源载体与历史版本，不把每条来源记录当成一篇新增文献。S0010/S0028为同一2018版的PDF与HTML；S0018是S0029所替代的2023版，原件和历史关系保留。原文回读不等于已证明截至2026-11-16无后续修订。\n\n' +
    table(['source_id', '标题', '发布机构', '发布日期', '版本', '主领域', '原文地址',
      '原件路径', '访问日期', '核验状态', '前版/交叉来源', '当前关联来源', '关系'],
    sorted.map(source => [source.source_id, source.title, source.publisher, source.published,
      source.version, source.domain, source.url, source.original_path, source.access_date,
      source.status, (source.previous_source_ids || []).join(','),
      (source.related_current_source_ids || []).join(','), source.relation || ''])));
  await save('05-review/source-register-reconciliation-v3.json', {
    checked_at: new Date().toISOString(), scope: 'Local source register reconciliation only',
    source_records_before: previous.length, source_records_after: sorted.length,
    current_document_candidates: documents.length,
    final_valid_document_count: null,
    counting_note: '来源载体/替代版本补登记不增加文献数；最终有效量待版本、效力、附件及语义核验',
    originals_unchanged: true, historical_registers_preserved: true,
    document_source_checks: checks,
  });
}
console.log(JSON.stringify({ mode: process.argv.includes('--check') ? 'check' : 'write',
  source_records: sorted.length, documents_checked: checks.length,
  repaired_current_source_ids: ['S0028', 'S0029'], originals_unchanged: true }));
