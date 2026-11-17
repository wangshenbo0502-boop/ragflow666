import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { root, load, save, hash } from './run.mjs';

const register = await load('00-control/document-register.json');
const requestedIDs = process.argv.slice(2).map(value => Number(value.replace(/^DOC/i, '')));
const selected = register.filter(doc => requestedIDs.length
  ? requestedIDs.includes(Number(doc.doc_id.slice(3)))
  : Number(doc.source_id.slice(1)) <= 5);
const metadata = {
  S0001: {
    version: '交通运输部令2023年第7号；2023-07-26公布，2023-09-01施行',
    scope: '铁路设备质量安全监督管理；不包含设备检修作业规程。'
  },
  S0002: {
    version: '原件末条载明自2023-01-01施行；原件未载公布令号',
    scope: '铁路旅客车票实名购买、查验及相关管理。'
  },
  S0003: {
    version: '交通运输部令2023年第21号；2023-12-17公布，2024-02-01施行',
    scope: '铁路旅客运输安全检查工作。'
  },
  S0004: {
    version: '原件末条载明自2023-01-01施行；原件未载公布令号',
    scope: '铁路旅客运输活动；具体运输服务规则需结合相应规定核验。'
  },
  S0005: {
    version: '国务院令第501号，2007-07-11公布；按2012-11-09修订文本整理',
    scope: '铁路交通事故应急救援和调查处理；效力及后续修订待核验。'
  }
};

function normalize(line) {
  return line.replace(/^[\s　]+/, '').trim();
}

function extractArticles(source) {
  const lines = source.split(/\r?\n/).map(normalize).filter(Boolean);
  const chapters = [];
  const articles = [];
  let chapter = '';
  let current = null;
  for (const line of lines) {
    const chapterMatch = line.match(/^(第[一二三四五六七八九十百零〇两0-9]+章.*)$/);
    if (chapterMatch) {
      if (current) articles.push(current);
      current = null;
      chapter = chapterMatch[1];
      chapters.push(chapter);
      continue;
    }
    const articleMatch = line.match(/^(第[一二三四五六七八九十百零〇两0-9]+条)[\s　]*(.*)$/);
    if (articleMatch) {
      if (current) articles.push(current);
      current = { number: articleMatch[1], chapter, lines: [] };
      if (articleMatch[2]) current.lines.push(articleMatch[2]);
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) articles.push(current);
  return articles;
}

function articleTitle(article) {
  const lead = article.lines.find(line => !/^[（(][一二三四五六七八九十0-9]+[）)、]/.test(line)) || article.lines[0] || '';
  const text = lead
    .replace(/^[（(]?[一二三四五六七八九十0-9]+[）)、]\s*/, '')
    .replace(/^(有下列情形之一的，|有下列情形之一的，)?/, '')
    .split(/[。；;，,：:]/, 1)[0]
    .replace(/[：:，,、\s]+$/, '');
  return [...text].length <= 32 ? text || '条文规定' : '完整条文规定';
}

function formatBody(article, sourceID) {
  const body = article.lines.join('\n\n');
  if (sourceID === 'S0005' && article.number === '第三十三条') {
    return [
      '**历史条文隔离：** 原件第三十三条含旅客人身伤亡及自带行李赔偿限额文字，并标注相关内容于2012年11月9日删除。',
      '',
      '**检索边界：** 本条不提供现行赔偿限额，不得将原件历史数字作为现行标准。判断现行赔偿责任须另行核验正式有效法律文本。',
      '',
      '**原件定位：** S0005，第三十三条；原始文字仅保存在不可变原件中。'
    ].join('\n');
  }
  let result = body;
  if (sourceID === 'S0005' && ['第九条', '第十条', '第十一条', '第十二条'].includes(article.number)) {
    result += '\n\n**边界解释（第十三条）：** 本章所称“以上”包括本数，“以下”不包括本数。该定义用于理解本条所列事故等级阈值。';
  }
  if (sourceID === 'S0005' && article.number === '第十六条') {
    result += '';
  }
  return result;
}

for (const doc of selected) {
  const source = await readFile(path.join(root, doc.original_path), 'utf8');
  const articles = extractArticles(source);
  if (articles.length !== doc.article_count) {
    throw new Error(`${doc.doc_id}: extracted ${articles.length} articles, expected ${doc.article_count}`);
  }
  const meta = metadata[doc.source_id] || {
    version: '按原件载明的公布、印发、修订及施行信息整理；未在本地原件中确认的事项不补写',
    scope: '适用对象和范围以原文规定为准；不外推至原文未涵盖的对象或场景。'
  };
  const lines = [
    `# ${doc.title}`,
    '',
    `文档 ID：${doc.doc_id}`,
    `主领域：${doc.domain}`,
    `来源 ID：${doc.source_id}`,
    '资料性质：官方规章原文结构化整理',
    `来源版本：${meta.version}`,
    `适用范围：${meta.scope}`,
    '效力状态：仅按本地存档原文整理；截至整理日的现行效力及后续修订未完成核验。',
    `原件：${doc.original_path}`,
    `来源：${doc.source_url}`,
    '整理日期：2026-11-15',
    '',
    '## 文档范围',
    '',
    `按存档原文保留条款顺序、条号、条件、否定、例外、数值和流程依赖。条款标题为检索辅助标题，正文仍以原文为准；本文不补造原文未载的现场操作要求。`,
    '',
  ];
  let previousChapter = '';
  const auditArticles = [];
  for (const article of articles) {
    if (article.chapter && article.chapter !== previousChapter) {
      lines.push(`## ${article.chapter}`, '');
      previousChapter = article.chapter;
    }
    const body = formatBody(article, doc.source_id);
    lines.push(
      `### ${article.number}｜${articleTitle(article)}`,
      '',
      `**原文定位：** ${doc.source_id}，《${doc.title}》，${article.chapter ? `${article.chapter}，` : ''}${article.number}。`,
      '',
      body,
      ''
    );
    auditArticles.push({
      article: article.number,
      chapter: article.chapter,
      source_sha256: hash(article.lines.join('\n\n')),
      output_sha256: hash(body),
      source_characters: [...article.lines.join('\n\n')].length,
      output_characters: [...body].length
    });
  }
  const output = `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
  await save(doc.master_path, output);
  doc.sha256 = hash(output);
  doc.status = doc.source_id === 'S0005' ? '待条款语义复核' : '待结构验收';
  doc.reconstruction_date = '2026-11-15';
  doc.version = meta.version;
  doc.scope = meta.scope;
  doc.note = doc.source_id === 'S0005'
    ? '第9-12条加入第13条原文边界解释；第16条保留完整报告项目及补报要求；第24条保留现场变更记录与证据禁止事项；第33条历史限额隔离；第35条历史引用待核验。'
    : '逐条按存档原文整理，条款正文机器覆盖审计通过后仍需人工抽核数值、否定、例外和跨条依赖。';
  await save(`04-chunks/expected/${doc.doc_id}-article-audit.json`, {
    doc_id: doc.doc_id,
    source_id: doc.source_id,
    source_path: doc.original_path,
    output_path: doc.master_path,
    expected_article_count: doc.article_count,
    extracted_article_count: articles.length,
    output_sha256: doc.sha256,
    articles: auditArticles
  });
  console.log(JSON.stringify({ doc_id: doc.doc_id, articles: articles.length, sha256: doc.sha256 }));
}
await save('00-control/document-register.json', register);
const batchLabel = requestedIDs.length ? `docs-${requestedIDs.join('-')}` : 'batch-01';
await save(`00-control/reconstruction-${batchLabel}.json`, selected.map(doc => ({
  doc_id: doc.doc_id,
  source_id: doc.source_id,
  master_path: doc.master_path,
  article_count: doc.article_count,
  status: doc.status,
  sha256: doc.sha256,
  note: doc.note
})));
