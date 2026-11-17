import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { api, hash, load, root, rows, save } from './run.mjs';

const [docID, phase = 'trial'] = process.argv.slice(2);
assert.ok(['DOC0022', 'DOC0023'].includes(docID));
assert.ok(['trial', 'formal'].includes(phase));
const at = new Date().toISOString();
const registry = await load('00-control/document-register.json');
const doc = registry.find(item => item.doc_id === docID);
const decision = await load(doc.revision_v5.structure_decision.path);
assert.equal(decision.structure_accepted, true);
const bytes = relative => readFile(path.resolve(root, relative));
assert.equal(hash(await bytes(doc.master_path)), decision.bindings.master.sha256);
assert.equal(hash(await bytes(doc.revision_v5.expected_path)), decision.bindings.expected.sha256);
const expected = await load(doc.revision_v5.expected_path);
const actualPath = `04-chunks/actual/${docID}-successor-${phase}.json`;
const actualBytes = await bytes(actualPath);
const actual = JSON.parse(actualBytes);
assert.equal(actual.sha256, doc.sha256);
assert.equal(actual.deterministic_passed, true);
assert.equal(actual.expected_points, expected.points.length);
assert.equal(actual.nonbusiness_chunk_ids.length, 1);
const textOf = chunk => chunk.content || chunk.content_with_weight || '';
const compact = text => text.replace(/\*\*([^*]+)\*\*/gu, '$1').replace(/\s+/gu, '');
const lines = text => text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
const findings = docID === 'DOC0022' ? {
  'DOC0022-K03': '四类许可及投入运营/批量制造之前的条件完整，大修原文引号保留；第二条定义同片。',
  'DOC0022-K06': '九项取证条件完整，合作方式、特种设备和无侵权条件未遗漏。',
  'DOC0022-K07': '八项制造许可条件完整，已有型号证、样车型式试验和技术评价未混同。',
  'DOC0022-K08': '八项维修条件完整，合同/协议/委托证明的选择关系、例行试验均保留。',
  'DOC0022-K09': '七项进口条件完整，国内需求、境外资质、国内用户审查均保留。',
  'DOC0022-K15': '三类受理情形及5个工作日一次告知、逾期视为受理、书面凭证完整。',
  'DOC0022-K17': '受理起20工作日、批准延长10工作日、不计检验检测专家评审时间同片。',
  'DOC0022-K18': '颁发送达10工作日起点为作出许可决定，未与受理期限合并。',
  'DOC0022-K20': '长期/5年/5、8、10年分别对应证类，延续申请为届满60工作日前。',
  'DOC0022-K21': '名称变更30工作日、有效期不变与第二十二条许可条件变化例外同片。',
  'DOC0022-K22': '地址造成许可条件变化、产品重大变化及第二十一条名称变更依赖同片。',
  'DOC0022-K24': '隐瞒/虚假申请警告及1年禁申完整，未混同撤销后3年限制。',
  'DOC0022-K25': '可以撤销五情形与欺骗贿赂应当撤销、3年禁申分别保留。',
  'DOC0022-K26': '注销五情形完整，与撤销、吊销保持原文区别。',
  'DOC0022-K28': '2014原施行日期与旧办法废止保留，未冒充2019修正施行日期。',
} : {
  'DOC0023-K02': '依法许可产品与其他直接影响运输安全产品的监管边界完整。',
  'DOC0023-K06': '境内制造企业定义和境外进口到境内销售企业视同生产企业完整；未加无关依赖。',
  'DOC0023-K07': '生产企业责任、费用、经监造符合要求方可使用及监造完整定义同片。',
  'DOC0023-K09': '可能缺陷调查、正在使用时立即通知并协商安全保障措施同片。',
  'DOC0023-K12': '拒绝调查时直接组织或委托无利害关系机构的条件与通知对象完整。',
  'DOC0023-K14': '四项调查措施完整，第三项分号和第四项未丢失。',
  'DOC0023-K16': '八项调查报告内容与受托机构真实性准确性责任同片。',
  'DOC0023-K17': '收到调查结果起15工作日及无利害关系论证机构、必要技术检验完整。',
  'DOC0023-K18': '立即停止生产销售进口与影响运输秩序时共同应急措施条件同片。',
  'DOC0023-K19': '完整召回计划九项，措施、时间安排、应急与报告评估均保留。',
  'DOC0023-K20': '初次报备与调整重新报备两个要求同片。',
  'DOC0023-K21': '调查确认、期限内未异议并且未召回的并列条件及第十七条15工作日依赖完整。',
  'DOC0023-K23': '三方各保存一份与不得少于5年的下限完整。',
  'DOC0023-K30': '限期改正引导冒号及六种违法情形完整。',
  'DOC0023-K31': '责令改正后拒不改正条件、三档罚款、严重时吊证及刑责完整；百分号字形原样保留。',
  'DOC0023-K32': '处分与涉嫌犯罪移交的分号及三类违法情形完整。',
  'DOC0023-K33': '召回不免其他法律责任及缺陷以外质量问题的法律合同依据完整。',
  'DOC0023-K35': '2016原施行日期与2018修正版本分别保留，不互换。',
};
const checks = expected.points.map(point => {
  const coverage = actual.checks.find(item => item.knowledge_point_id === point.knowledge_point_id);
  assert.equal(coverage.complete_chunk_ids.length, 1);
  const chunk = actual.chunks.find(item => item.id === coverage.complete_chunk_ids[0]);
  const content = textOf(chunk);
  const fullExpected = `${point.heading_path.map((label, index) => `${'#'.repeat(index + 1)} ${label}`).join('\n')}\n${point.text}`;
  assert.equal(compact(content), compact(fullExpected), `${point.knowledge_point_id}: extra or missing content`);
  assert.equal(chunk.doc_type_kwd, 'text');
  assert.equal(chunk.available, true);
  const expectedList = lines(point.text).filter(line => /^（[一二三四五六七八九十]+）/u.test(line)).map(compact);
  const actualList = lines(content).filter(line => /^（[一二三四五六七八九十]+）/u.test(line)).map(compact);
  assert.deepEqual(actualList, expectedList, `${point.knowledge_point_id}: list changed`);
  const reviewed = decision.points.find(item => item.knowledge_point_id === point.knowledge_point_id);
  assert.equal(reviewed.candidate_sha256, hash(point.text));
  assert.equal(reviewed.semantic_status, 'PASS');
  return { knowledge_point_id: point.knowledge_point_id, chunk_id: chunk.id,
    source_location: point.source_location, actual_text_sha256: hash(content),
    candidate_sha256: hash(point.text), source_body_sha256: hash(point.source_body),
    exact_complete_unit: true, headings_source_version_and_dependencies_together: true,
    ordered_list_items: actualList.length, semantic_evidence: reviewed.semantic_evidence,
    source_semantic_finding: reviewed.finding,
    actual_review: findings[point.knowledge_point_id] || '已查看实际完整条款；对象、条件、结论与原文审查一致，未出现额外业务正文或上下文分离。',
    decision: 'PASS' };
});
assert.equal(actual.exported_count, expected.points.length + 1);
assert.ok(actual.maximum_tokens_with_filename <= decision.budgets.maximum_prefixed_tokens);
assert.ok(actual.maximum_tokens_with_filename < decision.budgets.embedding_runtime_limit);
const metadata = actual.chunks.filter(chunk => actual.nonbusiness_chunk_ids.includes(chunk.id));
assert.ok(metadata.every(chunk => textOf(chunk).includes('本节仅供追溯；不作为业务问答证据。')
  && !/DOC00\d+-K\d+/u.test(textOf(chunk))));
await api(`/datasets/${actual.dataset_id}/documents/${actual.document_id}/chunks`, 'PATCH', {
  chunk_ids: metadata.map(chunk => chunk.id), available: false,
});
const after = rows(await api(`/datasets/${actual.dataset_id}/documents/${actual.document_id}/chunks?page=1&page_size=100`));
assert.equal(after.length, actual.exported_count);
for (const before of actual.chunks) {
  const now = after.find(chunk => chunk.id === before.id);
  assert.ok(now);
  assert.equal(textOf(now), textOf(before));
  assert.equal(now.available, !actual.nonbusiness_chunk_ids.includes(now.id));
}
if (phase === 'formal') {
  const trial = await load(`05-review/${docID}-trial-quality-v5.json`);
  assert.equal(trial.quality_accepted, true);
  assert.equal(trial.master_sha256, doc.sha256);
  assert.deepEqual(checks.map(item => item.actual_text_sha256), trial.checks.map(item => item.actual_text_sha256));
}
const evidencePath = `05-review/${docID}-${phase}-quality-v5.json`;
await save(evidencePath, { reviewed_at: at, doc_id: docID, phase,
  dataset_id: actual.dataset_id, document_id: actual.document_id, master_sha256: doc.sha256,
  expected_sha256: decision.bindings.expected.sha256, actual_path: actualPath,
  actual_sha256: hash(actualBytes), actual_after_metadata_exclusion: after,
  pipeline_id: actual.pipeline_id, pipeline_version_id: actual.pipeline_version_id,
  structure_decision: doc.revision_v5.structure_decision, checks,
  exported_chunks: actual.exported_count, accepted_business_chunks: checks.length,
  metadata_excluded_chunk_ids: metadata.map(chunk => chunk.id),
  maximum_tokens_with_filename: actual.maximum_tokens_with_filename,
  actual_budget_bound: 'Complete actual input is no longer than the preflight complete title/filename/body input, with matching tokenizer; no semantic text deleted.',
  review_method: 'Codex inspected all complete exported business bodies/headings in this continuation; qualified source semantic reviews reused only after exact body, heading, dependency and ordered-list identity checks. Formal output also compared with accepted trial.',
  quality_accepted: true, formal_import: phase === 'formal', retrieval_accepted: false,
  new_semantic_requests: 0, remote_mutations: [{ action: 'Exclude traceability-only metadata chunk from retrieval',
    chunk_ids: metadata.map(chunk => chunk.id), verified: true }],
  limitation: 'Chunk fidelity accepted; final retrieval, citations, answer behavior and final effective-document count remain unaccepted.' });
const ledger = await load('00-control/successor-import-ledger.json');
const record = ledger.documents.find(item => item.document_id === actual.document_id);
assert.ok(record);
record.status = 'chunk-quality-accepted';
record.quality_evidence = evidencePath;
record.quality_evidence_sha256 = hash(await bytes(evidencePath));
record.reviewed_at = at;
await save('00-control/successor-import-ledger.json', ledger);
doc.revision_v5[phase === 'formal' ? 'formal_import' : 'current_trial'] = {
  checked_at: at, dataset_id: actual.dataset_id, document_id: actual.document_id,
  master_sha256: doc.sha256, pipeline_id: actual.pipeline_id, pipeline_version_id: actual.pipeline_version_id,
  chunks: actual.exported_count, business_chunks: checks.length,
  quality_accepted: true, evidence_path: evidencePath, evidence_sha256: record.quality_evidence_sha256 };
doc.revision_v5.remote_upload_status = phase === 'formal' ? '正式CL库已入库；逐片质量通过' : '当前v5隔离试切质量通过';
doc.revision_v5.real_chunk_status = `${checks.length}个业务点完整；1个追溯索引片段停用检索`;
doc.status = phase === 'formal' ? '已入库待验证' : '试切通过';
doc.final_count_eligible = false;
doc.exclusion_reason = phase === 'formal' ? '当前版正式入库、逐片质量通过；最终检索/引用/无证据回答尚未验收。'
  : '当前版隔离试切通过；正式导入及检索验收尚未完成。';
await save('00-control/document-register.json', registry);
console.log(JSON.stringify({ doc_id: docID, phase, quality_accepted: true,
  business_chunks: checks.length, excluded_metadata: metadata.length, evidence: evidencePath }));
