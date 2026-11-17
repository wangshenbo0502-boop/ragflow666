import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { hash, load, root, save } from './run.mjs';

const at = new Date().toISOString();
const folder = `05-review/source-table-alignment-${at.replaceAll(/[:.]/gu, '-')}`;
const registryPath = '00-control/document-register.json';
const registryBytes = await readFile(path.resolve(root, registryPath));
const registry = JSON.parse(registryBytes);
const normalize = text => text.replaceAll('\\|', '|').replaceAll('<br>', '\n').replaceAll(/\s+/gu, '');
const prepared = [];
for (const doc of registry.filter(item => ['DOC0025', 'DOC0026', 'DOC0027', 'DOC0028'].includes(item.doc_id))) {
  const expectedBytes = await readFile(path.resolve(root, doc.structure_v3.expected_path));
  const expected = JSON.parse(expectedBytes);
  const nativeBytes = await readFile(path.resolve(root, doc.structure_v2.source_audit));
  const native = JSON.parse(nativeBytes);
  const original = await readFile(path.resolve(root, doc.original_path));
  const before = await readFile(path.resolve(root, doc.master_path), 'utf8');
  assert.equal(hash(before), doc.sha256);
  assert.equal(hash(original), expected.source_sha256);
  assert.equal(hash(original), native.original_sha256);
  let after = before;
  const points = [];
  for (const point of expected.knowledge_points.filter(item => item.kind === 'source_table')) {
    const start = after.indexOf(`### ${point.knowledge_point_id} `);
    assert.ok(start >= 0);
    const boundary = /\n#{1,3} /gu;
    boundary.lastIndex = after.indexOf('\n', start);
    const next = boundary.exec(after);
    const end = next ? next.index : after.length;
    const section = after.slice(start, end);
    const table = native.tables.find(item => item.table_id === point.native_table_id);
    const grid = text => text.split('\n').filter(line => line.startsWith('| ')).join('\n');
    assert.equal(grid(section), grid(point.text), `${point.knowledge_point_id}: grid must be unchanged`);
    assert.equal(grid(section).split('\n').length, table.row_count + 2);
    for (const context of point.common_context) {
      const sourceText = native.blocks.find(block => block.type === 'paragraph'
        && block.paragraph === context.paragraph)?.text;
      assert.ok(sourceText !== undefined);
      assert.equal(normalize(sourceText), normalize(context.text));
    }
    if (normalize(section).includes(normalize(point.text))) continue;
    const originalLocator = section.match(/^\*\*原文定位：\*\* .+$/mu)?.[0];
    assert.ok(originalLocator);
    const tableStart = section.indexOf('\n| 原列1 ');
    let tableEnd = tableStart + 1;
    while (section[tableEnd] === '|') {
      const newline = section.indexOf('\n', tableEnd);
      tableEnd = newline < 0 ? section.length : newline + 1;
    }
    // Keep the source's trailing paragraphs in their original place as well.
    const trailing = section.slice(tableEnd).trim();
    const replacement = `### ${point.knowledge_point_id} ${point.heading}\n\n${originalLocator}\n\n${point.text}\n\n${trailing}\n`;
    after = after.slice(0, start) + replacement + after.slice(end);
    points.push({ knowledge_point_id: point.knowledge_point_id, native_table_id: point.native_table_id,
      candidate_text_sha256: hash(point.text), before_section_sha256: hash(section),
      after_section_sha256: hash(replacement), native_grid_unchanged: true,
      shared_context_paragraphs: point.common_context.map(item => item.paragraph) });
  }
  if (!points.length) continue;
  assert.equal((before.match(/^### /gmu) || []).length, (after.match(/^### /gmu) || []).length);
  const affected = new Set(points.map(point => point.knowledge_point_id));
  for (const point of expected.knowledge_points) {
    const section = text => {
      const start = text.indexOf(`### ${point.knowledge_point_id} `);
      const boundary = /\n#{1,3} /gu;
      boundary.lastIndex = text.indexOf('\n', start);
      const next = boundary.exec(text);
      return text.slice(start, next ? next.index : undefined);
    };
    if (affected.has(point.knowledge_point_id)) {
      assert.ok(normalize(section(after)).includes(normalize(point.text)));
    } else {
      assert.equal(section(after), section(before), `${point.knowledge_point_id}: unrelated section changed`);
    }
  }
  prepared.push({ doc, before, after, expectedBytes, nativeBytes, original, points });
}
// Prepare the whole batch before writing any current master.
assert.equal(hash(await readFile(path.resolve(root, registryPath))), hash(registryBytes));
await save(`${folder}/${registryPath}`, registryBytes);
const documents = [];
for (const item of prepared) {
  const { doc, before, after, expectedBytes, nativeBytes, original, points } = item;
  assert.equal(hash(await readFile(path.resolve(root, doc.master_path))), hash(before));
  await save(`${folder}/${doc.master_path}`, before);
  await save(doc.master_path, after);
  const evidence = { doc_id: doc.doc_id, master_path: doc.master_path,
    before_master_sha256: hash(before), after_master_sha256: hash(after),
    expected_path: doc.structure_v3.expected_path, expected_sha256: hash(expectedBytes),
    native_path: doc.structure_v2.source_audit, native_sha256: hash(nativeBytes),
    original_sha256: hash(original), points,
    all_expected_candidate_texts_unchanged: true,
    semantic_cache_reuse_scope: 'Previously reviewed expected texts and their source/context inputs are unchanged. Master-section placement repaired; not new semantic approval.',
    structure_accepted: false, trial_executed: false, formal_import: false };
  documents.push(evidence);
  doc.sha256 = hash(after);
  doc.structure_v3.master_alignment = { at, evidence_path: `${folder}/evidence.json`,
    before_master_sha256: hash(before), after_master_sha256: hash(after),
    knowledge_point_ids: points.map(point => point.knowledge_point_id) };
}
assert.equal(hash(await readFile(path.resolve(root, registryPath))), hash(registryBytes));
await save(`${folder}/evidence.json`, { checked_at: at, documents, original_files_unchanged: true,
  new_model_requests: 0, remote_writes: 0, structure_accepted: false });
if (prepared.length) await save(registryPath, registry);
console.log(JSON.stringify({ folder, documents: documents.map(item => ({
  doc_id: item.doc_id, aligned_tables: item.points.length })), new_model_requests: 0, remote_writes: 0 }));
