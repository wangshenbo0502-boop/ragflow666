import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { hash, load, parseHTML, root, save } from './run.mjs';

const docID = process.argv[2] || 'DOC0027';
const actualPath = `04-chunks/actual/${docID}-successor-trial.json`;
const actualBytes = await readFile(path.join(root, actualPath));
const actual = JSON.parse(actualBytes);
const registry = await load('00-control/document-register.json');
const doc = registry.find(item => item.doc_id === docID);
assert.ok(doc);
assert.equal(actual.sha256, doc.sha256);
assert.equal(hash(await readFile(path.join(root, doc.master_path))), doc.sha256);
const expectedBytes = await readFile(path.join(root, doc.structure_v3.expected_path));
const expected = JSON.parse(expectedBytes);
const textOf = chunk => chunk.content || chunk.content_with_weight || '';
const normalize = text => text.replace(/\s+/gu, '');
function descendants(node, tag) {
  return (node.childNodes || []).flatMap(child => [
    ...(child.tagName === tag ? [child] : []), ...descendants(child, tag),
  ]);
}
function textContent(node) {
  return node.nodeName === '#text' ? node.value
    : (node.childNodes || []).map(textContent).join('');
}
function htmlCells(text) {
  return descendants(parseHTML(text), 'tr').map(row =>
    (row.childNodes || []).filter(node => ['th', 'td'].includes(node.tagName))
      .map(cell => normalize(textContent(cell))));
}
function markdownCells(text) {
  return text.split(/\r?\n/u).filter(line => line.startsWith('|'))
    .filter(line => !/^\|(?:\s*:?-+:?\s*\|)+\s*$/u.test(line))
    .map(line => line.slice(1, line.lastIndexOf('|')).split(/(?<!\\)\|/u)
      .map(cell => normalize(cell.replaceAll('\\|', '|').replace(/<br\s*\/?>/gu, '\n'))));
}
const tableChunks = actual.chunks.filter(chunk => chunk.doc_type_kwd === 'table'
  && textOf(chunk).includes('<table'));
const tableChecks = expected.knowledge_points.filter(point => markdownCells(point.text).length)
  .map(point => {
    const cells = markdownCells(point.text);
    const candidates = tableChunks.filter(chunk =>
      JSON.stringify(htmlCells(textOf(chunk))) === JSON.stringify(cells));
    const heading = actual.checks.find(check => check.knowledge_point_id === point.knowledge_point_id);
    const source = point.text.split(/\r?\n/u).filter(line => line.startsWith('来源定位：')).at(-1);
    const sourceChunks = source ? actual.chunks.filter(chunk => normalize(textOf(chunk)).includes(normalize(source))) : [];
    return { knowledge_point_id: point.knowledge_point_id, source_location: point.source_location,
      expected_body_sha256: hash(point.text), expected_table_sha256: hash(JSON.stringify(cells)),
      heading_chunk_ids: heading?.chunk_ids || [], table_chunk_ids: candidates.map(chunk => chunk.id),
      source_chunk_ids: sourceChunks.map(chunk => chunk.id),
      table_cells_preserved: candidates.length > 0,
      same_chunk: candidates.some(chunk => (heading?.chunk_ids || []).includes(chunk.id)
        && (!source || normalize(textOf(chunk)).includes(normalize(source)))) };
  });
const literalPoint = expected.knowledge_points.find(point => point.knowledge_point_id === `${docID}-K014`);
const literalChunk = actual.chunks.find(chunk => chunk.id === '7444673d676d290e');
const literalLoss = docID === 'DOC0027' && literalPoint && literalChunk
  && literalPoint.text.includes('TXTX####—*****')
  && !textOf(literalChunk).includes('TXTX####—*****')
  && textOf(literalChunk).includes('TXTX####—**');
assert.ok(tableChecks.some(check => !check.same_chunk) || literalLoss,
  'This rejection recorder requires actual verified failure evidence');
const at = new Date().toISOString();
const evidencePath = `05-review/${docID}-trial-quality-rejection-2026-11-16.json`;
const snapshotPath = `05-review/history/${docID}-trial-${hash(actualBytes).slice(0, 12)}.json`;
await save(snapshotPath, actualBytes);
const evidence = { checked_at: at, doc_id: docID, dataset_id: actual.dataset_id,
  document_id: actual.document_id, pipeline_id: actual.pipeline_id,
  pipeline_version_id: actual.pipeline_version_id,
  bindings: { master: { path: doc.master_path, sha256: doc.sha256 },
    expected: { path: doc.structure_v3.expected_path, sha256: hash(expectedBytes) },
    actual: { path: actualPath, sha256: hash(actualBytes), snapshot_path: snapshotPath } },
  actual_chunks: actual.exported_count, expected_points: actual.expected_points,
  deterministic_full_body_matches: actual.full_body_passed,
  maximum_tokens_with_filename: actual.maximum_tokens_with_filename,
  table_checks: tableChecks,
  table_summary: { expected_table_points: tableChecks.length,
    cell_grids_found_in_actual_tables: tableChecks.filter(check => check.table_cells_preserved).length,
    table_context_source_together: tableChecks.filter(check => check.same_chunk).length },
  verified_literal_loss: literalLoss ? {
    knowledge_point_id: literalPoint.knowledge_point_id, chunk_id: literalChunk.id,
    expected: 'TXTX####—*****', actual: 'TXTX####—**',
    issue: 'Markdown emphasis parsing removed literal asterisks from the five-digit certificate-number placeholder.',
  } : null,
  decision: 'chunk-quality-rejected', quality_accepted: false, formal_import: false,
  retrieval_accepted: false,
  rejected_workarounds: [
    { route: 'Rename the existing remote document from .md to .txt',
      reason: 'The supported API validates equal old/new extensions; no rename request or direct database write was attempted.',
      code: 'internal/service/document/document_dataset_update.go:validateDocumentName' },
    { route: 'Increase table_context_size',
      reason: 'Neighbor token windows do not guarantee the complete point and can mix unrelated points.' },
  ],
  scope: 'Structural and literal fidelity checks over exported actual chunks; does not replace source semantic or visual review.',
  remote_mutations: 0, new_model_requests: 0 };
await save(evidencePath, evidence);
const ledger = await load('00-control/successor-import-ledger.json');
const record = ledger.documents.find(item => item.document_id === actual.document_id);
assert.ok(record);
record.status = 'chunk-quality-rejected';
record.quality_evidence = evidencePath;
record.quality_evidence_sha256 = hash(await readFile(path.join(root, evidencePath)));
record.reviewed_at = at;
await save('00-control/successor-import-ledger.json', ledger);
doc.structure_v3.trial_status = '试切不通过：表格与上下文/来源分离，且许可证编号字面字符丢失';
doc.structure_v3.trial_quality_evidence = {
  path: evidencePath, sha256: record.quality_evidence_sha256,
  document_id: actual.document_id, reviewed_at: at,
};
doc.count_as_valid = false;
doc.exclusion_reason = '结构已通过；当前真实试切质量不通过，未正式导入或检索验收，不计最终有效量。';
await save('00-control/document-register.json', registry);
console.log(JSON.stringify({ evidence: evidencePath, decision: evidence.decision,
  tables: evidence.table_summary, literal_loss: Boolean(literalLoss),
  remote_mutations: 0, new_model_requests: 0 }));
