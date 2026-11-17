import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { api, hash, load, root, rows, save } from './run.mjs';

const [command, ...selected] = process.argv.slice(2);
const folder = '05-review/revision-formal-tests-v5';
const inputPath = `${folder}/inputs.json`;
const manifestPath = `${folder}/manifest.json`;
const userAppID = '3b0470c7c4fb414dab6d32c19dfee8da';
const normalize = text => text.replace(/\*\*([^*]+)\*\*/gu, '$1').replace(/\s+/gu, '');
const optional = async (file, fallback) => load(file).catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return fallback;
});
const specifications = [
  ['V5D01', '机车车辆投入运营前和批量制造之前分别需要哪些许可证？', ['DOC0022-K03']],
  ['V5D02', '铁路机车车辆许可申请受理后，决定期限、可批准延长时间和不计入的评审时间怎样规定？', ['DOC0022-K17']],
  ['V5D03', '机车车辆维修许可证有哪些有效期限，申请延续须提前多少个工作日？', ['DOC0022-K20']],
  ['V5D04', '进口到境内销售铁路专用设备的销售企业是否也承担召回生产企业责任？', ['DOC0023-K06']],
  ['V5D05', '铁路专用设备缺陷调查结果收到后，生产企业提出异议的时限和论证机构有何要求？', ['DOC0023-K17']],
  ['V5D06', '生产企业确认铁路专用设备缺陷后须立即停止哪些活动？正在使用并影响运输秩序时怎么办？', ['DOC0023-K18']],
  ['V5D07', '铁路专用设备召回记录由谁保存，各保存几份，最少保存几年？', ['DOC0023-K23']],
  ['V5D08', '铁路专用设备生产企业既未提出异议又未主动召回时，责令召回的条件和异议期限是什么？', ['DOC0023-K21']],
  ['V5N01', '未提供厂家、型号和企业名称，能否确认某列控软件全部版本已经通过安全认证？', []],
  ['V5N02', '请给出某型号动车组制动控制器复位的具体按钮顺序和现场操作步骤。', []],
];
if (command === 'freeze') {
  const docs = (await load('00-control/document-register.json'))
    .filter(doc => ['DOC0022', 'DOC0023'].includes(doc.doc_id));
  const formal = [];
  const points = [];
  for (const doc of docs) {
    const qualityPath = doc.revision_v5.formal_import.evidence_path;
    const qualityBytes = await readFile(path.join(root, qualityPath));
    const quality = JSON.parse(qualityBytes);
    assert.equal(quality.quality_accepted, true);
    assert.equal(quality.formal_import, true);
    assert.equal(quality.master_sha256, doc.sha256);
    const expected = await load(doc.revision_v5.expected_path);
    points.push(...expected.points);
    formal.push({ doc_id: doc.doc_id, dataset_id: quality.dataset_id,
      document_id: quality.document_id, master_sha256: doc.sha256,
      quality_path: qualityPath, quality_sha256: hash(qualityBytes),
      pipeline_id: quality.pipeline_id, pipeline_version_id: quality.pipeline_version_id,
      accepted_chunks: quality.checks.map(item => ({
        id: item.chunk_id, text_sha256: item.actual_text_sha256,
      })), excluded_metadata: quality.metadata_excluded_chunk_ids });
  }
  const current = await api(`/searches/${userAppID}`);
  assert.equal(current.search_config.use_rerank, true);
  const previous = await load('00-control/acceptance-v3-context-inputs.json');
  const frozen = { scope: 'Two-document formal CL diagnostic regression; exposed cases, not final 70-question regression or independent holdout.',
    formal, parameters: { ...previous.parameters, rerank_candidates_count: 64,
      rerank_id: current.search_config.rerank_id },
    chat_model_id: '102e9861e4e24a73abb7cff80df6c52e',
    questions: specifications.map(([test_id, question, required]) => ({ test_id, question,
      answerable: required.length > 0, required: required.map(id => {
        const point = points.find(item => item.knowledge_point_id === id);
        assert.ok(point, id);
        return { knowledge_point_id: id, source_location: point.source_location,
          candidate_sha256: hash(point.text), evidence_text: point.text };
      }) })) };
  const existing = await optional(inputPath, null);
  if (existing) assert.equal(hash(JSON.stringify(existing)), hash(JSON.stringify(frozen)), 'Frozen inputs changed');
  else await save(inputPath, frozen);
  const manifest = await optional(manifestPath, { started_at: new Date().toISOString(),
    input_sha256: hash(JSON.stringify(frozen)), user_app_before: current });
  assert.equal(manifest.input_sha256, hash(JSON.stringify(frozen)));
  await save(manifestPath, manifest);
  console.log(JSON.stringify({ frozen: frozen.questions.length, answerable: 8, scope: frozen.scope }));
} else {
  const input = await load(inputPath);
  const manifest = await load(manifestPath);
  assert.equal(manifest.input_sha256, hash(JSON.stringify(input)));
  const datasetIDs = [...new Set(input.formal.map(doc => doc.dataset_id))];
  if (command === 'retrieval') {
    const results = await optional(`${folder}/retrieval.json`, []);
    for (const q of input.questions.filter(q => !selected.length || selected.includes(q.test_id))) {
      if (results.some(item => item.test_id === q.test_id)) continue;
      const raw = await api('/datasets/search', 'POST', {
        dataset_ids: datasetIDs, question: q.question, ...input.parameters,
      });
      await save(`${folder}/retrieval/${q.test_id}.json`, raw);
      const top5 = rows(raw).map((chunk, index) => {
        const doc = input.formal.find(item => item.document_id === chunk.document_id);
        assert.ok(doc, 'Unexpected document returned');
        assert.ok(doc.accepted_chunks.some(item => item.id === chunk.id
          && item.text_sha256 === hash(chunk.content || chunk.content_with_weight || '')),
        'Retrieved text differs from accepted formal output');
        return { rank: index + 1, chunk_id: chunk.id, document_id: chunk.document_id,
          knowledge_point_id: (chunk.content || '').match(/DOC\d{4}-K\d+/u)?.[0],
          content: chunk.content || chunk.content_with_weight || '', similarity: chunk.similarity };
      });
      assert.ok(top5.length <= 5);
      const evidence = q.required.map(point => ({ knowledge_point_id: point.knowledge_point_id,
        complete_chunk_ids: top5.filter(chunk => normalize(chunk.content).includes(normalize(point.evidence_text)))
          .map(chunk => chunk.chunk_id) }));
      const result = { test_id: q.test_id, checked_at: new Date().toISOString(), top5, evidence,
        evidence_complete: q.answerable ? evidence.every(item => item.complete_chunk_ids.length > 0) : null,
        answer_quality: 'NOT_TESTED_BY_RETRIEVAL' };
      results.push(result);
      await save(`${folder}/retrieval.json`, results);
      console.log(JSON.stringify({ id: q.test_id, complete: result.evidence_complete,
        top5: top5.map(chunk => chunk.knowledge_point_id) }));
    }
    manifest.retrieval_finished_at = new Date().toISOString();
  } else if (command === 'app') {
    const name = '铁路正式CL两篇v5诊断';
    if (!manifest.audit_search_id) {
      const existing = (await api('/searches')).search_apps?.filter(app => app.name === name) || [];
      assert.ok(existing.length <= 1);
      manifest.audit_search_id = existing[0]?.id || (await api('/searches', 'POST', {
        name, description: 'DOC0022/23正式入库局部检索、引用和无证据回答诊断；不构成最终验收。',
      })).search_id;
      await save(manifestPath, manifest);
    }
    const p = input.parameters;
    const config = { kb_ids: datasetIDs, chat_id: input.chat_model_id, top_k: p.knn_top_k,
      rerank_candidates_count: p.rerank_candidates_count, rerank_id: p.rerank_id, use_rerank: true,
      use_kg: false, keyword: false, similarity_threshold: p.similarity_threshold,
      keywords_similarity_weight: 1 - p.vector_similarity_weight,
      llm_setting: { temperature: 0.1, temperature_enabled: true } };
    await api(`/searches/${manifest.audit_search_id}`, 'PUT', { name, search_config: config });
    manifest.audit_app = await api(`/searches/${manifest.audit_search_id}`);
    for (const [key, value] of Object.entries(config)) {
      assert.deepEqual(manifest.audit_app.search_config[key], value, `Config readback: ${key}`);
    }
    manifest.answer_context_limit = 12;
    console.log(JSON.stringify({ audit_search_id: manifest.audit_search_id, rerank_id: p.rerank_id }));
  } else if (command === 'answers') {
    assert.ok(manifest.audit_search_id);
    const answers = await optional(`${folder}/answers.json`, []);
    for (const q of input.questions.filter(q => !selected.length || selected.includes(q.test_id))) {
      const previousIndex = answers.findIndex(item => item.test_id === q.test_id);
      const previous = answers[previousIndex];
      if (previous?.final_received && !previous.errors.length) continue;
      if (previous) assert.ok(selected.includes(q.test_id), 'Select a failed question explicitly before retrying');
      const attempt = (previous?.attempt || (previous ? 1 : 0)) + 1;
      const response = await api(`/searches/${manifest.audit_search_id}/completions`, 'POST', {
        question: q.question, kb_ids: datasetIDs,
      }, true);
      const raw = await response.text();
      const rawPath = `${folder}/answers/${q.test_id}${attempt > 1 ? `-attempt-${attempt}` : ''}.sse`;
      await save(rawPath, raw);
      const events = raw.split(/\r?\n/u).filter(line => line.startsWith('data: ')
        && line.slice(6) !== '[DONE]').map(line => JSON.parse(line.slice(6)));
      const final = events.findLast(event => event.data?.final === true);
      const errors = events.filter(event => event.code !== 0).map(event => event.message);
      const answer = { test_id: q.test_id, checked_at: new Date().toISOString(), raw_path: rawPath,
        final_received: Boolean(final), answer: final?.data?.answer || '',
        reference: final?.data?.reference || null, errors, attempt,
        semantic_and_citation_review: 'PENDING' };
      if (previous) {
        const { prior_attempts = [], ...prior } = previous;
        answer.prior_attempts = [...prior_attempts, prior];
        answers[previousIndex] = answer;
      } else answers.push(answer);
      await save(`${folder}/answers.json`, answers);
      console.log(JSON.stringify({ id: q.test_id, final: answer.final_received,
        length: answer.answer.length, errors }));
      assert.ok(answer.final_received && !errors.length, 'Answer request failed; inspect saved SSE before retrying');
    }
    manifest.answers_finished_at = new Date().toISOString();
  } else if (command === 'review') {
    const answers = await load(`${folder}/answers.json`);
    const retrieval = await load(`${folder}/retrieval.json`);
    const docs = await load('00-control/document-register.json');
    const points = [];
    for (const doc of docs.filter(doc => ['DOC0022', 'DOC0023'].includes(doc.doc_id))) {
      points.push(...(await load(doc.revision_v5.expected_path)).points);
    }
    // These decisions record a full-answer human review, not string-based semantic grading.
    const decisions = [
      ['V5D01', 'PASS', ['DOC0022-K03', 'DOC0022-K07'],
        '保留型号合格证前提、批量制造许可，以及进口和大修样车运营前的不同许可与责任主体。'],
      ['V5D02', 'PASS', ['DOC0022-K17', 'DOC0022-K16'],
        '20工作日、负责人批准延长10工作日并告知理由、检验检测及专家评审不计时均完整；补述审查程序有第十六条支持。'],
      ['V5D03', 'PASS', ['DOC0022-K20'],
        '5/8/10年、具体型号期限由国家铁路局发布、届满60工作日前申请延续均保留。'],
      ['V5D04', 'PASS', ['DOC0023-K06', 'DOC0023-K07', 'DOC0023-K18', 'DOC0023-K30'],
        '境外进口境内销售企业视为生产企业；主体责任、费用、立即停止活动与限期改正均有对应条款支持。'],
      ['V5D05', 'PASS', ['DOC0023-K17'],
        '收到结果15工作日内反映并提供证明、无利害关系机构或专家、必要时检验检测及通知结果均准确。'],
      ['V5D06', 'PASS', ['DOC0023-K18'],
        '立即停止生产销售进口并通知；立即停用可能较大影响运输秩序的限定、共同应急及确保运输安全均保留。'],
      ['V5D07', 'PASS', ['DOC0023-K23'],
        '生产企业、使用企业、国家铁路局各一份及不得少于5年均准确；版本说明对应来源。'],
      ['V5D08', 'PASS', ['DOC0023-K21', 'DOC0023-K17'],
        '全文先明确经专业技术机构确认缺陷的前提，再列未按期异议且未召回两个并列条件；15工作日期限准确。第十七条在K21片内完整携带。'],
      ['V5N01', 'PARTIAL', ['DOC0022-K06', 'DOC0023-K09', 'DOC0023-K16'],
        '核心拒答合格，未编造具体产品或全部版本认证状态，所引条款支持程序说明；末尾把国家铁路局并称认证/许可主管部门并建议查认证目录，现有证据不能建立列控软件安全认证职权及目录，应删除该无来源建议。'],
      ['V5N02', 'PARTIAL', ['DOC0023-K13', 'DOC0023-K19', 'DOC0023-K03'],
        '核心拒答合格，未编造按钮顺序；主动补述第三条定义时省略“由于设计、制造、标识等原因导致”，不能将不完整定义作为最终合格回答；建议只答证据不足，若补述定义则完整保留原因及危险限定。'],
    ];
    const results = [];
    for (const [id, decision, citedIDs, rationale] of decisions) {
      const q = input.questions.find(item => item.test_id === id);
      const a = answers.find(item => item.test_id === id);
      assert.ok(a?.final_received && !a.errors.length);
      const actual = a.reference.chunks;
      for (const c of actual) {
        const doc = input.formal.find(item => item.document_id === c.document_id);
        assert.ok(doc?.accepted_chunks.some(item => item.id === c.id
          && item.text_sha256 === hash(c.content)), `Changed answer context ${id}/${c.id}`);
      }
      const citations = citedIDs.map(pointID => {
        const point = points.find(item => item.knowledge_point_id === pointID);
        assert.ok(point);
        const direct = actual.filter(c => c.content.includes(pointID));
        const carriers = direct.length ? direct : actual.filter(c =>
          normalize(c.content).includes(normalize(point.text.split('\n\n').at(-1))));
        assert.ok(carriers.length, `Cited clause missing from answer context ${id}/${pointID}`);
        return { knowledge_point_id: pointID, source_location: point.source_location,
          expected_text_sha256: hash(point.text),
          actual_context: carriers.map(c => ({ chunk_id: c.id, text_sha256: hash(c.content) })),
          location_verified: true,
          claim_support: id === 'V5N02' && pointID === 'DOC0023-K03'
            ? 'PARTIAL_CAUSAL_CONDITION_OMITTED' : 'SUPPORTED' };
      });
      results.push({ test_id: id, answerable: q.answerable, decision,
        rationale, core_no_evidence_boundary: q.answerable ? null : 'PASS',
        all_answer_claims_accepted: decision === 'PASS',
        question_sha256: hash(q.question), answer_sha256: hash(a.answer),
        raw_sse_path: a.raw_path, raw_sse_sha256: hash(await readFile(path.join(root, a.raw_path))),
        reference_sha256: hash(JSON.stringify(a.reference)), citations,
        citation_format: '文名/条号文字定位；没有机器式引用标记。候选reference不等于实际引用。',
      });
    }
    const report = { reviewed_at: new Date().toISOString(),
      review_method: '主执行者完整阅读10条回答，对照冻结预期及合格正式片段逐项核对；脚本只绑定哈希、检查载体和记录人工裁定。',
      input_sha256: manifest.input_sha256, scope: input.scope,
      formal: input.formal.map(({ accepted_chunks, ...doc }) => doc),
      parameters: input.parameters, chat_model_id: input.chat_model_id,
      audit_search_id: manifest.audit_search_id, answer_context_limit: manifest.answer_context_limit,
      counts: { questions: results.length, retrieval_answerable_complete_top5: retrieval.filter(r => r.evidence_complete === true).length,
        answerable: 8, no_evidence: 2, answerable_answer_pass: 8,
        no_evidence_core_boundary_pass: 2, no_evidence_complete_answer_pass: 0,
        no_evidence_complete_answer_partial: 2,
        cited_clause_associations: results.reduce((n, r) => n + r.citations.length, 0) },
      local_acceptance: false, final_70_regression: false, independent_holdout: false,
      answer_generation_failure: { test_id: 'V5N01', initial_error: 'DeepSeek chat/completions unexpected EOF',
        attempts: 2, recovered: true, prior_attempt_retained: true },
      cost: { answer_requests: 11, answer_retries: 1, standalone_retrieval_requests: 10,
        answer_retrieval_requests: 11, new_semantic_review_requests: 0,
        semantic_points_reused: 63, tokens: null, fees: null, main_agent_cost: '未统计',
        note: '请求数为可观察API请求；底层嵌入/重排分批调用次数及全部费用未统计。' },
      results };
    await save(`${folder}/answer-review.json`, report);
    console.log(JSON.stringify({ counts: report.counts, accepted: false,
      evidence: `${folder}/answer-review.json` }));
  } else throw Error('Use freeze/retrieval/app/answers/review');
  const after = await api(`/searches/${userAppID}`);
  manifest.user_app_unchanged = hash(JSON.stringify(manifest.user_app_before)) === hash(JSON.stringify(after));
  assert.equal(manifest.user_app_unchanged, true);
  await save(manifestPath, manifest);
}
