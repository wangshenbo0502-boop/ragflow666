import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, hash, load, originalDataset, root, rows, save } from './run.mjs';

export const compact = value => value.replace(/\s+/gu, '');
const rendered = value => compact(value.replace(/\*\*([^*]+)\*\*/gu, '$1').replaceAll('`', ''));
export function articlesFrom(text) {
  const result = [];
  let chapter = '条款正文';
  let current;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(?:相关(?:政策解读|解读|文件)|政策解读|相关阅读)[：:]/u.test(line)) break;
    if (/^《.*》解读\.docx?$/u.test(line)) break;
    if (result.length && /^附件[：:]/u.test(line)) break;
    if (/^第[一二三四五六七八九十百零〇两0-9]+章/u.test(line)) {
      chapter = line;
      current = undefined;
    } else if (/^第[一二三四五六七八九十百零〇两0-9]+节/u.test(line)) {
      current = undefined;
    } else {
      const found = line.match(/^(第[一二三四五六七八九十百零〇两0-9]+条)\s*(.*)$/u);
      if (found) {
        current = { article: found[1], chapter, lines: found[2] ? [found[2]] : [] };
        result.push(current);
      } else if (current) current.lines.push(line);
    }
  }
  return result.map(item => ({ ...item, body: item.lines.join('\n\n') }));
}

function titleOf(article) {
  const lead = article.lines[0] || article.article;
  const sentences = lead.split(/[。；：]/u).filter(Boolean);
  const first = sentences[0] || lead;
  if (first.length <= 52) return first;
  const clauses = first.split('，');
  return clauses.find(value => value.length >= 8 && value.length <= 52) || first;
}

async function build(doc) {
  if (!doc.count_as_valid) throw Error(`${doc.doc_id}: source gate: ${doc.exclusion_reason}`);
  const sourcePath = doc.normalized_path || doc.original_path;
  const source = await readFile(path.join(root, sourcePath), 'utf8');
  const articles = articlesFrom(source);
  if (articles.length !== doc.article_count || new Set(articles.map(a => a.article)).size !== articles.length) {
    throw Error(`${doc.doc_id}: article count or duplicate mismatch`);
  }
  const metadata = {
    DOC0006: ['国务院令第639号；2013-08-17公布，2014-01-01施行', '铁路建设、运输、设备制造维修及铁路沿线安全；专用铁路和铁路专用线依第一百零六条参照执行。'],
    DOC0007: ['2026-06-22公布，2026-09-01施行；原件正文未载令号', '境内新建、改建、扩建铁路建设工程安全生产及监督管理；消防、民爆、特种设备另有规定的从其规定。'],
    DOC0008: ['2026-06-22公布，2026-09-01施行；原件正文未载令号', '境内新建、改建、扩建铁路建设工程竣工验收及其监督管理。'],
    DOC0009: ['2025-06-03公布，2025-09-01施行；原件正文未载令号', '境内铁路建设工程勘察、设计活动及其监督管理。'],
    DOC0011: ['原件第四十一条载明自2021-10-01施行；正文未载公布令号', '铁路无线电频率、台站及无线电发射设备的研制、生产、进口、销售和维修。'],
    DOC0012: ['交通运输部令2023年第20号；2023-12-17公布，2024-02-01施行', '铁路关键信息基础设施安全保护和监督管理；定义见第二条。'],
    DOC0013: ['国家铁路局2021-09-30印发，2021-12-01施行；原件未载发文字号', '国家铁路和地方铁路营业线施工安全管理，包含邻近营业线施工。'],
    DOC0015: ['原交通运输部令2013年第21号，按2021年第32号决定修正；修正决定2021-11-19公布并施行', '铁路道岔及转辙、信号控制软件和控制、通信、牵引供电设备生产企业审批；目录由国家铁路局制定调整公布。'],
    DOC0017: ['2024-08-02公布，2024-12-01施行；原件正文未载令号', '境内铁路线上承担运输或施工、维修、检测、试验任务的机车车辆驾驶人员资格许可；过境及境外人员按第二条另行规定。'],
    DOC0018: ['国家铁路局2022-04-07印发，2022-05-01施行；须结合2024年资格许可办法核验', '铁路机车车辆驾驶人员资格考试管理；本片保留2022年文件，现行资格条件不得遗漏后续版本例外。'],
    DOC0019: ['2026-02-03公布，2026-05-01施行；原件正文未载令号', '中华人民共和国境内铁路货物运输。'],
    DOC0020: ['原件第三十七条载明自2023-07-01施行；正文未载发文字号', '境内铁路运输服务及其质量监督管理。'],
    DOC0021: ['交通运输部令2022年第24号；2022-09-26公布，2022-12-01施行', '铁路危险货物运输安全及监督管理；危险货物界定及特殊边界以第二条、第四十九条、第五十条为准。'],
    DOC0022: ['交通运输部令2013年第13号；2013-12-24公布，2014-01-01施行；存档版本，后续修订待核验', '铁路机车车辆设计、制造、维修和进口许可；对象包括第二条规定的车辆与自轮运转特种设备。'],
    DOC0023: ['交通运输部令2015年第23号；2015-11-19公布，2016-01-01施行', '依法实行行政许可的铁路专用设备缺陷产品召回及监督管理；其他直接影响运输安全产品依第二条处理。'],
    DOC0024: ['2020-05-06公布，2020-07-01施行；原件正文未载令号', '设计开行时速250公里以上（含预留）且初期运营时速200公里以上的客运列车专线铁路安全防护。'],
  }[doc.doc_id];
  if (metadata) [doc.version, doc.scope] = metadata;
  const old = await readFile(path.join(root, doc.master_path), 'utf8');
  await save(`05-review/history/${doc.doc_id}-${hash(old).slice(0, 16)}.md`, old);
  const points = [];
  const output = [`# ${doc.title}`, ''];
  let chapter;
  for (const [index, article] of articles.entries()) {
    if (chapter !== article.chapter) {
      chapter = article.chapter;
      output.push(`## ${chapter}`, '');
    }
    const id = `${doc.doc_id}-K${String(index + 1).padStart(2, '0')}`;
    let body = article.body;
    let treatment = '逐字保留正文，仅规范空白';
    if (doc.doc_id === 'DOC0014' && article.article === '第十五条') {
      body = body.replaceAll('TXJC####—*****', '`TXJC####—*****`')
        .replaceAll('“*****”', '“`*****`”');
      treatment = '许可证编号与占位符使用行内代码保护，避免星号被Markdown解释为强调符号';
    }
    let dependencies = [...new Set([...body.matchAll(/第[一二三四五六七八九十百零〇两0-9]+条/gu)].map(m => m[0]))]
      .filter(value => value !== article.article)
      .map(value => ({ article: value, local: articles.some(a => a.article === value),
        resolution: '原文交叉引用；不推断外部法律内容' }));
    if (doc.doc_id === 'DOC0005' && article.article === '第三十三条') {
      body = '**历史条文隔离：** 原件第三十三条带有2012年11月9日删除标记。本知识点仅说明该条已删除，不提供现行赔偿限额。历史文字完整保存在原件中。\n\n**适用边界：** 不得将已删除条款的历史金额用于现行赔偿判断；现行责任及金额须核验正式适用法律。';
      treatment = '带删除标记的历史金额隔离，原件保留，不冒充现行正文';
      dependencies = [];
    }
    if (doc.doc_id === 'DOC0005' && index >= 8 && index <= 11) {
      const definition = articles.find(a => a.article === '第十三条');
      body += `\n\n**边界依赖（第十三条原文）：** ${definition.body}`;
      dependencies.push({ article: '第十三条', local: true, inline: true });
    }
    if (doc.doc_id === 'DOC0016' && /日/u.test(body) && article.article !== '第五十三条') {
      const definition = articles.find(a => a.article === '第五十三条');
      body += `\n\n**期限依赖（第五十三条原文）：** ${definition.body}`;
      dependencies.push({ article: '第五十三条', local: true, inline: true });
    }
    const required = {
      DOC0004: { 第二十九条: ['第二十七条'], 第四十三条: ['第三十一条'] },
      DOC0005: { 第二十七条: ['第二十八条'] },
      DOC0008: { 第十三条: ['第十二条'], 第十六条: ['第十五条'],
        第十九条: ['第十八条'], 第二十二条: ['第二十一条'] },
      DOC0009: { 第二条: ['第五十五条'] },
      DOC0013: { 第二十一条: ['第十九条'] },
      DOC0015: { 第三条: ['第二条'], 第六条: ['第二条'], 第十一条: ['第九条'] },
      DOC0017: { 第十三条: ['第六条', '第七条'], 第十七条: ['第十四条'],
        第三十条: ['第四条'] },
      DOC0021: { 第二条: ['第四十九条'], 第三条: ['第五十条'],
        第四十五条: ['第三条', '第五十条'] },
      DOC0022: { 第三条: ['第二条'], 第二十一条: ['第二十二条'],
        第二十二条: ['第二十一条'] },
      DOC0023: { 第二十一条: ['第十七条'] },
    }[doc.doc_id]?.[article.article] || [];
    if (doc.doc_id === 'DOC0019' && /日/u.test(body) && article.article !== '第五十五条') {
      required.push('第五十五条');
    }
    if (doc.doc_id === 'DOC0024' && article.article !== '第二条') required.push('第二条');
    if (doc.doc_id === 'DOC0006' && /高速铁路/u.test(body) && article.article !== '第一百零七条') {
      required.push('第一百零七条');
    }
    for (const reference of required) {
      const dependency = articles.find(item => item.article === reference);
      if (!dependency) throw Error(`${doc.doc_id}: missing necessary condition ${reference}`);
      body += `\n\n**必要依赖（${reference}原文）：** ${dependency.body}`;
      dependencies.push({ article: reference, local: true, inline: true });
    }
    if (doc.doc_id === 'DOC0006' && article.article === '第十五条') {
      const acceptance = (await load('00-control/document-register.json')).find(d => d.doc_id === 'DOC0008');
      const source = await readFile(path.join(root, acceptance.normalized_path || acceptance.original_path), 'utf8');
      const definition = articlesFrom(source).find(a => a.article === '第五条');
      if (!definition) throw Error('Missing staged acceptance dependency');
      body += `\n\n**阶段依赖（${acceptance.source_id}，《${acceptance.title}》，${acceptance.version}，第五条原文）：** ${definition.body}`;
      body += '\n\n**整理者提示：** 上述原文区分初步验收后的初期运营和正式验收后的正式运营；不得将所有验收统一改写成必须在运营安全评估之前完成。';
      dependencies.push({ source_id: acceptance.source_id, article: '第五条', local: false, inline: true });
    }
    if (doc.doc_id === 'DOC0005' && article.article === '第三十五条') {
      body += '\n\n**版本边界：** 本存档第三十三条已标记于2012年11月9日删除，不能据本条交叉引用恢复其历史赔偿限额。第三十四条针对承运货物、包裹、行李损失；本条其余赔偿须核验适用法律。';
    }
    const sourceLocation = `${doc.source_id}，${article.chapter}，${article.article}`;
    const editedTitle = {
      DOC0001: { 第十二条: '生产企业质量保证期内许可产品事故季度报告',
        第十五条: '铁路设备使用和维修技术规则的制定与更新',
        第二十一条: '运输企业质量安全信息闭环管理及事故隐患报告' },
      DOC0006: { 第十五条: '竣工验收、运营安全评估及分阶段运营',
        第三十条: '线路安全保护区施工同意、安全协议与现场监督',
        第七十五条: '持续供电、供电质量与中断抢修责任' },
      DOC0008: { 第五条: '初步验收、安全评估、初期运营与正式运营的阶段关系' },
      DOC0015: { 第三条: '境内铁路运输基础设备生产企业的取证义务',
        第六条: '基础设备生产许可申请材料更正、补正及受理',
        第十一条: '生产许可证有效期、延续申请及许可决定期限' },
    }[doc.doc_id]?.[article.article];
    const heading = `${article.article}｜${editedTitle || titleOf(article)}`;
    const prefix = `**证据定位：** ${id}；${sourceLocation}。`;
    let version = doc.doc_id === 'DOC0016'
      ? '**版本边界：** 国铁设备监规〔2026〕3号，自2026年3月15日起施行，替代2023年版。'
      : '';
    if (doc.doc_id === 'DOC0018') {
      version = '**版本边界：** 本片保留2022年考试管理文件原文。驾驶资格条件须结合2024年《铁路机车车辆驾驶人员资格许可办法》（S0020）核验，不能将本片概括为全部车型均适用的最新资格条件。';
      if (article.article === '第十五条') {
        const current = articlesFrom(await readFile(path.join(root, '01-originals/web/S0020.txt'), 'utf8'));
        const rule = current.find(a => a.article === '第十三条');
        if (!rule) throw Error('Missing 2024 eligibility article');
        body += `\n\n**后续版本对照（S0020，2024年资格许可办法第十三条原文）：** ${rule.body}\n\n**使用边界：** 2024年资格许可办法第十三条第二项规定Z1、Z2类不进行铁路机车车辆驾驶适应性测试；回答现行资格问题时不得仅引用上方2022年考试文件而遗漏该例外。`;
        dependencies.push({ source_id: 'S0020', article: '第十三条', local: false, inline: true });
      }
    }
    if (doc.doc_id === 'DOC0022') {
      version = '**版本边界：** 本片为2013年《铁路机车车辆设计制造维修进口许可办法》存档原文，尚未证明截至2026年11月16日无后续修订；具体许可须核验适用版本。';
    }
    const provenance = `**来源版本与范围：** ${doc.version}；${doc.scope}\n\n**效力核验边界：** ${doc.version_verification || '依存档原文整理，尚未证明截至2026年11月16日无后续修订；具体使用须核验适用版本。'}`;
    const text = [prefix, provenance, version, body].filter(Boolean).join('\n\n');
    output.push(`### ${heading}`, '', text, '');
    points.push({
      doc_id: doc.doc_id, knowledge_point_id: id, domain_code: doc.domain,
      article: article.article, heading_path: [doc.title, article.chapter, heading],
      source_ids: [...new Set([doc.source_id, ...dependencies.map(d => d.source_id).filter(Boolean)])], source_location: sourceLocation,
      source_version: doc.version, source_path: sourcePath,
      question: `${titleOf(article)}的规定、条件与例外是什么？`,
      object_and_conditions: article.lines[0],
      source_body: article.body, source_body_sha256: hash(article.body),
      body, text, expected_sha256: hash(text), dependencies, treatment,
      source_body_retained: treatment.startsWith('逐字') ? compact(body).includes(compact(article.body)) : null
    });
  }
  if (doc.doc_id === 'DOC0014') {
    const annexes = await load('05-review/DOC0014-annex-review.json');
    for (const annex of annexes.knowledge_points || []) {
      const text = `${annex.text}\n\n**来源版本与范围：** ${doc.version}；${doc.scope}\n\n**效力核验边界：** ${doc.version_verification || '依存档原件核对；具体使用须核验适用版本。'}`;
      output.push(`## ${annex.group}`, '', `### ${annex.heading}`, '', text, '');
      points.push({ ...annex, doc_id: doc.doc_id, domain_code: doc.domain,
        source_ids: [doc.source_id], source_version: doc.version,
        source_body: annex.text, source_body_sha256: hash(annex.text),
        body: annex.text, text, expected_sha256: hash(text),
        source_body_retained: true, dependencies: [], treatment: '视觉核对后转写或保留原表定位' });
    }
  }
  output.push('## 来源与整理记录', '', '### 文档版本与原件索引', '',
    `文档 ID：${doc.doc_id}`, `主领域：${doc.domain}`, `来源 ID：${doc.source_id}`,
    '资料性质：官方原文结构整理；检索小标题为编辑辅助文字。',
    `来源版本：${doc.version}`, `适用范围：${doc.scope}`,
    `效力核验：${doc.version_verification || '按存档原件整理；尚不能证明不存在后续修订。使用时须核验适用版本。'}`,
    `原件：${doc.original_path}`, `正文核对底本：${sourcePath}`, `官方来源：${doc.source_url}`,
    '整理日期：2026-11-16', '本节仅供追溯；不作为业务问答证据。', '');
  const markdown = output.join('\n');
  if (points.some(p => p.source_body_retained === false)) throw Error(`${doc.doc_id}: body dropped`);
  await save(doc.master_path, markdown);
  doc.sha256 = hash(markdown);
  doc.structure_v3 = { at: new Date().toISOString(), knowledge_points: points.length,
    expected_path: `04-chunks/expected/${doc.doc_id}-v3.json`, source_path: sourcePath };
  await save(doc.structure_v3.expected_path, { doc_id: doc.doc_id, source_sha256: hash(source),
    master_sha256: doc.sha256, points });
  console.log(JSON.stringify({ doc_id: doc.doc_id, stage: 'structure', points: points.length }));
}

async function allDocuments(dataset) {
  const result = [];
  for (let page = 1; ; page++) {
    const next = rows(await api(`/datasets/${dataset}/documents?page=${page}&page_size=100`));
    result.push(...next);
    if (next.length < 100) return result;
  }
}

async function upload(doc, dataset, phase, pipeline, ledger) {
  let record = ledger.documents.find(d => d.doc_id === doc.doc_id && d.sha256 === doc.sha256 && d.phase === phase);
  if (!record) {
    const filename = `${path.basename(doc.master_path, '.md')}_精修_${doc.sha256.slice(0, 12)}.md`;
    const found = (await allDocuments(dataset)).filter(d => d.name === filename);
    if (found.length > 1) throw Error(`${filename}: duplicate remote uploads`);
    let remote = found[0];
    if (!remote) {
      const content = await readFile(path.join(root, doc.master_path));
      if (hash(content) !== doc.sha256) throw Error('Master changed after structural audit');
      const form = new FormData();
      form.append('file', new Blob([content], { type: 'text/markdown' }), filename);
      remote = rows(await api(`/datasets/${dataset}/documents`, 'POST', form)).find(d => d.name === filename);
    }
    if (!remote?.id) throw Error(`Upload missing ${filename}`);
    record = { doc_id: doc.doc_id, source_id: doc.source_id, domain: doc.domain, phase,
      dataset_id: dataset, document_id: remote.id, filename, sha256: doc.sha256,
      pipeline_id: pipeline.pipeline_id, pipeline_version_id: pipeline.pipeline_version_id,
      status: 'uploaded', uploaded_at: new Date().toISOString() };
    ledger.documents.push(record);
    await save('00-control/revision-v3-ledger.json', ledger);
  }
  if (record.status === 'uploaded') {
    await api(`/datasets/${dataset}/documents/${record.document_id}`, 'PATCH', {
      parse_type: 2, pipeline_id: pipeline.pipeline_id, pipeline_version_id: pipeline.pipeline_version_id
    });
    const downloaded = Buffer.from(await (await api(`/datasets/${dataset}/documents/${record.document_id}`, 'GET', undefined, true)).arrayBuffer());
    if (hash(downloaded) !== doc.sha256) throw Error(`${doc.doc_id}: remote original hash mismatch`);
    await api(`/datasets/${dataset}/documents/parse`, 'POST', { document_ids: [record.document_id] });
    record.status = 'parse-requested';
    await save('00-control/revision-v3-ledger.json', ledger);
  }
  return record;
}

async function verify(doc, record) {
  const remote = (await allDocuments(record.dataset_id)).find(d => d.id === record.document_id);
  if (!remote) throw Error('Remote document not found');
  if (remote.ingestion_status !== 'COMPLETED') {
    console.log(JSON.stringify({ doc_id: doc.doc_id, phase: record.phase, status: remote.ingestion_status }));
    if (/FAIL|ERROR|CANCEL/u.test(remote.ingestion_status)) throw Error(`${doc.doc_id}: ${remote.ingestion_status}`);
    return false;
  }
  const chunks = [];
  for (let page = 1; ; page++) {
    const next = rows(await api(`/datasets/${record.dataset_id}/documents/${record.document_id}/chunks?page=${page}&page_size=100`));
    chunks.push(...next);
    if (next.length < 100) break;
  }
  if (chunks.length !== Number(remote.chunk_count)) throw Error('Chunk export count mismatch');
  const expected = await load(doc.structure_v3.expected_path);
  const checks = expected.points.map(point => {
    const identifier = new RegExp(`${point.knowledge_point_id}(?![0-9A-Za-z])`, 'u');
    const matching = chunks.filter(c => identifier.test(String(c.content || c.content_with_weight || '')));
    const complete = matching.filter(c => rendered(c.content || c.content_with_weight || '').includes(rendered(point.text)));
    return { knowledge_point_id: point.knowledge_point_id, article: point.article,
      expected_sha256: point.expected_sha256, matching_chunk_ids: matching.map(c => c.id),
      complete_chunk_ids: complete.map(c => c.id), passed: matching.length === 1 && complete.length === 1 };
  });
  const metadata = chunks.filter(c => String(c.content || c.content_with_weight || '').includes('本节仅供追溯'));
  const pollution = chunks.filter(c => !metadata.includes(c) && /文档 ID：|资料性质：|正文核对底本：/u.test(c.content || c.content_with_weight || ''));
  const passed = checks.every(c => c.passed) && pollution.length === 0 && metadata.length === 1 &&
    chunks.length === expected.points.length + 1;
  const report = { ...record, checked_at: new Date().toISOString(), ingestion_status: remote.ingestion_status,
    exported_count: chunks.length, expected_points: expected.points.length,
    full_body_passed: checks.filter(c => c.passed).length, passed,
    checks, metadata_chunk_ids: metadata.map(c => c.id), polluted_chunk_ids: pollution.map(c => c.id), chunks,
    validation_scope: '全量正文和知识点边界自动比对；不冒充全量人工语义核验。模型token预算另行验证。' };
  await save(`04-chunks/actual/${doc.doc_id}-v3-${record.phase}.json`, report);
  if (!passed) throw Error(`${doc.doc_id}: full-body validation failed ${checks.filter(c => !c.passed).map(c => c.knowledge_point_id).join(',')}; pollution=${pollution.length}; chunks=${chunks.length}`);
  for (const chunk of metadata) {
    await api(`/datasets/${record.dataset_id}/documents/${record.document_id}/chunks/${chunk.id}`, 'PATCH', { available: false });
  }
  record.status = 'full-body-verified';
  record.chunk_count = chunks.length;
  record.business_chunks = expected.points.length;
  record.verified_at = report.checked_at;
  return true;
}

async function main() {
const requested = process.argv.slice(3).map(id => `DOC${String(Number(id.replace(/^DOC/iu, ''))).padStart(4, '0')}`);
const command = process.argv[2];
if (requested.length < 1 || requested.length > 5 || new Set(requested).size !== requested.length) {
  throw Error('Use one to five distinct document IDs per batch');
}
const register = await load('00-control/document-register.json');
const selected = requested.map(id => {
  const doc = register.find(d => d.doc_id === id);
  if (!doc) throw Error(`Missing ${id}`);
  return doc;
});
const pipeline = await load('00-control/domain-pipeline.json');
const ledger = await load('00-control/revision-v3-ledger.json').catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return { created_at: new Date().toISOString(), original_dataset_id: originalDataset, documents: [] };
});
for (const doc of selected) {
  if (command === 'build') {
    await build(doc);
    await save('00-control/document-register.json', register);
    continue;
  }
  if (!doc.structure_v3) throw Error(`${doc.doc_id}: no structural audit`);
  const phase = command.includes('trial') ? 'trial' : 'formal';
  if (phase === 'formal') {
    const trial = ledger.documents.find(d => d.doc_id === doc.doc_id && d.phase === 'trial' &&
      d.sha256 === doc.sha256 && d.status === 'full-body-verified');
    if (!trial) throw Error(`${doc.doc_id}: trial gate not passed`);
  }
  const dataset = phase === 'trial' ? pipeline.trials[doc.domain].dataset_id : originalDataset;
  if (command.startsWith('upload-')) await upload(doc, dataset, phase, pipeline, ledger);
  else if (command.startsWith('verify-')) {
    const record = ledger.documents.find(d => d.doc_id === doc.doc_id && d.phase === phase && d.sha256 === doc.sha256);
    if (!record) throw Error(`${doc.doc_id}: no uploaded edition`);
    const passed = await verify(doc, record);
    if (passed && phase === 'formal') {
      const previous = (await allDocuments(originalDataset)).filter(d =>
        d.id !== record.document_id && d.name.startsWith(`${doc.doc_id}_`) && d.status === '1');
      record.superseded = record.superseded || [];
      for (const old of previous) {
        await api(`/datasets/${originalDataset}/documents/batch-update-status`, 'POST', {
          status: '0', doc_ids: [old.id]
        });
        const reread = (await allDocuments(originalDataset)).find(d => d.id === old.id);
        if (reread?.status !== '0') throw Error(`${old.id}: archive status did not persist`);
        if (!record.superseded.some(d => d.document_id === old.id)) {
          record.superseded.push({ document_id: old.id, name: old.name, retained: true, status: '0' });
        }
      }
      console.log(JSON.stringify({ doc_id: doc.doc_id, phase, status: record.status,
        business_chunks: record.business_chunks, retained_previous: previous.length }));
    }
  } else throw Error(`Unknown command: ${command}`);
  await save('00-control/revision-v3-ledger.json', ledger);
}
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
