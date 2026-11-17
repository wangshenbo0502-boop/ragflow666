import { readFile } from 'node:fs/promises';
import { load, save, table, domains } from './run.mjs';

const baseline = await load('00-control/baseline-curation.json');
const docs = await load('00-control/document-register.json');
const selected = await load('00-control/selected-sources.json');
const pipeline = await load('00-control/domain-pipeline.json');
const sources = [...baseline.sources, ...selected.filter(s => s.original_path).map(s => ({
  source_id: s.source_id,
  title: s.title,
  publisher: s.metadata?.SiteName || '国家铁路局 / 交通运输部（按来源页面）',
  url: s.fetched_url || s.url,
  original_path: s.original_path,
  published: s.metadata?.PubDate || '原文内发布信息待逐项核验',
  version: s.title.match(/20\d{2}/)?.[0] || '按原文公布版本',
  access_date: '2026-11-15',
  status: s.extraction?.includes('pending') ? '待复核：附件文本层需视觉核验' : '官方来源正文已采集；效力状态待核验',
  domain: s.domain,
  attachments: s.attachments || []
}))];
await save('00-control/source-register.json', sources);
await save('00-control/document-register-full.json', {
  baseline: baseline.docs,
  expanded: docs,
  count: { baseline: baseline.docs.length, source_backed_expansion: docs.filter(d => d.count_as_valid).length, held: docs.filter(d => !d.count_as_valid).length }
});
await save('00-control/document-register.json', [...baseline.docs, ...docs]);

const sourceRows = sources.map(s => [s.source_id, s.title, s.publisher, s.published || '', s.version || '', s.domain, s.url, s.original_path, s.access_date, s.status]);
await save('00-control/source-register.md', '# 来源登记表\n\n' + table(
  ['source_id','标题','发布机构','发布日期','版本','主领域','原文地址','原件路径','访问日期','核验状态'],
  sourceRows
));
const rationale = {
  S0001: '正文核心为设备生产企业与机车车辆许可及全寿命质量管理，主归 CL。',
  S0002: '正文核心为车票实名购买、查验和管理，主归 YS。',
  S0003: '正文核心为旅客运输安全检查，主归 YS。',
  S0004: '正文核心为旅客运输合同、票务、乘车与运输服务，主归 YS。',
  S0005: '正文核心为铁路交通事故救援、报告和调查处理，主归 YS。',
  S0006: '综合铁路安全法规；此整理副本主归 GW，跨域问题按条款引用，原库保留唯一原件。'
};
const auxiliary = { S0001: 'GD', S0005: 'GW,CL', S0006: 'XH,GD,CL,YS' };
await save('00-control/domain-register.md', '# 五领域归档登记\n\n' + table(
  ['doc_id','标题','主领域','辅助领域','判断依据','原件路径','当前主副本路径','版本状态','处理状态'],
  [...baseline.docs, ...docs].map(d => [
    d.doc_id, d.title, d.domain, auxiliary[d.source_id] || '',
    rationale[d.source_id] || `正文主题为${d.title}；按规章直接约束的主要对象归入${d.domain}。`,
    d.original_path, d.master_path,
    d.extraction_review_required ? '附件文本待核验' : '官方发布版本；现行效力待核验',
    d.status
  ])
));

const domainNames = { GW: '铁路工务与基础设施', XH: '铁路通信信号与列车控制', GD: '铁路牵引供电与电气设备', CL: '铁路机车车辆与运用检修', YS: '铁路运输组织与安全管理' };
const mapRows = Object.entries(domainNames).map(([code, name]) => {
  const trial = pipeline.trials[code];
  return [code, name, trial?.dataset_id || '', 'f8123cce6b744a88bde9137a8fab0ed1', trial ? '已创建的隔离试验库' : '未创建', pipeline.pipeline_version_id || '', 'API访问已验证', '待完成结构与检索验收'];
});
await save('00-control/dataset-map.md', '# 领域知识库映射\n\n' + table(
  ['领域','目标名称','真实知识库 ID','所属空间','状态','管道发布版本','可访问性核验','待办'],
  mapRows
));
await save('00-control/import-register.md', '# 上传与解析登记\n\n' + table(
  ['doc_id','主领域','Markdown 路径','SHA-256','目标知识库 ID','系统文档 ID','版本','管道版本','结构复核','上传','解析','检索','备注'],
  [...baseline.docs, ...docs].map(d => {
    const trial = Object.values(pipeline.trials).find(t => t.source_id === d.source_id);
    return [d.doc_id, d.domain, d.master_path, d.sha256, trial?.dataset_id || '', trial?.document_id || '', '原文版本待逐项核验', trial ? pipeline.pipeline_version_id : '', d.status, trial ? '试验版已上传' : '待结构门槛', trial?.latest?.ingestion_status || '未执行', '未执行', d.exclusion_reason || ''];
  })
));

const pending = docs.filter(d => !d.count_as_valid).map(d => `- ${d.doc_id} ${d.title}：PDF文字层识别有误码；需人工对照完整页面或优先获得HTML原文后再计入。`);
await save('00-control/gap-register.md', `# 资料缺口与验收风险\n\n## 待复核原件\n${pending.join('\n') || '- 无'}\n\n## 已知覆盖缺口\n- 具体设备型号的现场检修步骤、校准按钮顺序、未提供线路/车型的技术阈值没有权威证据；检索应拒答。\n- 设备目录 S0013、S0015 的正文是图像表格，未完成全表逐项转录，不能计入有效文档或声称型号覆盖完整。\n- 来源页面采集成功不等于法规当前效力已逐项核验；带年份、修订和施行日期须随证据一起呈现。\n- 原库六篇逐篇补充检查和更新后的实时检索覆盖仍待验收。\n- 当前有效来源数量必须在正文、结构、实际切片和检索门槛通过后再确认；基线 N0=6，最低总量18、优先24。\n`);

const accepted = docs.filter(d => d.count_as_valid);
const counts = Object.fromEntries(Object.keys(domains).map(d => [d, accepted.filter(x => x.domain === d).length]));
await save('00-control/progress.md', `# 铁路知识库执行进度\n\n执行日期：2026-11-15（Asia/Shanghai）。用户授权按指导书01、02、03连续执行；指导书模板不作为实测。\n\n## 基线与来源\n- 原库：轨知 · 铁路公开规章，ID \`66ff4d9d5ff748af8e83080bd7482f04\`；原件6份，91个旧切片；冻结 F0=N0=S0=6，最低总量18、优先24。\n- 原库与6份原件保留。任务资料隔离在五个私人领域库。\n- 新增来源候选18份官方出版物：16份正文可读待结构验收，2份PDF待复核；图片设备目录另列缺口，不计数。\n- 当前仅为来源候选盘点：不能将“待结构验收”称为有效新增；门槛包括真实切片及检索验收。\n- 五领域候选正文分布：${Object.entries(counts).map(([d,n]) => `${d}=${n}`).join('，')}。\n\n## 已执行\n- 下载并哈希归档原库6份文件；冻结问答集60题。\n- 建立并验证五个隔离领域知识库及层级切片试验管道。\n- 抓取官方正文 S0007-S0009、S0011-S0012、S0014、S0016-S0017、S0020-S0027 中可读页面；采集附件并保留原件。\n- 修正 Markdown 整理：短条款号作标题，原条文正文放在正文，避免长标题与首行丢失。\n- S0005已删除历史第三十三条赔偿限额从整理稿检索内容中隔离；原件不改。\n\n## 当前阶段\n- 结构验收：进行中；PDF S0010/S0018 文字层乱码，未计有效数。\n- 试切：已完成旧结构试验，因发现标题和条文首行错误，必须重建五篇试验文档后复核。\n- 正式导入、60题检索、Wiki：未完成。\n\n## 下一步\n1. 重建隔离试验库内5份任务创建的试验文档，检查真实切片完整性。\n2. 结构通过后，每批不超过5份导入剩余来源文档。\n3. 导出所有实际切片，核对来源、编号、条件和文本覆盖。\n4. 完成冻结60题检索评估；只有通过才执行Wiki。\n`);
console.log(JSON.stringify({sources: sources.length, baseline: baseline.docs.length, candidates: docs.length, held: docs.length - accepted.length, domains: counts}, null, 2));
