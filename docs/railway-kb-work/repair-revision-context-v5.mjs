import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { hash, load, root, save } from './run.mjs';

const evidencePath = '05-review/revision-context-adjudication-v5.json';
const read = relative => readFile(path.join(root, relative));
let previous;
try { previous = await load(evidencePath); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (previous) {
  for (const binding of previous.outputs) assert.equal(hash(await read(binding.path)), binding.sha256);
  console.log(JSON.stringify({ verified_existing_repair: true, evidence: evidencePath }));
} else {
  const at = new Date().toISOString();
  const registry = await load('00-control/document-register.json');
  const doc = registry.find(d => d.doc_id === 'DOC0023');
  const expectedPath = doc.revision_v5.expected_path;
  const expected = await load(expectedPath);
  const master = (await read(doc.master_path)).toString('utf8');
  assert.equal(hash(master), doc.sha256);
  assert.equal(expected.master_sha256, doc.sha256);
  const point = expected.points.find(p => p.knowledge_point_id === 'DOC0023-K06');
  const before = structuredClone(point);
  assert.equal(point.dependencies.length, 2);
  assert.ok(master.includes(point.text));
  point.text = point.text.slice(0, point.text.length - point.body.length) + point.source_body;
  point.body = point.source_body;
  point.dependencies = [];
  point.expected_sha256 = hash(point.text);
  point.treatment = '第六条两句完整保留；范围前缀保留。第二、三条各有独立知识点，不作为生产企业定义的必要条件。';
  const revised = master.replace(before.text, point.text);
  assert.equal(master.split(before.text).length, 2);
  assert.equal(master.replace(before.text, ''), revised.replace(point.text, ''));
  const outputs = new Map();
  doc.sha256 = hash(revised);
  expected.master_sha256 = doc.sha256;
  doc.revision_v5.semantic_review = 'K06上下文裁定后待受影响8项复审；其余55项缓存可复用';
  doc.revision_v5.context_adjudication_path = evidencePath;
  outputs.set(doc.master_path, revised);
  outputs.set(expectedPath, expected);
  outputs.set('00-control/document-register.json', registry);
  const structures = await load('00-control/structure-register.json');
  Object.assign(structures.find(s => s.doc_id === doc.doc_id), {
    content_sha256: doc.sha256, state: '待复核',
    notes: 'v5第六条移除非必要内联重复，原文不变；待受影响语义复核及实际切片',
  });
  outputs.set('00-control/structure-register.json', structures);
  const full = await load('00-control/document-register-full.json');
  for (const group of [full.baseline, full.expanded]) {
    const index = group.findIndex(d => d.doc_id === doc.doc_id);
    if (index !== -1) group[index] = structuredClone(doc);
  }
  full.validation.find(d => d.doc_id === doc.doc_id).master_sha256 = doc.sha256;
  outputs.set('00-control/document-register-full.json', full);
  const snapshots = [];
  for (const [relative] of outputs) {
    const original = await read(relative);
    const snapshot = `05-review/history/pre-context-repair-v5/${relative}`;
    await assert.rejects(read(snapshot), { code: 'ENOENT' });
    await save(snapshot, original);
    snapshots.push({ path: relative, history_path: snapshot, sha256: hash(original) });
  }
  for (const [relative, data] of outputs) await save(relative, data);
  await save(evidencePath, {
    decided_at: at, doc_id: doc.doc_id, knowledge_point_id: point.knowledge_point_id,
    source_location: point.source_location, source_body: point.source_body,
    source_body_sha256: point.source_body_sha256, before, after: point,
    decision: 'REPAIR_UNNECESSARY_CONTEXT',
    rationale: '第六条自行定义境内制造企业及进口销售企业，第二条适用范围已在前缀说明；第三条定义缺陷，不是企业定义的成立条件。移除内联重复可避免把缺陷判断误读为企业资格条件，第二、三条原文仍分别完整保存在K02、K03。',
    source_unchanged: true, other_knowledge_points_unchanged: true, snapshots,
    outputs: await Promise.all([...outputs.keys()].map(async relative =>
      ({ path: relative, sha256: hash(await read(relative)) }))),
    affected_semantic_batch_points: ['DOC0023-K01', 'DOC0023-K02', 'DOC0023-K03', 'DOC0023-K04',
      'DOC0023-K05', 'DOC0023-K06', 'DOC0023-K07', 'DOC0023-K08'],
    remote_mutation: false,
  });
  console.log(JSON.stringify({ repaired: point.knowledge_point_id,
    master_sha256: doc.sha256, evidence: evidencePath }));
}
