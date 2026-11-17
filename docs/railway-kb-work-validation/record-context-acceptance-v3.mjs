import { api, domains, load, originalDataset, rows, save, table } from './run.mjs';

const register = await load('00-control/document-register.json');
const ledger = await load('00-control/revision-v3-ledger.json');
const preservation = await load('05-review/preservation-context-v3.json');
const retrieval = await load('00-control/acceptance-v3-context-retrieval.json');
const answers = await load('00-control/acceptance-v3-context-answers.json');
const inputs = await load('00-control/acceptance-v3-context-inputs.json');
const manifest = await load('00-control/acceptance-v3-context-manifest.json');
const pipeline = await load('00-control/domain-pipeline.json');
const sourceRegister = await load('00-control/source-register.json');
const summary = await api(`/datasets/${originalDataset}`);
const docs = rows(await api(`/datasets/${originalDataset}/documents?page=1&page_size=100`));
const formal = new Map(ledger.documents.filter(d => d.phase === 'formal')
  .map(d => [d.doc_id, d]));
const preserveById = new Map(preservation.documents.map(d => [d.document_id, d]));
const answerById = new Map(answers.map(a => [a.test_id, a]));
const retrievalById = new Map(retrieval.map(a => [a.test_id, a]));
const questions = inputs.questions;
const answerable = questions.filter(q => q.answerable);
const complete = answerable.filter(q => retrievalById.get(q.test_id)?.evidence_complete === true);
const byDomain = Object.fromEntries(['GW', 'XH', 'GD', 'CL', 'YS', '跨域'].map(domain => {
  const all = answerable.filter(q => q.domain === domain);
  return [domain, { passed: all.filter(q => retrievalById.get(q.test_id)?.evidence_complete).length,
    total: all.length }];
}));
const noEvidence = questions.filter(q => !q.answerable);
const answerFailures = answers.filter(a => !a.final_received || a.errors?.length);
const userAppRecorded = Boolean(manifest.user_app_before?.search_config &&
  manifest.user_app_after?.search_config);
const result = {
  checked_at: new Date().toISOString(),
  dataset_id: originalDataset,
  source_documents: register.length,
  current_formal_documents: preservation.current_count,
  retained_history_documents: preservation.history_count,
  preservation_passed: preservation.passed,
  business_chunks: preservation.documents.filter(d => d.role === 'current')
    .reduce((sum, d) => sum + d.chunk_count - 1, 0),
  retrieval: { total: questions.length, answerable: answerable.length,
    no_evidence: noEvidence.length, complete_evidence: complete.length,
    rate: complete.length / answerable.length, by_domain: byDomain },
  answers: { total: answers.length, final_received: answers.filter(a => a.final_received).length,
    transport_or_api_failures: answerFailures.length,
    semantic_review_completed: 0, semantic_review_pending: answers.length },
  holdout_status: 'H01-H10已用于既往调试；本轮为回归复测，不是独立留出集。',
  original_user_app_unchanged: userAppRecorded && JSON.stringify(manifest.user_app_before.search_config) ===
    JSON.stringify(manifest.user_app_after?.search_config),
  wiki: '未执行：检索及回答语义验收未达到前置门槛。',
};
result.preservation_artifact = '05-review/preservation-context-v3.json';
result.retrieval_artifact = '00-control/acceptance-v3-context-retrieval.json';
result.answers_artifact = '00-control/acceptance-v3-context-answers.json';
await save('00-control/context-acceptance-v3.json', result);

const imports = register.map(d => {
  const item = formal.get(d.doc_id);
  const live = docs.find(x => x.id === item?.document_id);
  const audit = preserveById.get(item?.document_id);
  return [d.doc_id, d.domain, item?.filename, item?.sha256, originalDataset,
    item?.document_id, d.source_id, item?.pipeline_version_id,
    audit?.checks?.all_points_complete_and_available ? '全量知识点正文比对通过；人工语义抽检待完成' : '待核验',
    live ? '已上传' : '缺失', live?.ingestion_status || '未知',
    audit?.chunk_count ?? '未核验', audit?.passed ? '原件、哈希、版本和切片状态实证通过' : '待核验'];
});
await save('00-control/import-register.md',
  `# 上传与解析登记\n\n正式重构目标为原知识库“${summary.name}”（${originalDataset}）。保留原件及历史文档，新版只在来源逐项核验后作为当前有效版本。\n\n${table(
    ['doc_id', '主领域', '文件名', 'SHA-256', '目标库 ID', '系统文档 ID', '来源', '管道版本', '结构复核', '上传', '解析', '切片数', '核验状态'],
    imports)}\n24 篇当前版本已在原库解析；结构机器核验覆盖完整，不等同于人工语义抽检。详见 ` +
  '`05-review/preservation-context-v3.json`。\n');

const domainRows = Object.entries(domains).map(([code, name]) => {
  const items = register.filter(d => d.domain === code);
  const sources = new Set(items.map(d => d.source_id));
  return [code, name, originalDataset, '原库内归档', items.length, sources.size,
    items.map(d => d.doc_id).join(', ')];
});
await save('00-control/domain-acceptance.md',
  `# 五领域归档验收\n\n本次采用用户明确要求：原知识库继续作为正式目标，不以测试库取代。\n\n${table(
    ['领域', '领域名', '真实知识库 ID', '模式', '有效候选文档', '独立来源', '文档 ID'],
    domainRows)}\n领域数量合计 ${register.length} 篇，来源数 ${new Set(register.map(d => d.source_id)).size}；来源现行效力仍须逐项核验。旧版和原件留存情况见 preservation 审计。\n`);

const datasetMap = [
  ['正式目标', summary.name, originalDataset, summary.tenant_id || 'f8123cce6b744a88bde9137a8fab0ed1',
    '原知识库；已复用', pipeline.pipeline_version_id,
    preservation.passed ? `可访问、${preservation.documents.length}份文件可下载` : '核验未通过',
    `${preservation.current_count}篇当前版；测试库不替代原库`],
  ...Object.entries(domains).map(([code, name]) => [code, name, originalDataset,
    summary.tenant_id || 'f8123cce6b744a88bde9137a8fab0ed1', '原库内按主领域归档',
    pipeline.pipeline_version_id, '见原库保留与正文核验', '领域为内容分类，不冒称已启用服务端领域筛选']),
  ...Object.entries(pipeline.trials).map(([code, trial]) => [
    `${code}隔离试验`, domains[code], trial.dataset_id,
    summary.tenant_id || 'f8123cce6b744a88bde9137a8fab0ed1', '测试库；不作为正式目标',
    pipeline.pipeline_version_id, '本次未重新核验测试库', '保留；不替代原库；ID来自试切登记']),
];
await save('00-control/dataset-map.md',
  `# 知识库映射\n\n${table(['用途/领域', '名称', '知识库 ID', '空间 ID', '状态', '管道版本', '可访问性', '说明'], datasetMap)}\n`);

await save('00-control/structure-register.md',
  `# 结构精修登记\n\n当前版本全部为条款级独立标题，条款编号、证据定位、来源版本及效力核验边界写入知识点。系统全量导出正文与预期知识点自动比对；人工语义抽检仍未完成。\n\n${table(
    ['doc_id', 'source_id', '标题', '主领域', '知识点数', '系统状态', '全量机器核验'],
    register.map(d => {
      const item = formal.get(d.doc_id);
      const live = docs.find(x => x.id === item?.document_id);
      const audit = preserveById.get(item?.document_id);
      return [d.doc_id, d.source_id, d.title, d.domain, d.structure_v3.knowledge_points,
        live?.ingestion_status || '缺失', audit?.checks?.all_points_complete_and_available
          ? '通过；人工抽检待完成' : '待核验'];
    }))}\n`);

const lines = [
  '# 铁路知识库重构进度',
  '',
  `最后核验：${result.checked_at}。本轮按指导书01→02→03继续，所有旧原件及版本保留。`,
  '',
  '## 保留原则',
  '- 原知识库是正式目标，不另建领域库取代。',
  '- 旧版本保留且停用检索，新版本只有在核验通过后作为当前版本。',
  '- 原件、本地快照和所有历史版本不得删除。',
  '',
  '## 本轮实证',
  `- 原库当前重构版：${result.current_formal_documents} 篇；检索停用历史版：${result.retained_history_documents} 篇；保留审计失败：${preservation.failures.length}。`,
  `- 当前版共 ${result.business_chunks} 个业务切片，24/24解析完成，正文/知识点自动核验通过。`,
  `- 检索回归：${complete.length}/${answerable.length} 道有证据题Top5命中全部必要证据（${(result.retrieval.rate * 100).toFixed(1)}%），未达到90%。`,
  `- 各领域：${Object.entries(byDomain).map(([d, v]) => `${d} ${v.passed}/${v.total}`).join('；')}。`,
  `- ${answers.length} 道回答均收到最终响应；逐题语义与引用人工审查尚待完成。`,
  `- 原用户搜索应用配置${result.original_user_app_unchanged ? '保持不变' : '发生变化，必须调查'}。`,
  '- Wiki未执行，因检索和语义验收门槛未满足。',
  '',
  '## 下一步',
  '1. 对70份回答逐条核对来源、条件、例外、无证据题拒答及引用定位；登记错误答案。',
  '2. 针对15道完整证据未命中的问题修正检索证据组织，再用未参与调试的问题复测。',
  '3. 核验来源版本效力、附件表格和存档扫描件；不能核验的明确排除，不计入有效量。',
  '4. 只有检索和回答验收通过后才执行 Wiki 编译。',
].join('\n') + '\n';
await save('00-control/progress.md', lines);

const final = `# 铁路知识库建设验收

## 文献扩充
冻结基线 N0=6，最低目标18篇、优先目标24篇。已整理并在原库导入${register.length}篇候选资料，涉及${new Set(register.map(d => d.source_id)).size}个来源；是否全部计为有效现行资料仍以版本、效力和附件核验为准。原始资料及历史版本均保留。

## 领域归档
${domainRows.map(r => `- ${r[0]} ${r[1]}：${r[4]} 篇，${r[5]} 个来源`).join('\n')}

## 结构与切片
${result.current_formal_documents}篇当前版本已解析，${result.business_chunks}个业务切片；全量正文及知识点自动对照通过。该机器检查不替代逐片语义人工检查。既有 BGE-M3 tokenizer 审计为1,131个切片，最大1,286 tokens，未超8,192上限；重排器token预算尚未核验。

## 检索与回答
${questions.length}题真实回归：${answerable.length}道有证据题，${noEvidence.length}道资料缺口题。Top5同时含全部预期证据 ${complete.length}/${answerable.length}（${(result.retrieval.rate * 100).toFixed(1)}%），低于90%门槛。领域结果：${Object.entries(byDomain).map(([d,v]) => `${d} ${v.passed}/${v.total}`).join('；')}。${result.answers.final_received}题收到最终回答；逐题语义和引用人工复核未完成。H01-H10为已暴露回归题，不再称独立留出。

## 原件和历史版本
原知识库未删除；当前${preservation.current_count}篇和${preservation.history_count}份历史/试验版本均可下载，SHA-256、解析状态、当前知识点正文与历史切片停用状态复核通过。细目见05-review/preservation-context-v3.json。

## Wiki
未执行。检索证据门槛和回答语义核验尚未通过，不能用Wiki掩盖源证据问题。

## 未完成
- 修复有证据题Top5完整证据命中率至至少90%，并用真正独立的复测集验证。
- 完成70题回答、引用和无证据题拒答的逐条语义核验。
- 完成法规效力/版本、扫描件及附件复杂表的证据核验。
- 在上述条件通过后再执行和核验Wiki。
`;
await save('00-control/final-acceptance.md', final);
await save('00-control/expansion-acceptance.md',
  `# 资料扩充验收\n\n冻结 N0=6；最低有效总量18，优先24。已完成 ${register.length} 篇候选资料的整理和原库解析，含 ${new Set(register.map(d => d.source_id)).size} 个登记来源，候选数量4×N0。按指导书01口径，最终有效数须以来源可核验、查重和版本/效力检查通过为准；未核验项不冒充已验收有效。五领域均已覆盖，详细分布见 domain-acceptance.md。\n\n旧文档检查覆盖以24篇知识点级材料为准，尚有来源效力及复杂附件待核验。检索回归完整证据命中率 ${complete.length}/${answerable.length}（${(result.retrieval.rate * 100).toFixed(1)}%），低于90%；本阶段**未通过最终验收**。\n`);

const semanticSample = [
  ['GW01', '通过（抽检）', '保留初步验收→安全评估→初期运营与正式验收→正式运营区分；需确认所有引用均在回答reference中。'],
  ['GW10', '拒答方向正确，边界待审', '明确缺少沉降限值；另称“通常应由设计文件、标准或专项评估确定”属于知识库外推，应在最终语义审查确认/收敛。'],
  ['GD10', '不通过（抽检）', '拒绝生成倒闸票方向正确，但扩写DOC0001处罚条款与问题无关且将知识库主题误说成牵引供电许可，形成误导上下文。'],
  ['CL02', '部分通过（抽检）', '正确区分许可目录、机车车辆定义和驾驶资格分类；登记的目标“目录类别”并未由源资料覆盖，需标作资料缺口。'],
  ['CL10', '部分通过（抽检）', '拒绝据基础设施检测规则判定机车上线正确；回答详细扩展DOC0010检测义务，必须显著标明不是机车上线判据。'],
  ['C01', '待复核', '涉及多个法规及现场职责；须逐项核对2021施工办法适用范围、保护区同意条件与电缆禁作业范围，不能仅按答复自述判正确。'],
  ['H04', '通过（抽检）', '正确呈现2022考试文本与2024资格许可规则中Z1/Z2适应性测试例外的区别；需核对TB/3091原件写法。'],
  ['H06', '部分通过（抽检）', '通知5日与收到通知单起算15日及自然日计算已列出；用户问文件编号和施行日，异议起算点保留。'],
  ['H08', '部分通过（抽检）', '现场改变须制作视听资料及退票责任分开论述；“不免除”应表述为两项义务无互相豁免条款，而非新增一般法律结论。'],
  ['H09/H10', '拒答方向正确（抽检）', '均明确无法提供具体证书/操作票；补充资料和建议措辞仍待检查有无不当替代指引。'],
];
await save('00-control/semantic-answer-review-v3.md',
  `# 回答语义抽检\n\n本文件只记录已抽查的样本；其余 ${answers.length - semanticSample.length + 1} 题不标成已审。完整原始回答及reference在 ` +
  '`00-control/acceptance-v3-context-answers.json` 与 `05-review/acceptance-v3-context/answers/`。\n\n' +
  table(['题号', '状态', '核验发现'], semanticSample) +
  '\n初步发现GD10出现无关处罚细节并误述知识库主题；无证据回答虽多数明确拒绝目标请求，但仍需检查外围说明是否超出证据。全量人工语义审计未完成，禁止把API成功等同于答案正确。\n');
console.log(JSON.stringify(result, null, 2));
