import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { hash, load, root, save } from './run.mjs';

const summaryPath = '05-review/successor-semantic-review/summary.json';
const summary = await load(summaryPath);
const register = await load('00-control/document-register.json');
const manifest = await load('05-review/successor-visual/render-manifest.json');
const digest = async relative => hash(await readFile(path.resolve(root, relative)));
const reviewedPages = {
  S0033: {
    12: 'T01 notes 1-3 are present in full; do not accept the former truncation claim.',
    15: 'Equipment replacement remark has a named target; high-manganese frog section headers and values are visible.',
    34: 'Paragraph 2317 follows T08 and precedes the next annex. Position alone does not establish application to every assessment item.',
  },
  S0034: {
    16: 'Equipment rows and merged remarks reviewed; the electric-switch-machine exception names sequence 6.',
    17: 'T03 row 167 (internal diameter dial gauge) requirement and remark cells are genuinely blank.',
    37: 'Personnel statistics form has unfilled data cells and a merged total column; no numerical counts or ratios may be invented.',
  },
  S0035: {
    15: 'T02 row 89 (LTE dedicated test software) has blank requirement and remark cells.',
    32: 'Personnel statistics is an unfilled official form; blank cells and merged total column must remain unfilled.',
  },
  S0036: {
    10: 'Blank speed-class requirement cells are visible. Conditional casting/forging remarks must retain their wording; merging alone does not prove the condition is met.',
    11: 'Row 64 has 12kg/50kg only in the 300-350km/h column; other speed columns are blank. Row 65 starts a blank product-name merge. Row 67 has 35/45/45mm by the three speed classes.',
    12: 'Cross-page fatigue-test cell continues without a new independent rule; keep the complete original condition. Equipment blanks are genuine.',
    13: 'Copper contact/catenary-wire and ceramic-insulator sections retain distinct headers, units and limits; empty cells remain empty.',
    14: 'Ceramic/composite-insulator equipment headers and blank requirement cells reviewed; no default values are supplied.',
    15: 'Water diffusion test equipment row has blank requirements and remark.',
    16: 'Personnel qualifications and counts are visible. The electrical personnel remark appears blank in the rendering; native Word text nevertheless contains the anomalous phrase.',
    17: 'Key-post rows literally say certificate OR training before taking the post; no certificate type or training authority is specified here.',
  },
};
const documents = new Map();
const visual = {
  recorded_at: new Date().toISOString(),
  scope: 'Bounded observations of 16 pages viewed in this continuing task; not full-document visual acceptance.',
  manifest_path: '05-review/successor-visual/render-manifest.json',
  manifest_sha256: await digest('05-review/successor-visual/render-manifest.json'),
  documents: [], full_visual_review_complete: false,
};
for (const [index, sourceID] of ['S0033', 'S0034', 'S0035', 'S0036'].entries()) {
  const docID = `DOC00${25 + index}`;
  const doc = register.find(d => d.doc_id === docID);
  const nativePath = `05-review/successor-structure/${sourceID}-native-tables-v2.json`;
  const native = await load(nativePath);
  const expectedPath = `04-chunks/expected/${docID}-successor-v3.json`;
  const expected = await load(expectedPath);
  const rendered = manifest.documents.find(d => d.source_id === sourceID);
  assert.equal(await digest(native.original_path), native.original_sha256);
  assert.equal(native.original_sha256, rendered.original_sha256);
  assert.equal(await digest(rendered.pdf_path), rendered.pdf_sha256);
  assert.equal(await digest(doc.master_path), doc.sha256);
  const pages = [];
  for (const [number, observation] of Object.entries(reviewedPages[sourceID])) {
    const imagePath = `05-review/successor-visual/${sourceID}-page-${number.padStart(2, '0')}.png`;
    pages.push({ page: Number(number), image_path: imagePath, image_sha256: await digest(imagePath), observation });
  }
  const binding = {
    doc_id: docID, source_id: sourceID, original_path: native.original_path,
    original_sha256: native.original_sha256, master_path: doc.master_path,
    master_sha256: doc.sha256, native_path: nativePath, native_sha256: await digest(nativePath),
    expected_path: expectedPath, expected_sha256: await digest(expectedPath),
    pdf_path: rendered.pdf_path, pdf_sha256: rendered.pdf_sha256,
  };
  documents.set(docID, { binding, native, expected });
  visual.documents.push({ ...binding, total_pages: rendered.pages, pages, full_visual_review_complete: false });
}
await save('05-review/successor-visual/bounded-review-v1.json', visual);

// Decisions below were made against the original pages and native cell structure.
// The loop records evidence; it does not use text matching to decide semantic validity.
const blankEquipmentRows = [
  12, 13, 16, 17, 18, 19, 20, 21, 22, 23, 26, 27, 28, 29, 30, 31, 32, 33, 34,
  52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63,
  95, 96, 97, 103, 104, 105, 114, 119, 120, 121, 122, 124, 125, 126, 128, 132, 141, 142, 160,
];
const manual = new Map();
for (const row of blankEquipmentRows) {
  const suffix = String(row).padStart(3, '0');
  manual.set(`DOC0028-S0036-T02-G${suffix}-${suffix}`, {
    decision: 'FAITHFUL_SOURCE_RETAIN',
    rationale: `T02 row ${row}: the original requirement cells are blank. The candidate retains the separate speed headers, blank markers, cell geometry and any verbatim conditional remark. This is faithful transcription, not a claim of zero requirement, exemption or compliance.`,
    answer_limit: 'May identify the listed equipment and quote the original condition. Must not infer an unstated numerical requirement, the meaning of a blank, or that a conditional remark has been satisfied.',
  });
}
const put = (id, decision, rationale, answerLimit) => manual.set(id, {
  decision, rationale, answer_limit: answerLimit,
});
put('DOC0025-SOURCE-NOTE-P2317', 'PENDING_SOURCE_ATTRIBUTION',
  'Page 34 and native paragraph 2317 confirm the complete four-part representative-product testing note. Its attachment/item scope is not established by adjacency; retain once as a separately located note with attribution pending.',
  'Do not distribute this note to all 81 system-review items or infer a universal scope.');
put('DOC0026-S0034-T03-G167-167', 'FAITHFUL_SOURCE_RETAIN',
  'Page 17 and native T03 row 167 confirm internal-diameter dial gauge under external locking device inspection; requirement and remark are blank. Candidate already marks both blanks and prohibits inference.',
  'No precision, measurement range, calibration condition or compliance conclusion follows from these blank cells.');
put('DOC0026-K038', 'FAITHFUL_SOURCE_RETAIN',
  'Page 37 T11 is an official unfilled personnel statistics form. Candidate retains all row/column headings and the merged total column without inventing numerical counts or population definitions.',
  'Treat as a form, not completed personnel statistics; do not calculate a ratio or fill values.');
put('DOC0027-S0035-T02-G089-089', 'FAITHFUL_SOURCE_RETAIN',
  'Page 15 T02 row 89 confirms dedicated LTE testing software with blank requirement and remark cells. Existing blank markers accurately represent the source.',
  'Do not infer software specification, precision, exemption or certification from the blank cells.');
put('DOC0027-K035', 'FAITHFUL_SOURCE_RETAIN',
  'Page 32 T08 is an unfilled personnel statistics form. A blank corner cell does not erase the explicit column headings. The candidate preserves all headings, blank cells and the merged total column.',
  'Do not fill the corner heading, invent staffing numbers, define unspecified populations or calculate ratios.');
put('DOC0028-S0036-T02-G064-064', 'PENDING_SOURCE_NOTATION',
  'Page 11 and native row 64 place the entire 12kg/50kg phrase only in C8 (300-350km/h); candidate already preserves that alignment and blanks in the other two classes. The slash meaning is unspecified in the source.',
  'Quote the literal phrase for its single speed class only; do not select 12kg or 50kg or invent a range/alternative interpretation.');
for (const [row, equipment] of [[65, 'material testing machine'], [66, 'catenary fitting testing machine'], [67, 'fitting vibration testing machine']]) {
  const suffix = String(row).padStart(3, '0');
  put(`DOC0028-S0036-T02-G${suffix}-${suffix}`, 'PENDING_SOURCE_PRODUCT_SCOPE',
    `Page 11, row ${row}, ${equipment}: product-name origin R65C3 is genuinely blank and starts a new merge; candidate correctly does not inherit ratchet compensation equipment. ${row === 67 ? 'The candidate also correctly aligns 35/45/45mm with the three speed classes.' : 'Requirement cells remain blank.'} The source does not resolve the applicable product.`,
    'Do not assign this row to the preceding product or infer a product-specific requirement. Preserve literal row values and the blank product name.');
}
put('DOC0028-S0036-T03-G003-003', 'PENDING_SOURCE_ANOMALY',
  'Native Word cell R3C8 contains the ordinary text 晨云提议 (paragraph 1375, Word paragraph 1544/start 9936), although page 16 appears blank at this cell. The official redownload matched the original hash. It is a source anomaly, not permission to delete or replace original text.',
  'Keep the anomalous phrase labelled unresolved; it cannot support a substantive personnel requirement or be normalized into an invented remark.');
for (const [row, process] of [[9, 'forging'], [10, 'casting']]) {
  const suffix = String(row).padStart(3, '0');
  put(`DOC0028-S0036-T03-G${suffix}-${suffix}`, 'FAITHFUL_SOURCE_RETAIN',
    `Page 17 and native T03 row ${row} retain certificate OR training before taking the ${process} post, counts 2/3/4 by speed class, and the ${process}-process condition. The model requested certificate type/training authority not stated here; adding them would fabricate a rule.`,
    'Use only the literal OR qualification and original conditional counts. Do not infer certificate type or training authority.');
}
assert.equal(manual.size, summary.issues.length);
const decisions = [];
for (const issue of summary.issues) {
  const decision = manual.get(issue.knowledge_point_id);
  assert(decision, `Unadjudicated issue: ${issue.knowledge_point_id}`);
  const { binding, native, expected } = documents.get(issue.doc_id);
  const point = expected.knowledge_points.find(p => p.knowledge_point_id === issue.knowledge_point_id);
  assert(point, `Missing current candidate ${issue.knowledge_point_id}`);
  const table = native.tables.find(t => t.table_id === point.native_table_id);
  const dataRows = point.native_row_ids ?? table?.rows.map(r => r.row) ?? [];
  const referencedRows = new Set([
    ...dataRows, ...(point.shared_header_row_ids ?? []), ...(point.shared_note_row_ids ?? []),
  ]);
  const rowEvidence = table?.rows.filter(r => referencedRows.has(r.row)) ?? [];
  const originIDs = [...new Set(rowEvidence.flatMap(r => r.resolved_origins))];
  const origins = table?.rows.flatMap(r => r.cells).filter(c => originIDs.includes(c.cell_id)) ?? [];
  decisions.push({
    knowledge_point_id: issue.knowledge_point_id, model_status: issue.status,
    model_evidence_path: issue.evidence_path, model_evidence_sha256: await digest(issue.evidence_path),
    model_finding: issue.finding, source_location: issue.source_location,
    ...binding, candidate_text_sha256: hash(point.text),
    native_table_id: point.native_table_id, native_row_ids: dataRows,
    shared_header_row_ids: point.shared_header_row_ids ?? [],
    row_evidence_sha256: hash(JSON.stringify(rowEvidence)),
    original_rows: rowEvidence, resolved_source_cells: origins,
    visual_evidence_path: '05-review/successor-visual/bounded-review-v1.json',
    ...decision, candidate_changed: false, formal_import_accepted: false,
  });
}
const counts = {};
for (const item of decisions) counts[item.decision] = (counts[item.decision] ?? 0) + 1;
await save('05-review/successor-semantic-adjudication-v2.json', {
  checked_at: new Date().toISOString(), summary_path: summaryPath,
  summary_sha256: await digest(summaryPath),
  source_policy: 'Retain original blanks, conditions, notation and anomalies. Original-source ambiguity is separate from transcription fidelity.',
  scope: 'Individual adjudication of the current 62 non-PASS model issues, not a full structure or legal acceptance.',
  raw_model_judgments_unchanged: true, counts, decisions,
  full_visual_review_complete: false, legal_effectiveness_complete: false,
  structure_accepted: false, formal_import: false, retrieval_accepted: false,
});
console.log(JSON.stringify({ adjudicated: decisions.length, counts, bounded_visual_pages: visual.documents.reduce((n, d) => n + d.pages.length, 0) }));
