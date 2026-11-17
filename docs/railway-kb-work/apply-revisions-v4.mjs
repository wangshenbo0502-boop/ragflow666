import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { articlesFrom, compact } from './reconstruct-v3.mjs';
import { hash, load, root, save, table } from './run.mjs';

const checkOnly = process.argv.includes('--check');
const reportPath = '05-review/revision-structure-v4.json';
const transcript = await load('05-review/S0031-amendment-transcript-v4.json');
const acquisition = await load('05-review/revision-source-acquisition-v4.json');
const documents = await load('00-control/document-register.json');
const sources = await load('00-control/source-register.json');
const selected = await load('00-control/selected-sources.json');
const definitions = [
  { doc_id: 'DOC0022', source_id: 'S0030', previous: 'S0025',
    version: '原交通运输部令2013年第13号；按2019年第3号决定修正，2019-02-03公布，2019-03-05施行',
    published: '2019-02-03', amended: '第二十条',
    basis: '国家铁路局官方网页所附2019年重新公布全文',
    boundary: '已核对2019年修正决定及重新公布全文；尚未完成截至2026-11-16的后续修订及现行效力终审，不能默认所有产品维修许可均为5年。' },
  { doc_id: 'DOC0023', source_id: 'S0031', previous: 'S0026',
    version: '原交通运输部令2015年第23号；按2018年第18号决定修正，2018-08-31公布，2018-10-01施行',
    published: '2018-08-31', amended: '第七条',
    basis: 'S0026原始全文，按S0031官方修正决定PDF第2页整体替换第七条；整理者合成本，不冒称官方合并全文',
    boundary: '已核对2018年官方修正决定PDF第1、2页；第七条两款完整替换，监造定义仍属第七条；截至2026-11-16的后续修订及现行效力待终审。' },
];

async function read(relative) { return readFile(path.join(root, relative)); }
async function preserve(relative) {
  const bytes = await read(relative);
  const target = `05-review/history/pre-revision-v4/${relative}`;
  try { await access(path.join(root, target)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; await save(target, bytes); }
  return target;
}
async function verify(report) {
  for (const snapshot of report.snapshots) {
    assert.equal(hash(await read(snapshot.history_path)), snapshot.sha256, snapshot.history_path);
  }
  for (const entry of report.documents) {
    const doc = (await load('00-control/document-register.json')).find(d => d.doc_id === entry.doc_id);
    const original = await read(entry.old_original_path);
    assert.equal(hash(original), entry.old_original_sha256, 'Original changed');
    assert.equal(hash(await read(doc.master_path)), entry.master_sha256);
    assert.equal(doc.sha256, entry.master_sha256);
    const expected = await load(entry.expected_path);
    assert.equal(expected.points.length, entry.knowledge_points);
    assert.deepEqual(expected.points.map(p => p.knowledge_point_id), entry.stable_knowledge_point_ids);
    for (const point of expected.points) {
      assert.equal(hash(point.text), point.expected_sha256);
      assert.ok(compact(point.body).includes(compact(point.source_body)), point.knowledge_point_id);
      assert.ok(point.text.includes(doc.version));
    }
    assert.equal(doc.revision_v4.remote_upload_status, '未上传');
  }
  assert.equal(hash(await read(transcript.source_path)), transcript.source_sha256);
  console.log(JSON.stringify({ mode: 'check', documents: report.documents.length,
    stable_points: report.documents.reduce((n, d) => n + d.knowledge_points, 0),
    history_snapshots: report.snapshots.length, passed: true, remote_mutation: false }));
}

let existing;
try { existing = await load(reportPath); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (checkOnly || existing) {
  assert.ok(existing, 'No completed local revision report');
  await verify(existing);
} else {
  assert.equal(hash(await read(transcript.source_path)), transcript.source_sha256);
  const generatedAt = new Date().toISOString();
  const report = { checked_at: generatedAt, scope: '两篇候选本地版本修复及逐条机器对照；非真实切片或检索验收',
    latest_effectiveness_verified: false, remote_mutation: false, snapshots: [], documents: [] };
  const controls = ['document-register.json', 'document-register.md', 'document-register-full.json',
    'source-register.json', 'source-register.md', 'selected-sources.json',
    'structure-register.json', 'structure-register.md', 'domain-register.md',
    'import-register.md', 'progress.md', 'final-acceptance.md'];
  for (const file of controls) {
    const relative = '00-control/' + file;
    const bytes = await read(relative);
    report.snapshots.push({ original_path: relative, history_path: await preserve(relative), sha256: hash(bytes) });
  }
  const revised = [];
  for (const definition of definitions) {
    const doc = documents.find(d => d.doc_id === definition.doc_id);
    assert.equal(doc.source_id, definition.previous);
    const evidence = acquisition.sources.find(s => s.source_id === definition.source_id);
    assert.ok(evidence);
    const raw = await read(evidence.original_path);
    assert.equal(hash(raw), evidence.sha256);
    const oldOriginal = await read(doc.original_path);
    const oldExpected = await load(doc.structure_v3.expected_path);
    for (const relative of [doc.master_path, doc.structure_v3.expected_path]) {
      const bytes = await read(relative);
      report.snapshots.push({ original_path: relative, history_path: await preserve(relative), sha256: hash(bytes) });
    }
    const oldArticles = articlesFrom(oldOriginal.toString('utf8'));
    let normalized;
    if (definition.doc_id === 'DOC0022') {
      normalized = raw.toString('utf8').split(/\n外部文件\s*$/u)[0].trim() + '\n';
    } else {
      const oldArticle = oldArticles.find(a => a.article === definition.amended);
      assert.ok(oldArticle);
      assert.equal(oldArticle.lines.length, 1);
      const before = oldOriginal.toString('utf8');
      const oldLine = before.split(/\r?\n/u).find(line => line.trim().startsWith('第七条 '));
      assert.ok(oldLine);
      const replacement = `第七条 ${transcript.replacement_paragraphs.join('\n\n')}`;
      normalized = before.replace(oldLine, replacement);
      assert.notEqual(normalized, before);
    }
    const articles = articlesFrom(normalized);
    assert.equal(articles.length, oldExpected.points.length);
    assert.deepEqual(articles.map(a => a.article), oldExpected.points.map(p => p.article));
    const changes = articles.flatMap(article => {
      const before = oldArticles.find(a => a.article === article.article);
      return compact(before.body) === compact(article.body) ? [] : [{ article: article.article,
        previous_body: before.body, revised_body: article.body,
        previous_sha256: hash(before.body), revised_sha256: hash(article.body) }];
    });
    assert.ok(changes.some(c => c.article === definition.amended));
    if (doc.doc_id === 'DOC0023') assert.deepEqual(changes.map(c => c.article), ['第七条']);
    const normalizedPath = `02-normalized/reviewed/${doc.doc_id}-v4.txt`;
    await save(normalizedPath, normalized);
    const points = oldExpected.points.map((point, index) => {
      const article = articles[index];
      let body = point.body;
      for (const change of changes) body = body.replaceAll(change.previous_body, change.revised_body);
      assert.ok(compact(body).includes(compact(article.body)), `${point.knowledge_point_id}: lost body`);
      const location = doc.doc_id === 'DOC0023'
        ? article.article === '第七条' ? 'S0031，官方修正决定PDF第2页，第七条完整两款'
          : `S0026，${article.chapter}，${article.article}；S0031修正决定未改此条`
        : `S0030，2019年重新公布全文，${article.chapter}，${article.article}`;
      const text = [`**证据定位：** ${point.knowledge_point_id}；${location}。`,
        `**来源版本与范围：** ${definition.version}；${doc.scope}`,
        `**效力核验边界：** ${definition.boundary}`, body].join('\n\n');
      return { ...point, source_ids: doc.doc_id === 'DOC0023' && article.article !== '第七条'
          ? [definition.previous, definition.source_id] : [definition.source_id],
        source_location: location, source_version: definition.version, source_path: normalizedPath,
        source_body: article.body, source_body_sha256: hash(article.body), body, text,
        object_and_conditions: article.lines[0], expected_sha256: hash(text), source_body_retained: true,
        treatment: '保留稳定知识点ID，按已核对官方修正来源修订，所有条款正文完整保留' };
    });
    const output = [`# ${doc.title}`, ''];
    let chapter;
    for (const point of points) {
      if (chapter !== point.heading_path[1]) { chapter = point.heading_path[1]; output.push(`## ${chapter}`, ''); }
      output.push(`### ${point.heading_path[2]}`, '', point.text, '');
    }
    output.push('## 来源与整理记录', '', '### 文档版本与原件索引', '',
      `文档 ID：${doc.doc_id}`, `主领域：${doc.domain}`, `来源 ID：${definition.source_id}`,
      `前版来源：${definition.previous}；原始快照及旧主副本保留，不新增文献计数。`,
      `来源版本：${definition.version}`, `适用范围：${doc.scope}`, `效力核验：${definition.boundary}`,
      `底本性质：${definition.basis}`, `正文核对底本：${normalizedPath}`,
      `官方来源：${evidence.url}`, `原件：${evidence.attachment_path || evidence.original_path}`,
      '整理日期：2026-11-16', '本节仅供追溯；不作为业务问答证据。', '');
    const markdown = output.join('\n');
    const expectedPath = `04-chunks/expected/${doc.doc_id}-v4.json`;
    await save(doc.master_path, markdown);
    await save(expectedPath, { doc_id: doc.doc_id, source_sha256: hash(normalized),
      master_sha256: hash(markdown), points, audit_scope: report.scope });
    const oldOriginalPath = doc.original_path;
    const oldStructure = doc.structure_v3;
    Object.assign(doc, { source_id: definition.source_id,
      previous_source_ids: [...new Set([...(doc.previous_source_ids || []), definition.previous])],
      original_path: evidence.original_path, normalized_path: normalizedPath,
      source_url: evidence.url, version: definition.version, version_verification: definition.boundary,
      source_characters: normalized.length, sha256: hash(markdown), status: '待复核',
      final_count_eligible: false, final_acceptance_status: '待复核',
      revision_v4: { at: generatedAt, expected_path: expectedPath, knowledge_points: points.length,
        previous_structure_v3: oldStructure, structure_automated_check: '通过',
        semantic_review: '待完成', remote_upload_status: '未上传', real_chunk_status: '未执行',
        prior_import_status: '旧版入库记录保留，不代表此修订版已入库',
        latest_effectiveness_verified: false, basis: definition.basis } });
    const previousSource = sources.find(s => s.source_id === definition.previous);
    assert.ok(previousSource);
    previousSource.related_current_source_ids = [...new Set([...(previousSource.related_current_source_ids || []), definition.source_id])];
    previousSource.relation = 'amended_by';
    previousSource.status = '已核实存在官方修正；历史原件完整保留，禁止单独当作修正后版本';
    const newSource = { source_id: definition.source_id, title: evidence.title,
      publisher: '交通运输部；国家铁路局公开', url: evidence.url,
      original_path: evidence.original_path, published: definition.published,
      version: definition.version, scope: doc.scope, domain: doc.domain,
      access_date: evidence.checked_at.slice(0, 10), sha256: evidence.sha256,
      status: definition.boundary, previous_source_ids: [definition.previous],
      relation: 'amends', count_as_additional_document: false,
      attachments: evidence.attachment_path ? [{ original_path: evidence.attachment_path,
        url: evidence.attachment_url, sha256: evidence.attachment_sha256 }] : [] };
    assert.ok(!sources.some(s => s.source_id === definition.source_id));
    sources.push(newSource);
    selected.push(newSource);
    const entry = { doc_id: doc.doc_id, source_id: doc.source_id, previous_source_id: definition.previous,
      old_original_path: oldOriginalPath, old_original_sha256: hash(oldOriginal),
      master_path: doc.master_path, master_sha256: doc.sha256, normalized_path: normalizedPath,
      expected_path: expectedPath, knowledge_points: points.length,
      stable_knowledge_point_ids: points.map(p => p.knowledge_point_id), changed_articles: changes,
      remote_upload_status: '未上传', latest_effectiveness_verified: false };
    report.documents.push(entry);
    revised.push(doc);
  }
  await save('00-control/document-register.json', documents);
  await save('00-control/source-register.json', sources.sort((a, b) => a.source_id.localeCompare(b.source_id)));
  await save('00-control/selected-sources.json', selected);
  const full = await load('00-control/document-register-full.json');
  for (const doc of revised) {
    for (const group of [full.baseline, full.expanded]) {
      const index = group.findIndex(d => d.doc_id === doc.doc_id);
      if (index !== -1) group[index] = { ...doc };
    }
    const check = full.validation.find(d => d.doc_id === doc.doc_id);
    Object.assign(check, { source_id: doc.source_id, previous_source_ids: doc.previous_source_ids,
      master_sha256: doc.sha256, original_path: doc.original_path,
      original_sha256: hash(await read(doc.original_path)),
      imported_version_note: '系统文档ID仍指旧版；v4候选未上传，不继承旧版解析核验结果',
      ingestion_status: '本地v4未上传', final_count_eligible: false,
      outstanding: ['现行效力终审', '语义及切片审查', '新版试切/入库', '检索及引用复测'] });
  }
  await save('00-control/document-register-full.json', full);
  const structure = await load('00-control/structure-register.json');
  for (const doc of revised) {
    Object.assign(structure.find(s => s.doc_id === doc.doc_id), { source_id: doc.source_id,
      source_url: doc.source_url, source_version: doc.version, content_sha256: doc.sha256,
      state: '待复核', expected_path: doc.revision_v4.expected_path,
      notes: 'v4本地修订候选；稳定知识点及正文机器对照通过，未试切/未上传' });
  }
  await save('00-control/structure-register.json', structure);
  for (const filename of ['document-register.md', 'domain-register.md', 'structure-register.md']) {
    let markdown = (await read('00-control/' + filename)).toString('utf8');
    for (const doc of revised) {
      markdown = markdown.split('\n').map(line => line.startsWith(`| ${doc.doc_id} |`)
        ? line.replaceAll(doc.previous_source_ids.at(-1), doc.source_id)
          .replaceAll('COMPLETED', '旧版COMPLETED；v4未上传')
          .replaceAll('通过；人工抽检待完成', 'v4正文自动对照通过；效力/语义/试切待验收') : line).join('\n');
    }
    markdown += '\n## v4修订候选边界\n\nDOC0022与DOC0023已按官方修正更新本地主副本；旧主副本与登记表已快照保留。v4尚未试切或上传，不继承旧系统文档的解析/检索验收。来源效力终审仍待完成。\n';
    await save('00-control/' + filename, markdown);
  }
  await save('00-control/source-register.md', '# 来源登记表\n\n来源载体和修正版本不增加文献计数；所有原件与历史关系保留。修正原文核对不等于现行效力终审。\n\n' +
    table(['source_id', '标题', '发布机构', '发布日期', '版本', '主领域', '原文地址', '原件路径', '访问日期', '核验状态', '前版/交叉来源', '当前关联来源', '关系'],
      sources.map(s => [s.source_id, s.title, s.publisher, s.published, s.version, s.domain, s.url,
        s.original_path, s.access_date, s.status, (s.previous_source_ids || []).join(','),
        (s.related_current_source_ids || []).join(','), s.relation || ''])));
  const importNote = '\n## v4待导入修订候选（2026-11-16）\n\n以下为新的本地内容，不是上表旧版的远端解析结果；未覆盖旧远端文件。须完成效力/语义复核及真实试切后才可上传。\n\n' +
    table(['doc_id', '来源', '主副本SHA-256', '预期切片', '上传', '真实解析', '检索'],
      revised.map(d => [d.doc_id, d.source_id, d.sha256, d.revision_v4.expected_path, '未执行', '未执行', '未执行']));
  await save('00-control/import-register.md', (await read('00-control/import-register.md')).toString('utf8') + importNote);
  const progressNote = `\n## 官方修正本地修复批次（${generatedAt}）\n\n` +
    '- DOC0022改用S0030官方2019年重新公布全文；DOC0023根据S0031官方PDF第2页整体修正第七条两款。\n' +
    '- 两篇共63个知识点ID保持不变；正文、依赖及来源位置已同步，修改前主副本、预期切片与登记表均已保存历史快照。\n' +
    '- 这是本地候选更新，尚未上传/真实试切；原库已导入的24篇、1,131切片仍是旧版既有记录，不冒充v4成绩。\n' +
    '- 来源现行效力终审仍未完成；下一步：逐条差异复核、效力核验、试切；通过后才能新增修订版入库。重排服务及独立检索/引用验收仍是未完成项。\n';
  for (const name of ['progress.md', 'final-acceptance.md']) {
    await save('00-control/' + name, (await read('00-control/' + name)).toString('utf8') + progressNote);
  }
  await save(reportPath, report);
  await verify(report);
}
