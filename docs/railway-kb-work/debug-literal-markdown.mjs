import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { api, hash, load, repo, root, save } from './run.mjs';

const require = createRequire(path.join(repo, 'web/package.json'));
const { fromMarkdown } = await import(pathToFileURL(require.resolve('mdast-util-from-markdown')));
const docID = process.argv[2] || 'DOC0027';
assert.ok(['DOC0026', 'DOC0027'].includes(docID));
const registry = await load('00-control/document-register.json');
const doc = registry.find(item => item.doc_id === docID);
const master = await readFile(path.join(root, doc.master_path), 'utf8');
assert.equal(hash(master), doc.sha256);
const decisionPath = doc.structure_v3.structure_decision.path;
const decision = await load(decisionPath);
assert.equal(decision.structure_accepted, true);
assert.equal(decision.bindings.master.sha256, hash(master));
const expectedPath = doc.structure_v3.expected_path;
const expectedBytes = await readFile(path.join(root, expectedPath));
assert.equal(hash(expectedBytes), decision.bindings.expected.sha256);
const expected = JSON.parse(expectedBytes);
const ast = fromMarkdown(master);
const headings = ast.children.filter(node => node.type === 'heading');
assert.ok(headings.length > expected.knowledge_points.length);
assert.ok(!ast.children.some(node => node.type === 'code'), 'Existing code blocks require explicit review');
const fence = '~~~~~~~~~~~~';
assert.ok(!master.includes(fence));
const segments = [];
const edits = [];
let cursor = 0;
for (const heading of [...headings, null]) {
  const end = heading ? heading.position.start.offset : master.length;
  const original = master.slice(cursor, end);
  if (original.trim()) {
    const leading = original.match(/^\s*/u)[0];
    const trailing = original.match(/\s*$/u)[0];
    const body = original.slice(leading.length, original.length - trailing.length);
    assert.ok(cursor === 0 || leading.includes('\n'));
    assert.ok(end === master.length || trailing.includes('\n'));
    const wrapped = `${leading}${fence}text\n${body}\n${fence}${trailing}`;
    edits.push({ original_start: cursor, original_end: end, original_sha256: hash(original),
      body_sha256: hash(body), leading, trailing, body });
    segments.push(wrapped);
  } else {
    segments.push(original);
  }
  if (heading) {
    segments.push(master.slice(heading.position.start.offset, heading.position.end.offset));
    cursor = heading.position.end.offset;
  }
}
const rendition = segments.join('');
const renderedAST = fromMarkdown(rendition);
assert.equal(renderedAST.children.filter(node => node.type === 'heading').length, headings.length);
const code = renderedAST.children.filter(node => node.type === 'code');
assert.equal(code.length, edits.length);
for (const [index, node] of code.entries()) assert.equal(node.value, edits[index].body);
let roundTrip = rendition;
for (let index = code.length - 1; index >= 0; index--) {
  const node = code[index];
  roundTrip = roundTrip.slice(0, node.position.start.offset) + node.value
    + roundTrip.slice(node.position.end.offset);
}
assert.equal(roundTrip, master, 'Formatting round trip changed original Markdown bytes');
const directory = `04-chunks/inputs/${docID}-literal-${hash(rendition).slice(0, 12)}`;
const inputPath = `${directory}/${docID}-literal.md`;
const manifestPath = `${directory}/manifest.json`;
await save(inputPath, rendition);
const at = new Date().toISOString();
const pipeline = await load('00-control/domain-pipeline.json');
const current = await api(`/agents/${pipeline.pipeline_id}`);
assert.equal(hash(JSON.stringify(current.dsl)),
  hash(JSON.stringify((await load('05-review/current-title-pipeline-readback.json')).dsl)));
const debug = (id, inputs) => api(`/agents/${pipeline.pipeline_id}/components/${id}/debug`,
  'POST', { params: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, { value }])) });
const manifest = { created_at: at, doc_id: docID,
  master: { path: doc.master_path, sha256: hash(master) },
  expected: { path: expectedPath, sha256: hash(expectedBytes) },
  structure_decision: { path: decisionPath, sha256: hash(await readFile(path.join(root, decisionPath))) },
  input: { path: inputPath, sha256: hash(rendition) },
  transformation: 'Fence non-heading Markdown spans as literal text; original semantic master unchanged.',
  reversible_exact_bytes: true, headings_unchanged: true, fenced_spans: code.length,
  spans: edits.map(({ body, leading, trailing, ...edit }) => edit),
  pipeline_id: pipeline.pipeline_id, pipeline_version_id: pipeline.pipeline_version_id,
  new_source_document: false, formal_import: false, retrieval_accepted: false };
const evidencePath = `05-review/${docID}-literal-markdown-debug-${at.replaceAll(/[:.]/g, '-')}.json`;
const evidence = { checked_at: at, manifest_path: manifestPath, input_sha256: hash(rendition),
  scope: 'Real supported Parser and TitleChunker component debug; no upload or embedding.',
  new_model_requests: 0 };
try {
  evidence.parser = await debug('Parser:HipSignsRhyme',
    { binary: rendition, name: `${docID}-literal.md`, file_type: 'md' });
  assert.equal(evidence.parser.file_type, 'md');
  evidence.chunker = await debug('TitleChunker:SparklySchoolsTravel', evidence.parser);
  const chunks = evidence.chunker.chunks || [];
  const textOf = chunk => chunk.text || chunk.content || chunk.content_with_weight || '';
  const normalize = text => text.replace(/\s+/gu, '');
  evidence.checks = expected.knowledge_points.map(point => {
    const pattern = new RegExp(`${point.knowledge_point_id}(?![0-9A-Za-z-])`, 'u');
    const matches = chunks.filter(chunk => pattern.test(textOf(chunk)));
    return { knowledge_point_id: point.knowledge_point_id, source_location: point.source_location,
      candidate_sha256: hash(point.text), matching_chunks: matches.length,
      full_body_matches: matches.filter(chunk => normalize(textOf(chunk)).includes(normalize(point.text))).length };
  });
  evidence.full_body_passed = evidence.checks.filter(check =>
    check.matching_chunks === 1 && check.full_body_matches === 1).length;
  evidence.chunk_count = chunks.length;
  evidence.literal_preserved = docID !== 'DOC0027'
    || chunks.some(chunk => textOf(chunk).includes('TXTX####—*****'));
  evidence.passed = evidence.full_body_passed === expected.knowledge_points.length && evidence.literal_preserved;
} catch (error) {
  evidence.error = error.message;
  evidence.passed = false;
}
await save(evidencePath, evidence);
manifest.debug_evidence = { path: evidencePath,
  sha256: hash(await readFile(path.join(root, evidencePath))), passed: evidence.passed };
await save(manifestPath, manifest);
console.log(JSON.stringify({ doc_id: docID, manifest_path: manifestPath,
  evidence_path: evidencePath, passed: evidence.passed, chunk_count: evidence.chunk_count,
  full_body_passed: evidence.full_body_passed, expected_points: expected.knowledge_points.length,
  literal_preserved: evidence.literal_preserved, error: evidence.error,
  failed: evidence.checks?.filter(check => check.matching_chunks !== 1 || check.full_body_matches !== 1).slice(0, 4) }));
if (!evidence.passed) process.exitCode = 1;
