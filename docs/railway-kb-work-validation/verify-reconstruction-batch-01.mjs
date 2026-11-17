import { api, load, rows, save } from './run.mjs';

const trials = await load('00-control/reconstruction-trial-batch-01.json');
for (const docID of ['DOC0001', 'DOC0002', 'DOC0003', 'DOC0004', 'DOC0005']) {
  const saved = await load(`04-chunks/actual/${docID}-reconstruction-trial.json`).catch(() => null);
  if (saved && !trials.some(trial => trial.doc_id === docID)) {
    trials.push({
      doc_id: saved.doc_id,
      source_id: saved.source_id,
      domain: saved.domain,
      dataset_id: saved.dataset_id,
      trial_document_id: saved.trial_document_id,
      filename: saved.filename,
      source_path: saved.source_path,
      source_sha256: saved.source_sha256,
      pipeline_id: saved.pipeline_id,
      pipeline_version_id: saved.pipeline_version_id,
      status: saved.status
    });
  }
}
const report = [];
for (const trial of trials) {
  let doc;
  for (let attempt = 0; attempt < 120; attempt++) {
    const docs = rows(await api(`/datasets/${trial.dataset_id}/documents?page=1&page_size=100`));
    doc = docs.find(item => item.id === trial.trial_document_id);
    if (!doc) throw new Error(`Trial document missing: ${trial.trial_document_id}`);
    const status = String(doc.ingestion_status || doc.status || '').toUpperCase();
    if (!['RUNNING', 'SCHEDULED', 'PROCESSING', 'UNSTARTED'].includes(status)) break;
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
  const allChunks = [];
  const pageSize = 100;
  const total = Number(doc.chunk_count || 0);
  for (let page = 1; page <= Math.max(1, Math.ceil(total / pageSize)); page++) {
    allChunks.push(...rows(await api(`/datasets/${trial.dataset_id}/documents/${doc.id}/chunks?page=${page}&page_size=${pageSize}`)));
  }
  const content = allChunks.map(chunk => String(chunk.content || chunk.content_with_weight || '')).join('\n');
  const expected = await load(`04-chunks/expected/${trial.doc_id}-article-audit.json`);
  const articleNumbers = new Set([...content.matchAll(/第[一二三四五六七八九十百零〇两0-9]+条/g)].map(match => match[0]));
  const expectedNumbers = expected.articles.map(item => item.article);
  const missingArticles = expectedNumbers.filter(article => !articleNumbers.has(article));
  const article33 = allChunks
    .map(chunk => String(chunk.content || chunk.content_with_weight || ''))
    .flatMap(text => [...text.matchAll(/### 第三十三条[^\n]*\n([\s\S]*?)(?=\n### 第[一二三四五六七八九十百零〇两0-9]+条|$)/g)]
      .map(match => match[1]))
    .join('\n');
  const entry = {
    ...trial,
    ingestion_status: doc.ingestion_status || doc.status,
    chunk_count_reported: total,
    chunk_count_exported: allChunks.length,
    missing_article_numbers: missingArticles,
    has_deleted_compensation_amounts: trial.source_id === 'S0005' && /(?:15万元|2000元)/.test(article33),
    has_boundary_definition: trial.source_id === 'S0005' && content.includes('以上”包括本数') && content.includes('以下”不包括本数'),
    has_full_report_supplement_rule: trial.source_id === 'S0005' && content.includes('出现新情况的，应当及时补报'),
    has_scene_change_evidence_rule: trial.source_id === 'S0005' && content.includes('绘制现场示意图') && content.includes('不得伪造、隐匿或者毁灭相关证据'),
    chunks: allChunks
  };
  await save(`04-chunks/actual/${trial.doc_id}-reconstruction-trial.json`, entry);
  report.push({
    doc_id: entry.doc_id,
    domain: entry.domain,
    ingestion_status: entry.ingestion_status,
    chunk_count_reported: entry.chunk_count_reported,
    chunk_count_exported: entry.chunk_count_exported,
    missing_article_numbers: entry.missing_article_numbers,
    has_deleted_compensation_amounts: entry.has_deleted_compensation_amounts,
    has_boundary_definition: entry.has_boundary_definition,
    has_full_report_supplement_rule: entry.has_full_report_supplement_rule,
    has_scene_change_evidence_rule: entry.has_scene_change_evidence_rule
  });
}
await save('00-control/reconstruction-trial-acceptance-batch-01.json', report);
console.log(JSON.stringify(report, null, 2));
