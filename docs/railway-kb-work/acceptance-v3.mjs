import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { api, hash, load, originalDataset, root, rows, save } from './run.mjs';

const norm = s => s.replace(/\*\*([^*]+)\*\*/gu, '$1').replaceAll('`', '').replace(/\s+/gu, '');
const runName = process.env.RAILWAY_ACCEPTANCE_RUN || 'acceptance-v3';
if (!/^acceptance-v3(?:-[a-z0-9]+)*$/u.test(runName)) throw Error('Invalid acceptance run name');
const manifestPath = `00-control/${runName}-manifest.json`;
const inputPath = `00-control/${runName}-inputs.json`;
const resultsPath = `00-control/${runName}-retrieval.json`;
const answerPath = `00-control/${runName}-answers.json`;
const command = process.argv[2];
const pointID = s => {
  const [d, k] = s.split(':');
  return `DOC${d.padStart(4, '0')}-K${k.padStart(2, '0')}`;
};
const specs = {
  GW01: ['8:5'], GW02: ['10:3'], GW03: ['6:39'], GW04: ['7:17'],
  GW05: ['6:30'], GW06: ['6:55'], GW07: ['6:38'], GW08: ['6:27'], GW09: [], GW10: [],
  XH01: ['11:6', '11:33'], XH02: ['12:4', '12:11'], XH03: ['6:52'], XH04: ['11:15'],
  XH05: ['11:32'], XH06: ['12:20'], XH07: ['6:52'], XH08: ['14:30', '14:31'], XH09: [], XH10: [],
  GD01: ['14:32'], GD02: ['6:75'], GD03: ['6:53'], GD04: ['15:3'],
  GD05: ['6:75'], GD06: ['15:6'], GD07: ['6:53'], GD08: ['15:9', '15:11'], GD09: [], GD10: [],
  CL01: ['22:3'], CL02: [], CL03: ['1:19'], CL04: ['1:14'],
  CL05: ['22:15'], CL06: ['23:9', '23:11', '23:18'], CL07: ['1:15'], CL08: ['1:10'], CL09: [], CL10: [],
  YS01: ['2:3'], YS02: ['3:3'], YS03: ['3:25'], YS04: ['4:12'],
  YS05: ['3:18'], YS06: ['5:16'], YS07: ['3:33'], YS08: ['5:13'], YS09: [], YS10: ['5:33'],
  C01: ['6:30', '6:52'], C02: ['6:75', '4:31', '4:43'],
  C03: ['22:6', '10:3', '10:10'], C04: ['8:5', '15:3'],
  C05: ['3:9', '1:15'], C06: ['6:30', '11:32'], C07: ['1:12', '1:21', '5:24'],
  C08: ['6:52', '6:53'], C09: ['5:19', '4:31'], C10: ['15:3', '22:3'],
};
const holdout = [
  ['H01', 'GW', '最终留出', '一座铁路桥长恰为500米，上游与下游采砂禁区各多远；能否用较小范围替代地方依法划定的较大范围？', ['6:38']],
  ['H02', 'XH', '最终留出', '铁路关键信息基础设施只做上线前一次风险评估够吗，是否要求每年开展？', ['12:16']],
  ['H03', 'GD', '最终留出', '生产许可现场审查有2项关键项一般不合格、2项普通项严重不合格、8项普通项一般不合格，能否因各分项没超限就判合格？', ['14:45']],
  ['H04', 'CL', '最终留出', '申请Z1和Z2铁路驾驶资格时，是否与其他类型一样必须做驾驶适应性测试？请区分2022年考试文件与2024年资格规则。', ['17:13', '18:15']],
  ['H05', 'YS', '最终留出', '安检后走出隔离区域又返回，与始终留在区域内的换乘旅客，复检规则是否一致？', ['3:25']],
  ['H06', 'GD', '最终留出', '2026年铁路产品监督抽查办法的文件编号、施行日期是什么；抽查不合格结果几日内通知，生产者异议期限从何时起算？', ['16:32', '16:55']],
  ['H07', 'CL', '最终留出', '制造维修许可的地址名称更名，和实际搬迁导致许可条件变化，能否按同一种变更手续处理？请说明存档版本边界。', ['22:21', '22:22']],
  ['H08', '跨域', '最终留出', '铁路事故中为抢通线路而改变现场，能否不留影像记录；这是否免除运输企业不正常运输时的退票责任？', ['5:24', '4:31']],
  ['H09', 'XH', '资料缺口', '请列出CTCS-3某厂家软件2026年全部安全认证证书编号和有效截止日期。', []],
  ['H10', 'GD', '资料缺口', '请直接给出一个没有站名、接线图和设备型号的牵引变电所倒闸操作票，逐步列出开关编号。', []],
];

async function optional(file, fallback) {
  return load(file).catch(e => { if (e.code !== 'ENOENT') throw e; return fallback; });
}

if (command === 'freeze') {
  const register = await load('00-control/document-register.json');
  const ledger = await load('00-control/revision-v3-ledger.json');
  const points = {};
  const formal = [];
  for (const doc of register) {
    const record = ledger.documents.find(r => r.doc_id === doc.doc_id && r.sha256 === doc.sha256 &&
      r.phase === 'formal' && r.status === 'full-body-verified');
    if (!record) throw Error(`${doc.doc_id}: formal gate missing`);
    formal.push({ doc_id: doc.doc_id, document_id: record.document_id, sha256: doc.sha256 });
    for (const p of (await load(doc.structure_v3.expected_path)).points) points[p.knowledge_point_id] = p;
  }
  const bank = await load('00-control/question-bank.json');
  const questions = [
    ...bank.questions.map(q => [...q, specs[q[0]]]),
    ...holdout,
  ].map(([test_id, domain, kind, question, required], index) => ({
    test_id, domain, kind, question, holdout: index >= 60, answerable: required.length > 0,
    required: required.map(s => {
      const id = pointID(s);
      const p = points[id];
      if (!p) throw Error(`Missing expected ${id}`);
      return { knowledge_point_id: id, source_ids: p.source_ids, source_location: p.source_location,
        source_version: p.source_version, evidence_text: p.body };
    }),
    expectation_note: required.length ? '全部必要条款正文须在Top5中；命中文件不算证据完整。'
      : '资料缺口；回答必须明确不足/范围不符，禁止编造设备参数、票据或认证状态。',
  }));
  const input = { frozen_at: new Date().toISOString(), dataset_id: originalDataset,
    parameters: { page_size: 5, knn_top_k: 128, knn_num_candidates: 256, use_kg: false,
      similarity_threshold: 0.1, vector_similarity_weight: 0.5 },
    rerank: '未使用：已配置重排服务连接拒绝；不代表原搜索应用重排已恢复。',
    formal, questions, holdout_status: runName === 'acceptance-v3'
      ? 'H01-H10在本轮运行前冻结，首次留出'
      : '原70题回归复测；H01-H10已暴露，不再声明独立留出' };
  const prior = await optional(inputPath, null);
  if (prior) {
    const stable = v => JSON.stringify({ ...v, frozen_at: undefined });
    if (stable(prior) !== stable(input)) {
      if (await optional(manifestPath, null)) throw Error('Frozen inputs differ; create separate run');
      await save(`05-review/history/unrun-inputs-${hash(JSON.stringify(prior)).slice(0, 16)}.json`, prior);
      await save(inputPath, input);
    }
  } else await save(inputPath, input);
  console.log(JSON.stringify({ frozen: questions.length, answerable: questions.filter(q => q.answerable).length }));
} else if (command === 'retrieval') {
  const input = await load(inputPath);
  const signature = hash(JSON.stringify(input));
  const manifest = await optional(manifestPath, { signature, started_at: new Date().toISOString() });
  if (manifest.signature !== signature) throw Error('Frozen inputs changed');
  await save(manifestPath, manifest);
  const results = await optional(resultsPath, []);
  for (let start = 0; start < input.questions.length; start += 5) {
    for (const q of input.questions.slice(start, start + 5)) {
      if (results.some(r => r.test_id === q.test_id)) continue;
      let r;
      try {
        const raw = await api('/datasets/search', 'POST', {
          dataset_ids: [originalDataset], question: q.question, ...input.parameters,
        });
        const raw_path = `05-review/${runName}/retrieval/${q.test_id}.json`;
        await save(raw_path, raw);
        const top5 = rows(raw).map((c, index) => ({
          rank: index + 1, chunk_id: c.id, document_id: c.document_id,
          doc_id: input.formal.find(d => d.document_id === c.document_id)?.doc_id || 'UNEXPECTED',
          knowledge_point_id: c.content?.match(/DOC\d{4}-K\d+/u)?.[0],
          similarity: c.similarity, content: c.content || c.content_with_weight || '',
        }));
        const evidence = q.required.map(p => ({
          knowledge_point_id: p.knowledge_point_id,
          supporting_chunk_ids: top5.filter(c => norm(c.content).includes(norm(p.evidence_text))).map(c => c.chunk_id),
        }));
        r = { test_id: q.test_id, checked_at: new Date().toISOString(), raw_path, top5, evidence,
          evidence_complete: q.answerable ? evidence.every(e => e.supporting_chunk_ids.length > 0) : null,
          unexpected_documents: top5.filter(c => c.doc_id === 'UNEXPECTED').map(c => c.document_id) };
      } catch (e) { r = { test_id: q.test_id, error: e.message }; }
      results.push(r);
      await save(resultsPath, results);
      console.log(JSON.stringify({ id: r.test_id, complete: r.evidence_complete,
        top5: r.top5?.map(c => c.knowledge_point_id), error: r.error }));
    }
  }
  manifest.retrieval_finished_at = new Date().toISOString();
  await save(manifestPath, manifest);
} else if (command === 'app') {
  const input = await load(inputPath);
  const manifest = await load(manifestPath);
  manifest.user_app_before = manifest.user_app_before || await api('/searches/3b0470c7c4fb414dab6d32c19dfee8da');
  const name = runName === 'acceptance-v3' ? '铁路重构V3独立验收' : `铁路重构V3回归验收 ${runName}`;
  if (!manifest.audit_search_id) {
    const existing = (await api('/searches')).search_apps?.filter(a => a.name === name) || [];
    if (existing.length > 1) throw Error('Duplicate audit apps');
    manifest.audit_search_id = existing[0]?.id || (await api('/searches', 'POST', {
      name, description: '三份任务书重构验收；独立应用保留实际问答证据。原用户应用保持原设置。',
    })).search_id;
    await save(manifestPath, manifest);
  }
  const config = { kb_ids: [originalDataset], chat_id: '102e9861e4e24a73abb7cff80df6c52e',
    top_k: 128, rerank_candidates_count: 100, use_kg: false, keyword: false,
    similarity_threshold: input.parameters.similarity_threshold,
    vector_similarity_weight: input.parameters.vector_similarity_weight,
    llm_setting: { temperature: 0.1, temperature_enabled: true } };
  await api(`/searches/${manifest.audit_search_id}`, 'PUT', { name, search_config: config });
  manifest.audit_config = config;
  manifest.answer_context_limit = 12;
  await save(manifestPath, manifest);
  console.log(JSON.stringify({ search_id: manifest.audit_search_id }));
} else if (command === 'answers') {
  const input = await load(inputPath);
  const manifest = await load(manifestPath);
  if (!manifest.audit_search_id) throw Error('No audit app');
  const results = await optional(answerPath, []);
  const selected = process.argv.slice(3);
  const questions = input.questions.filter(q => !selected.length || selected.includes(q.test_id));
  for (let start = 0; start < questions.length; start += 5) {
    for (const q of questions.slice(start, start + 5)) {
      if (results.some(r => r.test_id === q.test_id)) continue;
      let r;
      try {
        const response = await api(`/searches/${manifest.audit_search_id}/completions`, 'POST', {
          question: q.question, kb_ids: [originalDataset],
        }, true);
        const raw = await response.text();
        const raw_path = `05-review/${runName}/answers/${q.test_id}.sse`;
        await save(raw_path, raw);
        const events = raw.split(/\r?\n/).filter(s => s.startsWith('data: ')).map(s => JSON.parse(s.slice(6)));
        const final = events.findLast(e => e.data?.final === true);
        const errors = events.filter(e => e.code !== 0).map(e => e.message);
        r = { test_id: q.test_id, checked_at: new Date().toISOString(), raw_path,
          answer: final?.data?.answer || '', reference: final?.data?.reference || null, errors,
          final_received: Boolean(final), semantic_review: 'PENDING',
          answer_context_limit: 12, top5_acceptance_measured_separately: true };
      } catch (e) { r = { test_id: q.test_id, error: e.message }; }
      results.push(r);
      await save(answerPath, results);
      console.log(JSON.stringify({ id: q.test_id, final: r.final_received,
        length: r.answer?.length, errors: r.errors, error: r.error }));
    }
  }
  manifest.answers_finished_at = new Date().toISOString();
  manifest.user_app_after = await api('/searches/3b0470c7c4fb414dab6d32c19dfee8da');
  await save(manifestPath, manifest);
} else if (command === 'print-answers') {
  const input = await load(inputPath);
  const selected = process.argv.slice(3);
  for (const a of await load(answerPath)) {
    if (selected.length && !selected.includes(a.test_id)) continue;
    const q = input.questions.find(q => q.test_id === a.test_id);
    console.log(JSON.stringify({ id: a.test_id, question: q.question, answer: a.answer,
      errors: a.errors, reference_count: a.reference?.chunks?.length,
      references: a.reference?.chunks?.map((c, i) => ({ index: i,
        id: c.id, point: (c.content || c.content_with_weight || '').match(/DOC\d{4}-K\d+/u)?.[0] })) }));
  }
} else throw Error('Use freeze/retrieval/app/answers/print-answers');
