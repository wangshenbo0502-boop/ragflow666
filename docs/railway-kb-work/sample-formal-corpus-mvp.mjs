import assert from 'node:assert/strict';
import { api, hash, load, rows, save } from './run.mjs';

const register = await load('00-control/document-register.json');
const datasets = {
  GW: { id: 'dac0aeb13d4d4e4f967a689c4c55af69', name: '铁路资料优化试验-GW-工务与基础设施' },
  XH: { id: '8f7cbc152fc64d7b8d39da97028e5abe', name: '铁路资料优化试验-XH-通信信号与列车控制' },
  GD: { id: '6b3ebc8cdb424cc4b489f80a4bf8718c', name: '铁路资料优化试验-GD-牵引供电与电气设备' },
  CL: { id: '0fb4da10e6ad4dd0bc7071b4407fe038', name: '铁路资料优化试验-CL-机车车辆与运用检修' },
  YS: { id: '6276358588ab4dbb8c17baf7600b95c4', name: '铁路资料优化试验-YS-运输组织与安全管理' },
};
const expectedDocuments = {
  GW: ['DOC0006', 'DOC0007', 'DOC0008', 'DOC0009', 'DOC0010'],
  XH: ['DOC0011', 'DOC0026', 'DOC0027'],
  GD: ['DOC0015', 'DOC0016'],
  CL: ['DOC0001', 'DOC0022', 'DOC0023'],
  YS: ['DOC0002', 'DOC0003', 'DOC0004', 'DOC0005', 'DOC0019'],
};
const riskPattern = /(?:不(?:得|应|可|能)|除.{0,24}外|但.{0,24}|除非|除外|例外|条件|符合|发生.{0,12}变化|应当|必须|不得|至少|不超过|以上|以下|以内|期限|元|米|千伏|公里|%|kg|mm|时速|[0-9])/u;
const digest = value => hash(typeof value === 'string' ? value : JSON.stringify(value));
const isNonBusinessChunk = content => {
  const text = content.trim();
  return /^(?:#{1,6}\s*)?(?:目录|索引|来源索引)(?:\s|$)/u.test(text)
    || /(?:^|\n)#{1,6}\s*(?:来源与整理记录|文档版本与原件索引)(?:\s|$)/u.test(text)
    || /本节仅供追溯；不作为业务问答证据/u.test(text);
};

const documents = [];
for (const [domain, docIDs] of Object.entries(expectedDocuments)) {
  const target = datasets[domain];
  const dataset = await api(`/datasets/${target.id}`);
  assert.equal(dataset.id, target.id);
  assert.equal(dataset.name, target.name);
  const remoteDocs = rows(await api(`/datasets/${target.id}/documents?page=1&page_size=100`));
  for (const docID of docIDs) {
    const local = register.find(item => item.doc_id === docID);
    assert.ok(local, `Missing register record for ${docID}`);
    const matches = remoteDocs.filter(doc => doc.name.includes(`${docID}_`));
    assert.ok(matches.length > 0, `${docID} is missing from retained ${domain} dataset`);
    const priority = doc => doc.name.includes('保真入库副本') ? 5
      : doc.name.includes('结构通过') ? 4
        : doc.name.includes('精修_') ? 3
          : doc.name.includes('_rebuild') ? 2 : 1;
    matches.sort((a, b) => priority(b) - priority(a) || b.create_time - a.create_time);
    const remote = matches[0];
    assert.equal(remote.ingestion_status, 'COMPLETED', `${docID} ingestion incomplete`);
    assert.equal(remote.progress, 1, `${docID} ingestion progress incomplete`);
    const allChunks = [];
    let page = 1;
    let total = 0;
    do {
      const response = await api(
        `/datasets/${target.id}/documents/${remote.id}/chunks?page=${page}&page_size=100`
      );
      const pageChunks = rows(response);
      total = response.total ?? total;
      allChunks.push(...pageChunks);
      page += 1;
      if (!pageChunks.length) break;
    } while (allChunks.length < total);
    assert.equal(allChunks.length, total, `${docID} chunk pagination incomplete`);
    assert.ok(allChunks.length > 0, `${docID} has no chunks`);

    const business = allChunks.filter(chunk => chunk.available === true
      && chunk.content && !isNonBusinessChunk(chunk.content));
    assert.ok(business.length > 0, `${docID} has no available business chunks`);
    const first = business[0];
    const middle = business[Math.floor((business.length - 1) / 2)];
    const last = business.at(-1);
    const selected = [
      { role: 'opening', chunk: first },
      { role: 'middle', chunk: middle },
      { role: 'ending', chunk: last },
    ];
    const used = new Set(selected.map(item => item.chunk.id));
    const risk = business.filter(chunk => !used.has(chunk.id)
      && riskPattern.test(chunk.content));
    const scoredRisk = risk.map(chunk => ({
      chunk,
      score: (chunk.content.match(/[0-9]+(?:\.[0-9]+)?/gu) || []).length
        + (chunk.content.match(/(?:不得|除.{0,24}外|但.{0,24}|例外|条件|以上|以下|以内|期限)/gu) || []).length * 2,
    })).sort((a, b) => b.score - a.score);
    for (const [index, item] of scoredRisk.slice(0, 2).entries()) {
      selected.push({ role: `risk-${index + 1}`, chunk: item.chunk });
      used.add(item.chunk.id);
    }
    while (selected.length < Math.min(5, business.length)) {
      const candidate = business.find(chunk => !used.has(chunk.id));
      if (!candidate) break;
      selected.push({ role: `additional-${selected.length + 1}`, chunk: candidate });
      used.add(candidate.id);
    }
    const sample = selected.map(({ role, chunk }) => ({
      role,
      chunk_id: chunk.id || chunk.chunk_id,
      content_sha256: digest(chunk.content),
      available: chunk.available,
      content: chunk.content,
      has_doc_locator: chunk.content.includes(docID),
      has_heading: /^#\s|^##\s|^###\s/mu.test(chunk.content),
    }));
    documents.push({
      doc_id: docID,
      source_id: local.source_id,
      title: local.title,
      domain,
      dataset_id: target.id,
      document_id: remote.id,
      remote_filename: remote.name,
      ingestion_status: remote.ingestion_status,
      remote_chunk_count: allChunks.length,
      available_business_chunk_count: business.length,
      sampled_chunk_count: sample.length,
      sample_passed_structural_checks: sample.length === Math.min(5, business.length)
        && sample.every(item => item.available && item.content.length > 0 && item.has_doc_locator),
      sampled_chunks: sample,
    });
  }
}

assert.equal(documents.length, 18);
const checkedAt = new Date().toISOString();
const evidence = {
  checked_at: checkedAt,
  scope: 'MVP sample of 18 de-duplicated literature records in the six user-retained datasets. One canonical current remote copy per doc_id; five actual business chunks per document (opening, middle, ending, and two condition/value-rich chunks where available). No document content was changed.',
  domains: Object.fromEntries(Object.entries(expectedDocuments).map(([domain, ids]) => [
    domain,
    { dataset_id: datasets[domain].id, documents: ids.length },
  ])),
  documents,
  documents_checked: documents.length,
  documents_with_five_samples: documents.filter(doc => doc.sampled_chunk_count === 5).length,
  all_samples_available_and_locatable: documents.every(doc => doc.sample_passed_structural_checks),
  sample_content_sha256: digest(documents.map(doc => doc.sampled_chunks)),
};
const evidencePath = `05-review/mvp-retained-six-corpus-samples-${checkedAt.replaceAll(':', '-').replaceAll('.', '-')}.json`;
await save(evidencePath, evidence);
console.log(JSON.stringify({
  evidence: evidencePath,
  checked_at: checkedAt,
  documents_checked: documents.length,
  available_business_chunks_total: documents.reduce((sum, doc) => sum + doc.available_business_chunk_count, 0),
  documents_with_five_samples: evidence.documents_with_five_samples,
  all_samples_available_and_locatable: evidence.all_samples_available_and_locatable,
  samples: documents.map(doc => ({
    doc_id: doc.doc_id,
    domain: doc.domain,
    business_chunks: doc.available_business_chunk_count,
    sample_roles: doc.sampled_chunks.map(item => item.role),
    sample_ids: doc.sampled_chunks.map(item => item.chunk_id),
  })),
}, null, 2));
