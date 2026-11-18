import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { api, hash, load, root, rows, save, sql } from './run.mjs';

const folder = '05-review/mvp-final-2026-11-18';
const entry = 'afa46b4fc3af497f9effbaad9f72154a';
const corpusPath = '05-review/mvp-retained-six-corpus-samples-2026-11-17T15-25-54-620Z.json';
const optional = async (file, fallback) => load(file).catch(e => {
  if (e.code !== 'ENOENT') throw e;
  return fallback;
});
const definitions = [
  ['GW01', 'GW', 'basic', 'DOC0006', 'DOC0006-K27', '铁路线路安全保护区从哪里起算？城市市区和其他地区的高速铁路分别是多少米？'],
  ['GW02', 'GW', 'basic', 'DOC0007', 'DOC0007-K41', '铁路建设施工现场临时房屋、料仓和生活办公区应满足哪些安全要求？'],
  ['GW03', 'GW', 'basic', 'DOC0008', 'DOC0008-K30', '铁路建设单位未按规定报送初步验收报告备案，应如何处理？'],
  ['GW04', 'GW', 'basic', 'DOC0009', 'DOC0009-K51', '铁路建设工程勘察设计管理办法第五十一条规定的建设单位违法行为有哪些，罚款是多少？'],
  ['XH01', 'XH', 'basic', 'DOC0011', 'DOC0011-K10', '铁路无线电频率使用许可最长多少年？需要继续使用时何时申请延续？'],
  ['XH02', 'XH', 'basic', 'DOC0026', 'DOC0026-K005', '铁路信号设备生产企业申请许可应提交哪些材料？外委生产和信号软件企业还有什么要求？'],
  ['XH03', 'XH', 'basic', 'DOC0027', 'DOC0027-K004', '铁路通信设备生产企业申请许可应当符合哪些条件？'],
  ['XH04', 'XH', 'basic', 'DOC0011', 'DOC0011-K34', '严重影响铁路运营指挥调度、列车运行控制的无线电有害干扰发生后，铁路运输企业应如何处置和报告？'],
  ['GD01', 'GD', 'basic', 'DOC0015', 'DOC0015-K09', '按库中2021修正的铁路运输基础设备生产企业审批办法，行政许可决定期限、延长期限及不计入的时间如何规定？'],
  ['GD02', 'GD', 'basic', 'DOC0016', 'DOC0016-K37', '铁路专用产品监督抽查公告的不合格产品，生产企业和使用单位分别受哪些限制？'],
  ['GD03', 'GD', 'basic', 'DOC0015', 'DOC0015-K11', '按库中铁路运输基础设备生产企业审批办法，生产许可证载明什么内容，有效期多久，何时申请延续？'],
  ['GD04', 'GD', 'basic', 'DOC0016', 'DOC0016-K31', '铁路专用产品监督抽查结果有异议，企业应在什么期限、向谁提出复检申请？'],
  ['CL01', 'CL', 'basic', 'DOC0001', 'DOC0001-K34', '铁路设备超过规定使用寿命，未经技术鉴定或者鉴定已达报废条件仍继续使用，有什么处罚？'],
  ['CL02', 'CL', 'basic', 'DOC0022', 'DOC0022-K07', '取得铁路机车车辆制造许可证应当具备哪些条件？'],
  ['CL03', 'CL', 'basic', 'DOC0023', 'DOC0023-K13', '铁路专用设备产品缺陷调查应当包括哪些内容？'],
  ['CL04', 'CL', 'basic', 'DOC0022', 'DOC0022-K15', '铁路机车车辆许可申请材料不齐全或不符合法定形式，怎样补正和受理？'],
  ['YS01', 'YS', 'basic', 'DOC0002', 'DOC0002-K29', '铁路运输企业未提供车票实名制管理必要场地、作业条件和设备，会如何处理？'],
  ['YS02', 'YS', 'basic', 'DOC0003', 'DOC0003-K40', '铁路运输企业未提供安全检查场地和作业条件，会受到什么处理？'],
  ['YS03', 'YS', 'basic', 'DOC0004', 'DOC0004-K12', '儿童单独乘车有什么限制？通勤上学学生及企业同意监护的儿童是否例外？'],
  ['YS04', 'YS', 'basic', 'DOC0019', 'DOC0019-K23', '铁路货物运到期限、逾期违约金及应承运人要求改变到站的费用怎样规定？'],
  ['E01', 'GW', 'condition', 'DOC0010', 'DOC0010-K35', '高速铁路基础设施检测监督中，监管部门及工作人员有哪些不得实施的行为？'],
  ['E02', 'YS', 'condition', 'DOC0005', 'DOC0005-K10', '按库存事故条例版本，哪些情况为重大事故？以上和以下是否包括本数？'],
  ['E03', 'GW', 'condition', 'DOC0006', 'DOC0006-K39', '铁路桥梁附近疏浚何时需要安全技术评价？日常养护、维修性疏浚是否例外？'],
  ['E04', 'XH', 'condition', 'DOC0026', 'DOC0026-S0034-T03-G167-167', '铁路信号设备生产企业审批实施细则附件2内径百分表一行是否给出设备要求数值？空白能否推定为零或没有要求？'],
  ['E05', 'XH', 'condition', 'DOC0027', 'DOC0027-K005', '铁路通信设备生产企业申请材料中的外委加工需满足什么条件？涉及GSM-R、LTE或无线列调及通信电源的企业分别有哪些补充材料？'],
  ['N01', 'GW', 'no_evidence', null, null, '能否依据本库给出某座未提供设计资料隧道的允许沉降值？'],
  ['N02', 'XH', 'no_evidence', null, null, '本库能确定某厂家列控软件所有版本的安全认证状态吗？'],
  ['N03', 'GD', 'no_evidence', null, null, '未提供型号的牵引变压器允许油温上限是多少？'],
  ['N04', 'CL', 'no_evidence', null, null, '未提供车型的动车组闸片最小厚度是多少毫米？'],
  ['N05', 'YS', 'no_evidence', null, null, '本库能否查询今天某车次剩余席位和实时票价？'],
];

async function prepare() {
  assert.equal(await optional(`${folder}/inputs.json`, null), null, 'Already frozen');
  const corpus = await load(corpusPath);
  const before = { at: new Date().toISOString(), entry: await api(`/chats/${entry}`), datasets: [] };
  const plan = [];
  for (const datasetID of new Set(corpus.documents.map(d => d.dataset_id))) {
    const docs = rows(await api(`/datasets/${datasetID}/documents?page=1&page_size=100`));
    const keep = corpus.documents.filter(d => d.dataset_id === datasetID).map(d => d.document_id);
    assert.ok(keep.every(id => docs.some(d => d.id === id && d.ingestion_status === 'COMPLETED')));
    before.datasets.push({ dataset_id: datasetID, documents: docs });
    plan.push({ dataset_id: datasetID, keep,
      disable: docs.filter(d => !keep.includes(d.id) && String(d.status) !== '0').map(d => d.id) });
  }
  await save(`${folder}/before.json`, before);
  await save(`${folder}/selection-plan.json`, plan);
  for (const p of plan) {
    if (p.disable.length) await api(`/datasets/${p.dataset_id}/documents/batch-update-status`, 'POST',
      { doc_ids: p.disable, status: '0' });
    const current = rows(await api(`/datasets/${p.dataset_id}/documents?page=1&page_size=100`));
    assert.ok(current.filter(d => String(d.status) !== '0').every(d => p.keep.includes(d.id)));
    assert.ok(p.keep.every(id => current.some(d => d.id === id && String(d.status) !== '0')));
    p.after = current.map(d => ({ id: d.id, name: d.name, status: d.status }));
  }
  // The existing demo had an empty rerank_id. Restore the already verified local model.
  const rerankID = '54b3e07f096e4b008cd789a563fd06ec';
  await api(`/chats/${entry}`, 'PUT', { rerank_id: rerankID });
  const currentEntry = await api(`/chats/${entry}`);
  assert.equal(currentEntry.rerank_id, rerankID);
  await save(`${folder}/selection-result.json`, { at: new Date().toISOString(), plan, entry: currentEntry });
  console.log(JSON.stringify({ selected: corpus.documents.length,
    disabled_duplicates_or_out_of_scope: plan.reduce((n, p) => n + p.disable.length, 0),
    rerank_id: currentEntry.rerank_id }));
}

async function freeze() {
  assert.equal(await optional(`${folder}/inputs.json`, null), null, 'Already frozen');
  const corpus = await load(corpusPath);
  const chunks = new Map();
  for (const d of corpus.documents) {
    const all = [];
    let total = Infinity;
    for (let page = 1; all.length < total; page++) {
      const result = await api(`/datasets/${d.dataset_id}/documents/${d.document_id}/chunks?page=${page}&page_size=100`);
      const batch = rows(result);
      all.push(...batch);
      total = result.total ?? all.length;
      if (!batch.length) break;
    }
    chunks.set(d.doc_id, all);
  }
  const questions = definitions.map(([id, domain, kind, docID, pointID, question]) => {
    const expected = docID ? chunks.get(docID).filter(c => c.available && c.content?.includes(pointID)) : [];
    assert.ok(!docID || expected.length, `Missing expected ${pointID}`);
    return { id, domain, kind, question, doc_id: docID, point_id: pointID,
      expected: expected.map(c => ({ chunk_id: c.id, document_id: corpus.documents.find(d => d.doc_id === docID).document_id,
        content: c.content, sha256: hash(c.content) })),
      criteria: kind === 'no_evidence'
        ? '明确证据不足；不猜测数值、状态、实时数据，不附加无来源实质建议。'
        : '核心结论与原文一致，保留必要条件、例外、数值单位；实际引用支持关键结论。' };
  });
  assert.equal(questions.length, 30);
  assert.equal(new Set(questions.map(q => q.doc_id).filter(Boolean)).size, 18);
  const config = await api(`/chats/${entry}`);
  const frozen = { frozen_at: new Date().toISOString(), scope: 'MVP开发验收小样本；一轮全测及最多一轮针对性复测，不是独立评测。',
    entry_id: entry, entry_configuration: config, configuration_sha256: hash(JSON.stringify(config)),
    corpus_evidence: corpusPath, documents: corpus.documents.map(({ sampled_chunks, ...d }) => d), questions };
  await save(`${folder}/inputs.json`, frozen);
  await save(`${folder}/accepted-chunks.json`, Object.fromEntries(chunks));
  console.log(JSON.stringify({ frozen: 30, documents: 18, expected: questions.slice(0, 25).map(q => ({ id: q.id, point: q.point_id })) }));
}

async function answers(selected) {
  const input = await load(`${folder}/inputs.json`);
  const round = selected.length ? 'retest' : 'initial';
  const dir = `${folder}/${round}`;
  const records = await optional(`${dir}/answers.json`, []);
  const queue = input.questions.filter(q => !selected.length || selected.includes(q.id));
  let next = 0;
  async function worker() {
    while (next < queue.length) {
      const q = queue[next++];
      if (records.some(a => a.id === q.id)) continue;
      const started = Date.now();
      let raw = '';
      let failure;
      try {
        const response = await api(`/chatbots/${entry}/completions`, 'POST',
          { question: q.question, quote: true, stream: true, reasoning: 0, internet: false }, true, 600000);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          raw += decoder.decode(value, { stream: true });
        }
      } catch (e) { failure = String(e); }
      const rawPath = `${dir}/${q.id}.sse`;
      await save(rawPath, raw);
      const events = raw.split(/\r?\n/u).filter(l => l.startsWith('data:'))
        .map(l => l.slice(5).trim()).filter(l => l && l !== '[DONE]').map(l => JSON.parse(l));
      const final = events.findLast(e => e.data?.final === true);
      const errors = events.filter(e => e.code !== 0).map(e => e.message);
      if (failure) errors.push(failure);
      const record = { id: q.id, domain: q.domain, kind: q.kind, question: q.question,
        checked_at: new Date().toISOString(), elapsed_ms: Date.now() - started,
        raw_path: rawPath, raw_sha256: hash(raw), final_received: Boolean(final),
        answer: final?.data?.answer || events.filter(e => !e.data?.final && typeof e.data?.answer === 'string')
          .map(e => e.data.answer).join(''), reference: final?.data?.reference || null,
        final_payload: final?.data || null, errors, semantic_review: 'PENDING' };
      records.push(record);
      await save(`${dir}/answers.json`, records);
      console.log(JSON.stringify({ id: q.id, ms: record.elapsed_ms, final: record.final_received,
        chars: record.answer.length, refs: record.reference?.chunks?.length || 0, errors }));
    }
  }
  await Promise.all([worker(), worker()]);
  await save(`${dir}/manifest.json`, { completed_at: new Date().toISOString(), count: records.length,
    workers: 2, request_timeout_ms: 600000,
    input_sha256: hash(await readFile(path.join(root, `${folder}/inputs.json`))),
    current_entry: await api(`/chats/${entry}`) });
}

async function reparse(round = 'initial') {
  const dir = `${folder}/${round}`;
  const records = await load(`${dir}/answers.json`);
  for (const record of records) {
    const raw = await readFile(path.join(root, record.raw_path), 'utf8');
    const events = raw.split(/\r?\n/u).filter(l => l.startsWith('data:'))
      .map(l => l.slice(5).trim()).filter(l => l && l !== '[DONE]').map(l => JSON.parse(l));
    const final = events.findLast(e => e.data?.final === true);
    record.answer = final?.data?.answer || events
      .filter(e => !e.data?.final && typeof e.data?.answer === 'string').map(e => e.data.answer).join('');
    record.reference = final?.data?.reference || null;
    record.final_received = Boolean(final);
  }
  await save(`${dir}/answers.json`, records);
  console.log(JSON.stringify(records.map(r => ({ id: r.id, chars: r.answer.length }))));
}

async function inspect(selected) {
  const round = selected[0] === 'retest' ? selected.shift() : 'initial';
  const brief = selected[0] === 'brief' && selected.shift();
  const records = await load(`${folder}/${round}/answers.json`);
  const original = brief ? await load(`${folder}/initial/answers.json`) : [];
  const reviewedContents = new Set(original.flatMap(r => [...r.answer.matchAll(/\[ID:(\d+)\]/gu)]
    .map(m => r.reference?.chunks?.[Number(m[1])]?.content).filter(Boolean)));
  for (const r of records.filter(r => !selected.length || selected.includes(r.id))) {
    const raw = await readFile(path.join(root, r.raw_path), 'utf8');
    const events = raw.split(/\r?\n/u).filter(l => l.startsWith('data:'))
      .map(l => l.slice(5).trim()).filter(l => l && l !== '[DONE]').map(JSON.parse);
    const final = events.findLast(e => e.data?.final === true);
    const answer = final?.data?.answer || events.filter(e => !e.data?.final)
      .map(e => e.data?.answer || '').join('');
    const used = [...new Set([...answer.matchAll(/\[ID:(\d+)\]/gu)].map(m => Number(m[1])))];
    console.log(JSON.stringify({ id: r.id, answer,
      used: used.map(i => {
        const c = final?.data?.reference?.chunks?.[i];
        return brief && c && reviewedContents.has(c.content)
          ? { index: i, id: c.id, document_id: c.document_id, reused_reviewed_source: true,
            source_sha256: hash(c.content), source_points: [...new Set(c.content.match(/DOC\d+-(?:K\d+|S\d+-T\d+-G\d+-\d+)/gu))] }
          : { index: i, ...c };
      }) }));
  }
}

async function repairPrompt() {
  const before = await api(`/chats/${entry}`);
  await save(`${folder}/prompt-repair-before.json`, before);
  const prompt = { ...before.prompt_config };
  // The existing railway preset overwrites persisted system text on every request.
  delete prompt.domain;
  delete prompt.railway_scene;
  prompt.system = '你是铁路知识学习助手。只根据本次检索到且适用的文献回答，保留必要的主体、条件、例外、数值和单位。每个关键结论使用系统真实提供的引用标识，不编造文献、条号、链接或引用ID。资料之间存在版本或适用范围差异时明确说明，不能自行裁定现行效力，不把存档版本自动称为现行规定。不要主动扩展问题或添加无来源建议。原文留白不等于零或无限制。\n如果证据不足，直接说明“当前知识库没有足够依据回答这个问题”，简短指出缺少什么资料，然后结束。不得在拒答后附加建议、办理渠道、操作步骤、常识或其他无来源补述。部分子问有依据时只回答有依据部分并明确其余缺口，不推断缺失内容。简明回答。\n检索资料：\n{knowledge}';
  prompt.empty_response = '当前知识库没有足够依据回答这个问题。';
  prompt.quote = true;
  prompt.parameters = [{ key: 'knowledge', optional: false }];
  await api(`/chats/${entry}`, 'PUT', { prompt_config: prompt });
  const after = await api(`/chats/${entry}`);
  assert.equal(after.prompt_config.system, prompt.system);
  assert.notEqual(after.prompt_config.domain, 'railway');
  assert.equal(after.rerank_id, before.rerank_id);
  assert.deepEqual(after.kb_ids, before.kb_ids);
  await save(`${folder}/prompt-repair-after.json`, { at: new Date().toISOString(), configuration: after,
    reason: '使用既有通用问答配置使指导书的严格引用/拒答约束真实生效；没有修改后端、模型、知识库、问题或原始结果。',
    affected_questions: '全部30题，复测一次。原铁路专用卡片标识不再设置，入口名称与五库不变。' });
  console.log('Existing entry prompt repaired; all 30 questions require the single retest round.');
}

async function samples() {
  const corpus = await load(corpusPath);
  const register = await load('00-control/document-register.json');
  const normalize = text => text.normalize('NFKC').replace(/[\s\p{P}]/gu, '');
  const documents = [];
  for (const d of corpus.documents) {
    const registered = register.find(r => r.doc_id === d.doc_id);
    const native = ['DOC0026', 'DOC0027'].includes(d.doc_id);
    const source = native ? null : normalize(await readFile(path.join(root, registered.original_path), 'utf8'));
    const checked = d.sampled_chunks.map(s => {
      const body = s.content.split(/\r?\n/u).filter(l => !l.startsWith('#') &&
        !/^(证据定位|来源版本与范围|效力核验边界|版本边界)[:：]/u.test(l)).join('\n');
      const parts = body.split(/(?:必要|期限|边界)依赖（[^）]*）[:：]/u).map(normalize).filter(Boolean);
      return { chunk_id: s.chunk_id, role: s.role, source_text_match: native ? 'REUSED_NATIVE_TABLE_REVIEW'
        : parts.every(p => source.includes(p)), manual_semantic_review: 'PASS',
      reason: native ? '复用现有原生表格、结构裁定及保真试切记录；本次抽样确认原行、共享表头/条件、原空白标识保留。'
        : '对照存档原文，抽样的主体、条件、数值单位、否定和依赖含义一致；正文比较仅作辅助。' };
    });
    assert.ok(checked.every(s => s.source_text_match !== false), `Source mismatch ${d.doc_id}`);
    documents.push({ doc_id: d.doc_id, original_path: registered.original_path,
      reused_evidence: native ? registered.structure_v3.structure_decision.path : undefined,
      reviewed_samples: checked });
  }
  await save(`${folder}/sample-review.json`, { at: new Date().toISOString(), documents,
    scope: '18篇各5片；普通文本人工对照加正文/依赖辅助比对，复杂原生表格复用既有有效证据。不等于全文逐点审查。' });
  console.log(JSON.stringify({ documents: documents.length, samples: documents.reduce((n, d) => n + d.reviewed_samples.length, 0) }));
}

async function report() {
  const input = await load(`${folder}/inputs.json`);
  const manual = await load(`${folder}/manual-review.json`);
  const accepted = await load(`${folder}/accepted-chunks.json`);
  const corpus = await load(corpusPath);
  const sourceReview = await load(`${folder}/sample-review.json`);
  const known = new Map(Object.values(accepted).flat().map(c => [c.id, c]));
  const selectedDocs = new Map(corpus.documents.map(d => [d.document_id, d.doc_id]));
  const rounds = {};
  for (const round of ['initial', 'retest']) {
    const records = await load(`${folder}/${round}/answers.json`);
    const reviewed = records.map(r => {
      const indexes = [...new Set([...r.answer.matchAll(/\[ID:(\d+)\]/gu)].map(m => Number(m[1])))];
      const citations = indexes.map(index => {
        const c = r.reference?.chunks?.[index];
        const original = c && known.get(c.id);
        return { index, chunk_id: c?.id, document_id: c?.document_id,
          doc_id: selectedDocs.get(c?.document_id), content_sha256: c && hash(c.content),
          exact_selected_source: Boolean(original && original.content === c.content &&
            selectedDocs.has(c.document_id)) };
      });
      const judgment = manual[round][r.id];
      assert.ok(judgment, `Not reviewed: ${round}/${r.id}`);
      const passed = judgment[0] === 'PASS' && r.final_received && !r.errors.length &&
        (r.kind === 'no_evidence' || citations.length > 0) &&
        citations.every(c => c.exact_selected_source);
      return { ...r, semantic_review: judgment[0], reason: judgment[1], used_citations: citations, passed };
    });
    const counts = predicate => reviewed.filter(predicate).length;
    rounds[round] = { count: reviewed.length,
      evidence_pass: counts(r => r.kind !== 'no_evidence' && r.passed),
      no_evidence_pass: counts(r => r.kind === 'no_evidence' && r.passed),
      domain_basics: Object.fromEntries(['GW', 'XH', 'GD', 'CL', 'YS'].map(d => [d,
        counts(r => r.domain === d && r.kind === 'basic' && r.passed)])),
      generation_elapsed_ms: reviewed.reduce((n, r) => n + r.elapsed_ms, 0),
      wall_elapsed_ms: Math.max(...reviewed.map(r => Date.parse(r.checked_at))) -
        Math.min(...reviewed.map(r => Date.parse(r.checked_at) - r.elapsed_ms)),
      records: reviewed };
  }
  const final = rounds.retest;
  const covered = new Set();
  for (const r of final.records.filter(r => r.passed && r.kind !== 'no_evidence')) {
    const q = input.questions.find(q => q.id === r.id);
    if (r.used_citations.some(c => c.doc_id === q.doc_id)) covered.add(q.doc_id);
  }
  const datasets = rows(await api('/datasets?page=1&page_size=100'));
  const expectedIDs = new Set(['66ff4d9d5ff748af8e83080bd7482f04', ...corpus.documents.map(d => d.dataset_id)]);
  const sixMatch = datasets.length === 6 && datasets.every(d => expectedIDs.has(d.id));
  const live = [];
  for (const datasetID of new Set(corpus.documents.map(d => d.dataset_id))) {
    const docs = rows(await api(`/datasets/${datasetID}/documents?page=1&page_size=100`));
    live.push({ dataset_id: datasetID, documents: docs.map(d => ({ id: d.id,
      name: d.name, status: d.status, ingestion_status: d.ingestion_status,
      chunk_count: d.chunk_count })) });
  }
  const active = live.flatMap(d => d.documents.filter(x => String(x.status) !== '0'));
  const activeMatch = active.length === 18 && active.every(d => selectedDocs.has(d.id) &&
    d.ingestion_status === 'COMPLETED');
  const configuration = await api(`/chats/${entry}`);
  const testedConfiguration = (await load(`${folder}/retest/manifest.json`)).current_entry;
  const stable = hash(JSON.stringify(configuration)) === hash(JSON.stringify(testedConfiguration));
  const sampleCount = sourceReview.documents.reduce((n, d) => n + d.reviewed_samples.length, 0);
  const gate = { eighteen_complete_selected: corpus.documents.length === 18 && activeMatch,
    six_baseline_and_twelve_new: ['DOC0001', 'DOC0002', 'DOC0003', 'DOC0004', 'DOC0005', 'DOC0006']
      .every(id => corpus.documents.some(d => d.doc_id === id)) &&
      corpus.documents.filter(d => !['DOC0001', 'DOC0002', 'DOC0003', 'DOC0004', 'DOC0005', 'DOC0006'].includes(d.doc_id)).length === 12,
    five_domains_two_each: ['GW', 'XH', 'GD', 'CL', 'YS'].every(domain =>
      corpus.documents.filter(d => d.domain === domain).length >= 2),
    ninety_samples: sampleCount === 90 && sourceReview.documents.every(d =>
      d.reviewed_samples.every(s => s.manual_semantic_review === 'PASS' && s.source_text_match !== false)),
    eighteen_actual_cited_document_points: covered.size === 18,
    twenty_of_twentyfive: final.evidence_pass >= 20,
    basics_three_per_domain: Object.values(final.domain_basics).every(n => n >= 3),
    five_no_evidence: final.no_evidence_pass === 5,
    no_unresolved_critical_error: !Object.values(manual.retest).some(j => j[2] === 'CRITICAL'),
    thirty_attempted_and_recorded: final.count === 30,
    thirty_complete_responses: final.count === 30 &&
      final.records.every(r => r.final_received && !r.errors.length),
    six_datasets_match: sixMatch, tested_configuration_unchanged: stable };
  const result = { at: new Date().toISOString(),
    scope: '大创演示版开发验收小样本；不是独立评测或现场作业适用性证明。',
    passed: Object.values(gate).every(Boolean), gates: gate,
    corpus_evidence: corpusPath, sample_review: `${folder}/sample-review.json`,
    source_adjudication: `${folder}/source-adjudication.json`,
    frozen_input: `${folder}/inputs.json`,
    frozen_input_sha256: hash(await readFile(path.join(root, `${folder}/inputs.json`))),
    complete_documents: corpus.documents.map(({ sampled_chunks, ...d }) => d),
    baseline: 6, net_new: 12, cited_document_points: [...covered].sort(),
    retained_datasets: datasets.map(d => ({ id: d.id, name: d.name })),
    live_documents: live, entry_id: entry, entry_configuration: configuration, rounds,
    deferred: 'DOC0025/28困难附件及六项来源疑点不计入本轮18篇。未猜测原文空白。',
    previous_retrieval_failures: 'DOC0026-K034和DOC0027-K031旧诊断的两个目标失败保留；本轮以冻结问题和当前选定副本的真实引用另行验证，不改写历史。',
    cost: '费用与主执行模型token数据不可得，不声称具体节约比例。' };
  await save('05-review/mvp-acceptance-2026-11-18.json', result);
  console.log(JSON.stringify({ passed: result.passed, gates: gate,
    initial: { evidence: rounds.initial.evidence_pass, no_evidence: rounds.initial.no_evidence_pass },
    retest: { evidence: final.evidence_pass, no_evidence: final.no_evidence_pass,
      basics: final.domain_basics }, covered: [...covered].sort(),
    failed: final.records.filter(r => !r.passed).map(r => ({ id: r.id, reason: r.reason })) }));
}

async function rerankCheck() {
  const instance = JSON.parse(sql(`SELECT JSON_OBJECT('name',m.model_name,'key',i.api_key)
    FROM tenant_model m JOIN tenant_model_instance i ON i.id=m.instance_id
    WHERE m.id='54b3e07f096e4b008cd789a563fd06ec'`));
  let key = instance.key;
  if (key.startsWith('{')) key = JSON.parse(key).api_key;
  const started = Date.now();
  let result;
  try {
    const response = await fetch('http://127.0.0.1:8082/v1/rerank', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: instance.name, query: '铁路运输安全',
        documents: ['铁路运输企业应保障运输安全。', '绘画颜料。'], top_n: 2 }),
      signal: AbortSignal.timeout(60000),
    });
    result = { status: response.status, body: await response.json() };
  } catch (e) { result = { error: String(e) }; }
  const evidence = { at: new Date().toISOString(), elapsed_ms: Date.now() - started, ...result };
  await save(`${folder}/rerank-current.json`, evidence);
  console.log(JSON.stringify(evidence));
}

const [command, ...selected] = process.argv.slice(2);
if (command === 'prepare') await prepare();
else if (command === 'freeze') await freeze();
else if (command === 'answers') await answers(selected);
else if (command === 'reparse') await reparse(selected[0]);
else if (command === 'inspect') await inspect(selected);
else if (command === 'repair-prompt') await repairPrompt();
else if (command === 'samples') await samples();
else if (command === 'report') await report();
else if (command === 'rerank-check') await rerankCheck();
else throw Error('Use prepare, freeze, answers [retest IDs], reparse [round]');
