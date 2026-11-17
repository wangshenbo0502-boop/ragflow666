import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { articlesFrom, compact } from './reconstruct-v3.mjs';
import { hash, load, root, save } from './run.mjs';

const folder = '05-review/revision-current-official-2026-11-16T14-47-05-635Z';
const reportPath = '05-review/revision-structure-v5.json';
const read = relative => readFile(path.join(root, relative));
const evidence = await load(`${folder}/evidence.json`);
const documents = await load('00-control/document-register.json');
const definitions = [
  { doc_id: 'DOC0022', source_id: 'S0037', pages: 13,
    observations: [
      '标题、2013发布及2019修正说明；第一至二条适用对象。',
      '第三条四类许可与大修定义使用中文弯引号；第四至六条开头。',
      '第六条条件续页及后续许可条件，保留并列项。',
      '制造、维修条件连续列表，未见正文因换页丢失。',
      '维修条件续页及进口条件，保留不同许可对象。',
      '第十条申请材料及第十一条开头，材料列表跨页。',
      '第十一条（二）至（八）；第十二条（一）至（三）跨页。',
      '第十二条续页至（八）；第十三条（一）至（四）。',
      '第十三条（五）至（九）、第十四条及第四章第十五条开头。',
      '第十五条三种受理情形与5工作日；第十六条审查；第十七条20+10工作日及不计时事项。',
      '第十八条10工作日；第十九条标注；第二十条长期/5/5、8、10年与60工作日；第二十一条30工作日；第二十二条起段。',
      '第二十二条产品重大变化续段；第二十三至二十四条；第二十五条撤销情形前三项。',
      '第二十五条续项、欺骗贿赂及3年限制；第二十六条注销；第二十七至二十八条及原2014施行日期。',
    ] },
  { doc_id: 'DOC0023', source_id: 'S0038', pages: 10,
    observations: [
      '标题、2015发布及2018修正说明；第一至三条适用范围及缺陷定义。',
      '第四至六条；第七条第一款印为“相关产品”，两款跨页。',
      '第七条监造定义续页；第八至十一条及第十二条起段。',
      '缺陷调查条款；第十四条（三）以分号结束。',
      '第十六条调查报告列表；第十七条异议程序起段。',
      '第十七条技术检验续句；第十八条立即停止与运输秩序例外同条；第十九条计划（一）至（七）。',
      '第十九条（八）（九）续页；第二十至二十五条；第二十一条并且关系、第二十三条不少于5年。',
      '第二十六至二十九条监督、保密、投诉与不得阻挠；第三十条起段。',
      '第三十条冒号；第三十一条责令改正后分号及1～5%、5～8%、8～10%和吊销；第三十二条分号与冒号。',
      '第三十二条续项；第三十三条其他责任；第三十四条细则；第三十五条原2016施行日期。',
    ] },
];

async function verify(report) {
  for (const item of report.snapshots) assert.equal(hash(await read(item.history_path)), item.sha256);
  for (const item of report.documents) {
    const doc = (await load('00-control/document-register.json')).find(d => d.doc_id === item.doc_id);
    const expected = await load(item.expected_path);
    assert.equal(hash(await read(doc.master_path)), doc.sha256);
    assert.equal(doc.sha256, expected.master_sha256);
    assert.deepEqual(expected.points.map(p => p.knowledge_point_id), item.stable_knowledge_point_ids);
    for (const point of expected.points) {
      assert.equal(hash(point.text), point.expected_sha256);
      assert.equal(hash(point.source_body), point.source_body_sha256);
      assert.ok(compact(point.body).includes(compact(point.source_body)));
      for (const dependency of point.dependencies || []) {
        if (dependency.local && dependency.inline) {
          assert.ok(compact(point.body).includes(compact(
            expected.points.find(p => p.article === dependency.article).source_body)));
        }
      }
    }
  }
  console.log(JSON.stringify({ passed: true, documents: report.documents.length,
    points: report.documents.reduce((n, d) => n + d.stable_knowledge_point_ids.length, 0),
    remote_mutation: false, evidence_path: reportPath }));
}

let existing;
try { existing = await load(reportPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (existing) {
  await verify(existing);
} else {
  const at = new Date().toISOString();
  const report = { checked_at: at, source_evidence: `${folder}/evidence.json`,
    scope: '官方合并全文对照和已确认转录修正；保留旧版证据与稳定ID，不增加文献数',
    snapshots: [], documents: [], remote_mutation: false };
  const outputs = new Map();
  const sources = await load('00-control/source-register.json');
  const selected = await load('00-control/selected-sources.json');
  const full = await load('00-control/document-register-full.json');
  const structures = await load('00-control/structure-register.json');
  const boundary = '2026-11-16已在交通运输部现行有效规章目录定位同名同链接条目，核对所链官方合并全文及PDF；这是记录时点的官方目录证据，未穷尽所有后续公告。';
  const visuals = [];
  for (const definition of definitions) {
    const doc = documents.find(d => d.doc_id === definition.doc_id);
    const record = evidence.records.find(r => r.doc_id === doc.doc_id);
    assert.equal(hash(await read(doc.master_path)), record.master_sha256, 'Master changed since comparison');
    assert.ok(!sources.some(s => s.source_id === definition.source_id), 'Source ID already used');
    const previous = await load(doc.revision_v4.expected_path);
    assert.equal(hash(await read(doc.revision_v4.expected_path)), record.expected_sha256);
    const original = await read(record.body_path);
    const pdf = await read(record.attachments[0].snapshot_path);
    assert.equal(hash(original), record.body_sha256);
    assert.equal(hash(pdf), record.attachments[0].sha256);
    const sourceTextPath = `01-originals/web/${definition.source_id}.txt`;
    const sourceHTMLPath = `01-originals/web/${definition.source_id}.html`;
    const sourcePDFPath = `01-originals/attachments/${definition.source_id}-1.pdf`;
    for (const target of [sourceTextPath, sourceHTMLPath, sourcePDFPath]) {
      await assert.rejects(access(path.join(root, target)), { code: 'ENOENT' });
    }
    outputs.set(sourceTextPath, original);
    outputs.set(sourceHTMLPath, await read(record.official_page.snapshot_path));
    outputs.set(sourcePDFPath, pdf);
    const officialArticles = articlesFrom(original.toString('utf8'));
    assert.deepEqual(officialArticles.map(a => a.article), previous.points.map(p => p.article));
    const changed = [];
    const bodies = officialArticles.map((article, index) => {
      const old = previous.points[index];
      // The PDF uses curly quotes here; the website's straight quotes are typographic only.
      if (doc.doc_id === 'DOC0022' && old.article === '第三条') {
        assert.equal(compact(article.body).replaceAll('"', '“').replaceAll('”', '“'),
          compact(old.source_body).replaceAll('”', '“'));
        return old.source_body;
      }
      if (compact(article.body) !== compact(old.source_body)) {
        changed.push({ knowledge_point_id: old.knowledge_point_id, article: old.article,
          previous_body: old.source_body, corrected_body: article.body,
          decision: '官方合并HTML/PDF及修正决定原件核对；修正本地转录，不修改原件' });
      }
      return article.body;
    });
    assert.deepEqual(changed.map(c => c.knowledge_point_id), doc.doc_id === 'DOC0022'
      ? [] : ['DOC0023-K07', 'DOC0023-K14', 'DOC0023-K30', 'DOC0023-K31', 'DOC0023-K32']);
    const normalizedPath = `02-normalized/reviewed/${doc.doc_id}-v5.txt`;
    const normalized = `${doc.title}\n\n${record.official_version_statement}\n\n` +
      officialArticles.map((a, i) => `${i === 0 || a.chapter !== officialArticles[i - 1].chapter
        ? a.chapter + '\n\n' : ''}${a.article} ${bodies[i]}`).join('\n\n') + '\n';
    outputs.set(normalizedPath, normalized);
    const points = previous.points.map((old, index) => {
      let body = old.body.replaceAll(old.source_body, bodies[index]);
      for (const change of changed) body = body.replaceAll(change.previous_body, change.corrected_body);
      const location = `${definition.source_id}，交通运输部官方合并全文，${officialArticles[index].chapter}，${old.article}`;
      const text = [`**证据定位：** ${old.knowledge_point_id}；${location}。`,
        `**来源版本与范围：** ${doc.version}；${doc.scope}`,
        `**效力核验边界：** ${boundary}`, body].join('\n\n');
      assert.ok(compact(body).includes(compact(bodies[index])));
      return { ...old, source_ids: [definition.source_id], source_location: location,
        source_path: normalizedPath, source_body: bodies[index],
        source_body_sha256: hash(bodies[index]), body, text, expected_sha256: hash(text),
        object_and_conditions: bodies[index].split('\n')[0],
        treatment: '官方合并全文与PDF对照；保留稳定ID、完整条款及必要内联依赖；新增小标题属于整理标题' };
    });
    const markdown = [`# ${doc.title}`, '', ...points.flatMap((p, i) => [
      ...(i === 0 || p.heading_path[1] !== points[i - 1].heading_path[1]
        ? [`## ${p.heading_path[1]}`, ''] : []),
      `### ${p.heading_path[2]}`, '', p.text, '',
    ]), '## 来源与整理记录', '', '### 文档版本与原件索引', '',
    `文档 ID：${doc.doc_id}`, '主领域：CL', `来源 ID：${definition.source_id}`,
    `来源版本：${doc.version}`, `官方版本说明：${record.official_version_statement}`,
    `官方来源：${record.official_page.final_url}`, `官方PDF：${sourcePDFPath}`,
    `正文核对底本：${normalizedPath}`, `效力核验：${boundary}`,
    '原标题及条号保留；条号后的说明性标题由整理者添加。',
    '旧版主稿、原件、试切及审查证据保留；版本和载体不增加文献计数。',
    '本节仅供追溯；不作为业务问答证据。', ''].join('\n');
    assert.equal((markdown.match(/^# /gm) || []).length, 1);
    outputs.set(doc.master_path, markdown);
    const expectedPath = `04-chunks/expected/${doc.doc_id}-v5.json`;
    outputs.set(expectedPath, { doc_id: doc.doc_id, source_sha256: hash(normalized),
      master_sha256: hash(markdown), points, audit_scope: report.scope });
    const previousSource = doc.source_id;
    sources.find(s => s.source_id === previousSource).related_current_source_ids =
      [...new Set([...(sources.find(s => s.source_id === previousSource).related_current_source_ids || []),
        definition.source_id])];
    const source = { source_id: definition.source_id, title: doc.title, publisher: '交通运输部',
      url: record.official_page.final_url, original_path: sourceTextPath,
      html_path: sourceHTMLPath, sha256: hash(original), version: doc.version,
      published: doc.doc_id === 'DOC0022' ? '2019-02-03' : '2018-08-31',
      scope: doc.scope, domain: 'CL', access_date: '2026-11-16',
      status: boundary, current_catalog_verified: true,
      catalog_evidence_path: `${folder}/evidence.json`, previous_source_ids: [previousSource],
      relation: 'official_consolidation_of', count_as_additional_document: false,
      attachments: [{ original_path: sourcePDFPath, url: record.attachments[0].final_url,
        sha256: hash(pdf) }] };
    sources.push(source);
    selected.push(source);
    const pageRecords = [];
    for (let page = 1; page <= definition.pages; page++) {
      const imagePath = `${folder}/${doc.doc_id}-visual-${String(page).padStart(2, '0')}.png`;
      pageRecords.push({ page, image_path: imagePath, image_sha256: hash(await read(imagePath)),
        viewed: true, observation: definition.observations[page - 1] });
    }
    visuals.push({ doc_id: doc.doc_id, source_id: definition.source_id, pdf_path: sourcePDFPath,
      pdf_sha256: hash(pdf), pages: definition.pages, viewed_pages: pageRecords,
      method: '逐页查看官方PDF渲染图；先前续接已查看页复用，本批补齐其余11页；结合全文逐条差异清单核对',
      limitation: '完整页面视觉查看与条款转录核对；不是法律意见或所有后续公告穷尽核查' });
    Object.assign(doc, { source_id: definition.source_id, original_path: sourceTextPath,
      source_url: source.url, normalized_path: normalizedPath, sha256: hash(markdown),
      previous_source_ids: [...new Set([...(doc.previous_source_ids || []), previousSource])],
      version_verification: boundary, source_characters: normalized.length,
      status: '待复核', final_count_eligible: false, final_acceptance_status: '待复核',
      revision_v5: { at, expected_path: expectedPath, knowledge_points: points.length,
        structure_automated_check: '通过', semantic_review: '待完成',
        visual_review: '官方PDF全部页面已查看；五处差异已裁定',
        visual_evidence_path: '05-review/revision-visual-v5.json',
        current_catalog_verified: true, latest_effectiveness_verified: false,
        remote_upload_status: '未上传', real_chunk_status: '当前v5未执行；v4隔离证据仅适用旧输入',
        previous_trial_evidence: doc.revision_v4.current_trial?.evidence_path } });
    Object.assign(structures.find(s => s.doc_id === doc.doc_id), {
      source_id: doc.source_id, source_url: doc.source_url, source_version: doc.version,
      content_sha256: doc.sha256, expected_path: expectedPath, state: '待复核',
      notes: 'v5来源/视觉/全文对照完成；语义复核与当前版实际切片待完成；v4试切历史保留' });
    for (const group of [full.baseline, full.expanded]) {
      const index = group.findIndex(d => d.doc_id === doc.doc_id);
      if (index !== -1) group[index] = { ...doc };
    }
    Object.assign(full.validation.find(d => d.doc_id === doc.doc_id), {
      source_id: doc.source_id, previous_source_ids: doc.previous_source_ids,
      master_sha256: doc.sha256, original_path: sourceTextPath, original_sha256: hash(original),
      ingestion_status: 'v5未上传；v4隔离试切证据保留', final_count_eligible: false,
      outstanding: ['后续公告核查范围限制', 'v5语义审查', 'v5真实切片与正式入库', '检索引用验收'] });
    report.documents.push({ doc_id: doc.doc_id, source_id: doc.source_id,
      previous_source_id: previousSource, expected_path: expectedPath,
      master_path: doc.master_path, master_sha256: doc.sha256,
      stable_knowledge_point_ids: points.map(p => p.knowledge_point_id), changed_articles: changed,
      source_prefix_changed_points: points.length, historical_trial_invalidation: '输入哈希变化，v4结果仅作为历史证据' });
  }
  const oldTranscript = await load('05-review/S0031-amendment-transcript-v4.json');
  outputs.set('05-review/S0031-amendment-transcript-v5.json', { ...oldTranscript,
    replacement_paragraphs: oldTranscript.replacement_paragraphs.map(p =>
      p.replace('准确记录并保存有关产品', '准确记录并保存相关产品')),
    correction: { at, previous_path: '05-review/S0031-amendment-transcript-v4.json',
      reason: '对照2018修正决定第2页和官方合并PDF第2页，纠正有关产品为相关产品；历史转录记录保留' } });
  outputs.set('05-review/revision-visual-v5.json', { checked_at: at, records: visuals,
    all_pages_viewed: true, semantic_model_approval: false, formal_import: false });
  outputs.set('00-control/document-register.json', documents);
  outputs.set('00-control/source-register.json', sources);
  outputs.set('00-control/selected-sources.json', selected);
  outputs.set('00-control/document-register-full.json', full);
  outputs.set('00-control/structure-register.json', structures);
  for (const name of ['document-register.md', 'domain-register.md', 'structure-register.md']) {
    const relative = `00-control/${name}`;
    let content = (await read(relative)).toString('utf8');
    for (const result of report.documents) {
      const doc = documents.find(d => d.doc_id === result.doc_id);
      content = content.split('\n').map(line => {
        if (!line.startsWith(`| ${doc.doc_id} |`)) return line;
        if (name === 'structure-register.md') return `| ${doc.doc_id} | ${doc.source_id} | ${doc.title} | CL | ${doc.revision_v5.knowledge_points} | v5未上传；v4隔离历史保留 | 视觉及逐条差异核对完成；语义/实际切片待完成 |`;
        if (name === 'domain-register.md') return `| ${doc.doc_id} | ${doc.source_id} | ${doc.title} | CL | | 核心对象为机车车辆许可或铁路专用设备产品召回，正式CL目标映射保持。 | ${doc.original_path} | ${doc.master_path} | ${doc.version}；现行目录已定位，后续公告核查有界 | v5待语义复核及真实切片 |`;
        return line.replaceAll(result.previous_source_id, doc.source_id)
          .replaceAll(`01-originals/web/${doc.source_id}.txt`, doc.original_path)
          .replace('待结构验收', 'v5视觉及差异已核；待语义验收');
      }).join('\n');
    }
    content += '\n## v5当前状态（2026-11-16）\n\nDOC0022/23已改用交通运输部官方合并全文S0037/S0038，23页PDF全部查看；DOC0023五处转录差异已修正。v4隔离试切证据保留且仅适用旧哈希，v5待语义复核及真实切片；不继承历史正式入库或检索结论。\n';
    outputs.set(relative, content);
  }
  const sourceMarkdownPath = '00-control/source-register.md';
  outputs.set(sourceMarkdownPath, (await read(sourceMarkdownPath)).toString('utf8') +
    '\n## 官方合并全文补证（2026-11-16）\n\n' +
    report.documents.map(r => {
      const s = sources.find(s => s.source_id === r.source_id);
      return `- ${s.source_id}：${s.title}；${s.original_path}；PDF ${s.attachments[0].original_path}；官方目录证据已存档。与${r.previous_source_id}为同一文献不同载体/版本，不增加文献计数。`;
    }).join('\n') + '\n');
  for (const [relative] of outputs) {
    try {
      const bytes = await read(relative);
      const historyPath = `05-review/history/pre-revision-v5/${relative}`;
      await assert.rejects(access(path.join(root, historyPath)), { code: 'ENOENT' });
      await save(historyPath, bytes);
      report.snapshots.push({ original_path: relative, history_path: historyPath, sha256: hash(bytes) });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // All source and output assertions complete before replacing any current master or control.
  for (const [relative, data] of outputs) await save(relative, data);
  await save(reportPath, report);
  await verify(report);
}
