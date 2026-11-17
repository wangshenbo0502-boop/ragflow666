import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { hash, load, root, save, table } from './run.mjs';

const inputsPath = '00-control/acceptance-v3-context-inputs.json';
const answersPath = '00-control/acceptance-v3-context-answers.json';
const inputsBytes = await readFile(path.join(root, inputsPath));
const answersBytes = await readFile(path.join(root, answersPath));
const inputs = JSON.parse(inputsBytes);
const answers = JSON.parse(answersBytes);
const docs = await load('00-control/document-register.json');
const checkedAt = new Date().toISOString();
const judgments = [
  ['GW09', 'PARTIAL', ['DOC0010-K09', 'DOC0016-K09'],
    '明确没有按钮顺序；DOC0010第九条仅有设备配置。把切片前缀中整理者所写“不提供特定型号检修参数”说成办法自身明确注明，混淆整理边界与原文；多引无关监督抽查规定。',
    '只保留未找到本型号校准程序的结论；若说明资料范围，明确其为整理说明，不冒充原文条款。'],
  ['GW10', 'FAIL', ['DOC0010-K09', 'DOC0009-K10', 'DOC0024-K40'],
    '没有编造沉降数值；但末段“通常应由设计文件、技术标准或专项评估确定”以及“开展专项勘察评估”没有相应限值确定条款支持。列举检测、勘察和灾害防治不能推出缺资料时的限值替代办法。',
    '删除限值确定方式和替代评估建议，仅说明缺少该隧道允许沉降值及适用条件证据。'],
  ['XH09', 'FAIL', ['DOC0013-K35', 'DOC0013-K36', 'DOC0013-K26'],
    '拒绝给按钮顺序，却补充“通常须依据……调度命令”“先确认区段实际空闲、履行登记和批准手续”等现场处理判断。引用条款是施工联锁、试验及开通场景，不能外推为红光带故障强制解锁条件。',
    '删除红光带定义、操作前提及手续推断，明确本库证据不足以判断能否强制解锁或给出步骤。'],
  ['XH10', 'PASS', [],
    '本题仅问能否确定某厂家列控软件所有版本的安全认证状态。实际回答明确不能确定，没有声称全部版本已认证；拒答边界符合，审查关闭。不将附件复核、引用清单或其他认证问题扩成本题缺陷。',
    '本题拒答边界无待修正项；本结论不代表全题引用审计完成，也不代表应用或服务侧已修复。'],
  ['GD09', 'PARTIAL', ['DOC0016-K19', 'DOC0016-K37'],
    '没有猜油温；把本次检索到的监督抽查材料概括成全部现有资料，并把整理者范围说明写成文件明文。少于2人的抽样和不合格产品规定与油温无关；第三十七条的库存禁用部分也没有随所引结论呈现。',
    '仅说明未找到适用型号及油温限值证据，不扩写不相关程序和处罚/禁用规定。'],
  ['GD10', 'FAIL', ['DOC0001-K33'],
    '拒绝签票正确，但主动展开罚则时遗漏“逾期未改正或者拒不改正”这一通报批评及罚款前提；结尾再补作业规程、调度命令和单位制度等本片未规定的现场执行依据。旧抽检中“误说牵引供电许可”的描述与本题实际回答不符，予以纠正。',
    '删除无关罚则及现场执行建议。若另问第三十三条，必须保留责令改正后触发罚款的条件。'],
  ['CL02', 'PARTIAL', ['DOC0022-K02', 'DOC0017-K05'],
    '正确区分车辆定义、许可目录和驾驶资格系列，没有用J/L分类替代目录。但回答以2013许可文件展开范围，未带回切片明确的存档/后续修订待核验边界，不能作为截至当前的许可目录答案。',
    '明确目录正文缺失；如保留2013定义须注明是存档材料、不是现行目录分类。'],
  ['CL09', 'PARTIAL', ['DOC0018-K15', 'DOC0018-K46', 'DOC0018-K37'],
    '没有编造毫米数值，但把仅检索到的考试管理文件写成“现有资料为”该一份文件，误述库整体范围。考试条款并不能支撑车辆闸片技术参数。',
    '改为“本次检索未找到适用车型的闸片厚度限值”，不把单次命中范围等同于全部资料。'],
  ['CL10', 'PARTIAL', ['DOC0010-K18', 'DOC0010-K23', 'DOC0010-K32', 'DOC0010-K34'],
    '明确基础设施检测不是单台机车上线判据，也没有给出放行结论；所引数据条款与参考切片一致。仍扩写无关罚则和资格许可材料，并对“本库没有专门规定”作超出单次检索的全库断言；未逐条给直接证据编号。',
    '精简为适用对象不匹配及缺少上线放行条件、机车检测数据，避免附带无关处罚。'],
  ['YS09', 'PARTIAL', ['DOC0004-K04', 'DOC0004-K20', 'DOC0004-K31'],
    '没有编造实时余票/票价，规则与实时数据的边界正确。展开第四条时未带“另有约定的，按照其约定”边界；退改票规则与实时查询无关。官方售票渠道建议不是本次reference提供的知识证据。',
    '只说明资料库不含实时数据；精简无关法规说明，不将外部查询建议包装为库内结论。'],
  ['H09', 'FAIL', ['DOC0014-K15', 'DOC0014-K16', 'DOC0022-K19', 'DOC0014-K30'],
    '没有编造认证证书编号，但把生产许可证格式与编号规则归至第十六条；实际编号规则在第十五条，第十六条才规定5年有效期。引用2013许可文件未保留存档版本边界；所举生产许可例子不能支持软件安全认证状态。',
    '删除无关证书举例；如保留必须分别定位第十五、十六条并明确生产许可证不是软件安全认证证书。'],
  ['H10', 'FAIL', ['DOC0015-K05', 'DOC0015-K06', 'DOC0015-K12', 'DOC0015-K13', 'DOC0014-K30'],
    '未生成开关编号或票据，但“格式和开关编号须依据……双重名称编号规则……编制”等属于所引生产企业审批材料没有规定的现场作业文件编制判断。无关信号目录也不能提供倒闸票依据。',
    '删除现场编制规则及不相关目录扩写，仅说明缺少适用站场与规程证据，无法生成或签发操作票。'],
];
const noEvidenceIDs = inputs.questions.filter(q => !q.answerable).map(q => q.test_id).sort();
assert.deepEqual(judgments.map(item => item[0]).sort(), noEvidenceIDs);
const originalCache = new Map();
const expectedCache = new Map();
const normalize = text => text.normalize('NFC').replace(/\s/gu, '');
const reviewed = [];
for (const [testID, status, pointIDs, findings, remedy] of judgments) {
  const question = inputs.questions.find(q => q.test_id === testID);
  const answer = answers.find(item => item.test_id === testID);
  assert.ok(answer?.final_received && answer.answer, `${testID} missing final answer`);
  const reference = answer.reference.chunks;
  const evidence = [];
  for (const pointID of pointIDs) {
    const chunk = reference.find(item => item.content.includes(pointID));
    assert.ok(chunk, `${testID} missing reference ${pointID}`);
    const doc = docs.find(item => item.doc_id === pointID.split('-')[0]);
    if (!originalCache.has(doc.doc_id)) {
      originalCache.set(doc.doc_id, await readFile(path.join(root, doc.original_path), 'utf8'));
    }
    const original = originalCache.get(doc.doc_id);
    assert.ok(original.trim(), `${doc.doc_id} empty original`);
    if (!expectedCache.has(doc.doc_id)) {
      expectedCache.set(doc.doc_id, await load(doc.structure_v3.expected_path));
    }
    const point = expectedCache.get(doc.doc_id).points.find(item => item.knowledge_point_id === pointID);
    assert.ok(point, `${pointID} missing expected point`);
    const sourceBytes = await readFile(path.join(root, point.source_path));
    const isAttachment = path.extname(point.source_path).toLowerCase() === '.pdf';
    if (!isAttachment) {
      assert.ok(normalize(sourceBytes.toString('utf8')).includes(normalize(point.source_body)),
        `${pointID} expected body not found in source`);
      assert.ok(normalize(chunk.content).includes(normalize(point.source_body)),
        `${pointID} source body not found in reference`);
    }
    const header = chunk.content.split('\n').find(line => line.includes(pointID));
    const sourceIDs = [...header.matchAll(/S\d{4}/gu)].map(match => match[0]);
    assert.ok(sourceIDs.includes(doc.source_id), `${pointID} source mismatch`);
    evidence.push({ knowledge_point_id: pointID, chunk_id: chunk.id,
      source_id: doc.source_id, original_path: doc.original_path,
      source_location: header, reference_sha256: hash(chunk.content),
      original_sha256: hash(original),
      point_source_path: point.source_path, point_source_sha256: hash(sourceBytes),
      verbatim_source_body_verified: isAttachment ? null : true,
      scope: isAttachment
        ? '附件存在性和页定位检查；本轮未重新视觉核对原表，不能据此通过附件内容审查'
        : '回答正文与reference、存档原文交叉核对',
    });
  }
  reviewed.push({ test_id: testID, question: question.question, status,
    scope: testID === 'XH10'
      ? '仅复核用户问题要求的全部软件版本认证状态拒答边界；该项审查关闭'
      : '无证据拒答边界及主动展开的关键断言复核；不是整题全部引用的最终验收',
    boundary_review_closed: status === 'PASS',
    findings, remedy, evidence, answer_sha256: hash(answer.answer),
    raw_path: answer.raw_path, final_acceptance_passed: false });
}
const report = {
  checked_at: checkedAt, review_type: 'agent_semantic_review',
  inputs_path: inputsPath, inputs_sha256: hash(inputsBytes),
  answers_path: answersPath, answers_sha256: hash(answersBytes),
  reviewed_no_evidence: reviewed.length,
  status_counts: Object.fromEntries(['PASS', 'PARTIAL', 'FAIL'].map(status =>
    [status, reviewed.filter(item => item.status === status).length])),
  all_question_final_citation_audit_completed: false,
  all_no_evidence_final_acceptance_passed: false,
  original_answers_modified: false, user_app_modified: false,
  findings: reviewed,
};
if (!process.argv.includes('--check')) {
  const prior = '00-control/semantic-answer-review-v3.md';
  const history = '05-review/history/pre-no-evidence-review-v3-semantic-answer-review.md';
  try { await access(path.join(root, history)); }
  catch { await save(history, await readFile(path.join(root, prior))); }
  await save('05-review/no-evidence-semantic-review-v3.json', report);
  await save(prior, '# 回答语义审查\n\n' +
    `审查时间：${checkedAt}。本轮完成12道无证据题的拒答边界及关键附带断言复核：` +
    `${report.status_counts.PASS}道边界审查通过、${report.status_counts.FAIL}道不通过、${report.status_counts.PARTIAL}道部分通过。` +
    '这不是70题全部语义/引用验收完成，也不是在原应用中修复了生成行为。\n\n' +
    table(['题号', '边界审查', '核验发现', '证据定位', '修正要求'],
      reviewed.map(item => [item.test_id, item.status, item.findings,
        item.evidence.map(e => e.knowledge_point_id).join('、'), item.remedy])) +
    '\n## 审查范围与未完成项\n' +
    '- 原始70份回答及SSE不改写；逐题证据、文本哈希、来源路径见 `05-review/no-evidence-semantic-review-v3.json`。\n' +
    '- 本轮是拒答边界审查，不把引用清单存在等同于对应结论正确；复杂附件仍需原表核验。\n' +
    '- XH10仅问某厂家列控软件所有版本的安全认证状态；回答明确不能确定，拒答边界审查通过并关闭，不要求额外引用点。该结论不是全题引用审计或应用/服务修复结论。\n' +
    '- 其余58道有证据题尚未完成全量语义/引用审查；此前抽检保存在历史副本，仅为待复核线索。\n' +
    '- 旧抽检对GD10的主题描述不准确；本次按实际回答纠正，并新增罚款前提缺失发现。\n' +
    '- 无证据题全部通过门槛尚未达到；未修改应用、模型、服务或数据库设置，尚无修复后真实复测。\n');
}
console.log(JSON.stringify({ mode: process.argv.includes('--check') ? 'check' : 'write',
  reviewed: report.reviewed_no_evidence, statuses: report.status_counts,
  original_answers_unchanged: hash(await readFile(path.join(root, answersPath))) === hash(answersBytes) }));
