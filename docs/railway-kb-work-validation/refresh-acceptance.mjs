import { load, rows, save } from './run.mjs';

const ledger = await load('00-control/original-import-ledger.json');
const verification = await load('00-control/original-import-verification.json');
const results = await load('00-control/retrieval-run-results.json');
const bank = await load('00-control/question-bank.json');
const expectations = await load('00-control/retrieval-expectations.json');
const baseline = await load('00-control/inventory-original-documents.json');
const documents = rows(baseline.documents);
const docByID = new Map(documents.map(doc => [doc.id, doc]));
const verificationByDoc = new Map(verification.map(item => [item.doc_id, item]));
const resultByTest = new Map(results.map(item => [item.test_id, item]));
const domainNames = {
  GW: '铁路工务与基础设施', XH: '铁路通信信号与列车控制',
  GD: '铁路牵引供电与电气设备', CL: '铁路机车车辆与运用检修',
  YS: '铁路运输组织与安全管理',
};

const importRows = ledger.documents.map(item => {
  const check = verificationByDoc.get(item.doc_id);
  const old = (item.original_documents_to_retire || []).map(previous => previous.filename).join('、');
  return [
    item.doc_id, item.domain, item.filename, item.sha256, ledger.dataset_id,
    item.document_id, item.source_id, item.pipeline_version_id,
    '按条款覆盖机器核验；语义抽检未完成', '已上传',
    check?.ingestion_status || '未核验',
    check?.chunk_count_reported === check?.chunk_count_exported ? '已导出核对' : '待核验',
    `切片 ${check?.chunk_count_exported ?? '未核验'}；旧稿停用但保留：${old || '无'}`
  ];
});
await save('00-control/import-register.md', [
  '# 上传与解析登记',
  '',
  `正式目标：原知识库「轨知 · 铁路公开规章」\`${ledger.dataset_id}\`。新版沿用原库，不是另建库替代。`,
  '',
  '| doc_id | 主领域 | 上传文件 | SHA-256 | 目标知识库 ID | 系统文档 ID | 来源 | 管道版本 | 结构复核 | 上传 | 解析 | 切片导出 | 备注 |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...importRows.map(row => `| ${row.join(' | ')} |`),
  '',
  '所有21篇新版解析状态为 COMPLETED，导出切片数与系统报告数相符，条号覆盖机器审计无缺号。此记录不等同于逐片人工语义验收或检索验收。'
].join('\n'));

const domainCounts = Object.fromEntries(Object.keys(domainNames).map(domain => [
  domain, ledger.documents.filter(doc => doc.domain === domain).length
]));
await save('00-control/domain-acceptance.md', [
  '# 领域归档验收',
  '',
  '正式目标为原知识库，未将五个私人领域试验库当成交付目标。每篇仅计一个主领域。',
  '',
  ...Object.entries(domainNames).map(([code, name]) =>
    `- ${code} ${name}：${domainCounts[code]} 篇`),
  '',
  `合计：${ledger.documents.length} 篇已入原库；21篇均 COMPLETED。`,
  '',
  '待复核/本轮排除：DOC0010 与 DOC0016 的扫描件未逐页人工核对；DOC0014 的附件1-8尚未完整转录核验，未上传。具体清单以 document-register-full.json 和 05-review/ 为准。',
  '',
  '原库中6篇旧整理稿没有删除，已设为停用以免新旧重复参与检索；其系统记录仍在。原始 PDF、网页快照及采集文本保留在 01-originals/。'
].join('\n'));

const retrievalLines = [
  '# 真实检索验收记录',
  '',
  `运行时间：${(await load('00-control/retrieval-run-manifest.json')).finished_at}`,
  `目标知识库：${ledger.dataset_id}`,
  '固定参数：page_size=5、knn_top_k=32、knn_num_candidates=100、use_kg=false。',
  '每题原始 API 响应保存在 retrieval-raw/<test_id>.json；完整冻结题库和证据映射分别见 question-bank.json 与 retrieval-expectations.json。',
  '',
  '## 计分边界',
  '以下命中率只表示 Top5 是否出现预期文档 ID，不代表完整证据、条款语义、答案质量或引用准确性通过。逐题正文证据审核尚未完成。无证据题仅运行了检索，没有生成回答，因此拒答质量未测试。不得把这些比例称为完整验收通过率。',
  '',
  '| 领域 | 题数 | 有证据 | Top5命中预期文档 | 文档级命中率 | 无证据题 | 请求成功 |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: |'
];
for (const domain of [...Object.keys(domainNames), '跨域']) {
  const questions = bank.questions.filter(question => question[1] === domain);
  const answerable = questions.filter(([id]) => expectations[id].answerable);
  const hits = answerable.filter(([id]) => resultByTest.get(id)?.required_document_ids_present);
  retrievalLines.push(`| ${domain} | ${questions.length} | ${answerable.length} | ${hits.length} | ${answerable.length ? `${(hits.length / answerable.length * 100).toFixed(1)}%` : 'n/a'} | ${questions.length - answerable.length} | ${questions.filter(([id]) => !resultByTest.get(id)?.error).length} |`);
}
retrievalLines.push(
  '',
  '总体：60/60 请求成功；46题标为有证据，36题 Top5 至少出现预期文档，文档级命中率 78.3%，低于90%目标。跨领域完整命中为3/10。存在证据未进入Top5的题：GW05、XH03、XH07、C02、C03、C05、C06、C07、C08、C10。',
  '',
  '不达标原因需按题逐项确认，不能据文档名命中推断已找到支持答案的条款。本轮未调参刷分；全部冻结题目已运行一次。',
  '',
  '## 逐题结果',
  '',
  '| test_id | 领域 | 问题 | 预期有证据 | 预期文档 | Top5实际证据（文档/标题） | 预期文档均出现 | 回答/引用验收 |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |'
);
for (const [id, domain, kind, question] of bank.questions) {
  const result = resultByTest.get(id);
  const expected = expectations[id];
  const actual = (result?.top5 || []).map(chunk =>
    `${chunk.doc_id}: ${chunk.content.match(/^### (.+)$/m)?.[1] || '标题未提取'}`
  ).join('<br>');
  retrievalLines.push(`| ${id} | ${domain} | ${question} | ${expected.answerable ? '是' : '否'} | ${expected.doc_ids.join(', ') || '无'} | ${actual || result?.error || '无结果'} | ${result?.required_document_ids_present ? '是' : '否/不适用'} | 未生成回答；未核验 |`);
}
await save('00-control/retrieval-tests.md', retrievalLines.join('\n'));

const chunkCount = verification.reduce((sum, item) => sum + item.chunk_count_exported, 0);
const parsed = ledger.documents.filter(item => item.status === 'parsed-coverage-passed').length;
await save('00-control/wiki-review.md', [
  '# Wiki 编译核验',
  '',
  '状态：未执行。',
  '',
  `原因：60题真实检索文档级命中仅36/46（78.3%），跨领域完整文档命中3/10；逐题证据、无证据回答拒答和引用准确性也尚未验收。指导书03要求这些门槛通过后才编译 Wiki。`,
  '',
  '不得以已有 Wiki 编译器代码或任务提交成功替代实际编译和来源核验。'
].join('\n'));

await save('00-control/final-acceptance.md', [
  '# 铁路知识库建设验收',
  '',
  '## 文献扩充',
  '冻结基线 N0=6，最低目标18篇，优先目标24篇。原库现有21篇新版有效候选已上传并解析，按数量达到3.5倍；但DOC0010、DOC0016扫描件未逐页复核，DOC0014附件1-8不完整，来源效力亦未逐篇核验，因此不能将21篇全部记为最终验收有效文献。按当前未解决项保守计，至少18篇可进入后续语义与效力审查，文献阶段尚未最终通过。',
  '',
  '## 领域归档',
  ...Object.entries(domainNames).map(([code, name]) => `- ${code} ${name}：${domainCounts[code]} 篇`),
  '使用原知识库 ID `66ff4d9d5ff748af8e83080bd7482f04`，所属空间 `f8123cce6b744a88bde9137a8fab0ed1`。21篇新版在原库；五个领域试验库不作为交付。',
  '',
  '## 结构与切片',
  `21/21篇新版解析 COMPLETED；系统报告与全量导出均为 ${chunkCount} 片，条款编号机器覆盖检查无缺号。新文档采用条款级标题，原编号与原文定位保留；这仍不等于逐片人工语义验收。两份扫描件、一个缺附件来源未进入正式库。`,
  '',
  '## 检索与 Wiki',
  '60/60真实检索请求成功。46道有证据题中，36道Top5含预期文档ID，文档级命中78.3%，低于90%目标；五领域分别为6/7、5/7、7/7、6/6、9/9，跨域3/10。完整条款证据、回答条件保留、拒答和引用回源均未通过人工核验。Wiki未执行。',
  '',
  '## 保留与替代',
  '原知识库未删除、未另建库替代；原始 PDF 和网页采集件保留。六篇旧整理稿没有删除，但其状态为停用，防止与重构版同时进入检索。六篇新版均在同一原库中作为替代版本。',
  '',
  '## 未完成事项',
  '- 对46道有证据题逐条核对Top5中的准确条款、条件、例外和来源定位；失败题先修复结构/映射/检索原因，再以独立复测集验证。',
  '- 对14道无证据题运行真实回答并检查是否拒答，不得补造结论或引用。',
  '- 完成DOC0010、DOC0016扫描件逐页视觉复核；补齐DOC0014附件1-8并核验后再决定是否纳入。',
  '- 核验各规章的发布版本、修订及现行效力，尤其来源登记中已标注版本冲突的S0002、S0004；未核验前只能称按存档文本整理。',
  '- 结构/切片人工抽检：核对首末、最长最短及所有数字、否定、例外、表格和步骤依赖片段，并记录检查数。',
  '- 检索门槛和引用核验通过后，再按领域编译并抽查 Wiki。'
].join('\n'));

await save('00-control/progress.md', [
  '# 铁路知识库重构进度',
  '',
  '最后更新：2026-11-16（Asia/Shanghai）。按指导书01→02→03执行；本进度明确区分上传、解析、检索和 Wiki。',
  '',
  '## 目标与保留策略',
  '- 正式目标是原知识库「轨知 · 铁路公开规章」，ID `66ff4d9d5ff748af8e83080bd7482f04`，空间 `f8123cce6b744a88bde9137a8fab0ed1`。本次是在原库内重构，不另建库取代原库。',
  '- 原始资料和原库均保留。六篇旧整理稿未删除，状态设为停用；21篇重构版位于同一原库。停用旧整理稿是为避免检索重复，不是删除原始文献。',
  '- 五个领域库仅为试验库，不计正式交付。',
  '',
  '## 已完成',
  `- 21篇新版上传到原库，21/21解析状态为 COMPLETED；解析版本 ${ledger.pipeline_version_id}。完整导出共${chunkCount}片，与系统报告相符；条款覆盖机器审计无缺号。`,
  '- 冻结的60题已在原库执行一次Top5真实检索，60/60 API 请求成功，原始响应逐题保存。',
  '- 已生成按当前真实系统记录更新的导入登记、领域验收、检索记录和总验收。',
  '',
  '## 当前验收结果',
  '- N0=6，目标最低18篇；21篇上传候选按数量为3.5×N0，但两篇扫描件和一份缺附件资料未纳入，因此文献/来源阶段仍待核验。',
  '- 文档级Top5命中：36/46可回答题（78.3%），低于90%门槛；跨域完整文档命中3/10。该数字尚非条款级证据通过率。',
  '- 14道无证据题未生成回答，拒答能力未测。回答引用和逐条证据均未验收。',
  '- Wiki未执行，等待检索和来源核验通过。',
  '',
  '## 下一步',
  '1. 分析Top5失败题，逐条回源核验召回证据；修复文档结构或检索配置后使用未参与调试的复测题验收。',
  '2. 视觉复核DOC0010、DOC0016全部扫描页，补齐DOC0014附件；核验规章版本与效力。',
  '3. 完成条款语义与切片人工抽检、无证据题拒答和引用定位复核。',
  '4. 满足门槛后才编译 Wiki，记录页面与来源证据。'
].join('\n'));

console.log(JSON.stringify({
  documents: ledger.documents.length, parsed, chunks: chunkCount,
  answerable: 46, documentLevelHits: 36, wiki: 'not-executed'
}, null, 2));
