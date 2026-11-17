import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { api, hash, load, root, save } from './run.mjs';

const folder = '05-review/xh-formal-answer-audit';
const inputPath = `${folder}/inputs.json`;
const manifestPath = `${folder}/manifest.json`;
const userAppID = '3b0470c7c4fb414dab6d32c19dfee8da';
const questions = [
  ['XH26-D01', '铁路信号设备生产企业申请许可证应提交哪些材料？', ['DOC0026-K005']],
  ['XH26-D02', '铁路信号设备生产企业哪些生产条件发生变化需要重新申请许可？', ['DOC0026-K016']],
  ['XH26-D03', '内径百分表的设备要求和数值是多少？', ['DOC0026-S0034-T03-G167-167']],
  ['XH27-D01', '铁路通信设备生产企业申请许可必须符合哪些条件？', ['DOC0027-K004']],
  ['XH27-D02', '申请铁路通信设备生产企业许可证要交哪些材料？外委加工有什么条件？', ['DOC0027-K005']],
  ['XH27-D03', '许可决定期限、延长及不计入期限的时间分别如何规定？', ['DOC0027-K013']],
  ['XH27-D04', '许可证有效期、延续申请期限和生产地址变化应如何处理？', ['DOC0027-K015', 'DOC0027-K016']],
  ['XH27-D05', '附件2对LTE检验过程专用测试软件要求了什么数值？', ['DOC0027-S0035-T02-G089-089']],
  ['XH26-N01', '请列出某型号信号设备现场校准的具体步骤和阈值。', []],
  ['XH27-N01', '请确认某厂家LTE设备所有软件版本均通过了安全认证。', []],
];
const normalize = value => value.replace(/\*\*([^*]+)\*\*/gu, '$1').replace(/\s+/gu, '');
const optional = async (file, fallback) => load(file).catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return fallback;
});

async function freeze() {
  const register = await load('00-control/document-register.json');
  const definitions = [
    {
      doc_id: 'DOC0026',
      quality_path: '05-review/DOC0026-formal-quality-2026-11-17.json',
      diagnostic_path: '05-review/DOC0026-formal-quality-2026-11-17.json',
      expected_path: '04-chunks/expected/DOC0026-successor-v3.json',
      actual_path: '04-chunks/actual/DOC0026-successor-formal.json',
      document_id: '458d60ee69b142e3bfe61701f7f41f68',
    },
    {
      doc_id: 'DOC0027',
      quality_path: '05-review/DOC0027-formal-quality-2026-11-17.json',
      diagnostic_path: '05-review/DOC0027-formal-retrieval-current-2026-11-17T11-15-14-550Z.json',
      expected_path: '04-chunks/expected/DOC0027-successor-v3.json',
      actual_path: '04-chunks/actual/DOC0027-successor-formal.json',
      document_id: '33ea398a0b4b4bfa8bc96a4278b3bd0a',
    },
  ];
  const documents = [];
  const points = [];
  for (const definition of definitions) {
    const record = register.find(item => item.doc_id === definition.doc_id);
    assert.ok(record, definition.doc_id);
    const qualityBytes = await readFile(path.join(root, definition.quality_path));
    const quality = JSON.parse(qualityBytes);
    const actualBytes = await readFile(path.join(root, definition.actual_path));
    const actual = JSON.parse(actualBytes);
    const expectedBytes = await readFile(path.join(root, definition.expected_path));
    const expected = JSON.parse(expectedBytes);
    assert.equal(quality.quality_accepted, true);
    assert.equal(quality.formal_import, true);
    assert.equal(quality.document_id, definition.document_id);
    assert.equal(actual.phase, 'formal');
    assert.equal(actual.document_id, definition.document_id);
    const checks = quality.checks || quality.point_checks;
    assert.ok(Array.isArray(checks) && checks.length > 0);
    documents.push({
      doc_id: definition.doc_id,
      dataset_id: quality.dataset_id,
      document_id: definition.document_id,
      master_sha256: record.sha256,
      quality_path: definition.quality_path,
      quality_sha256: hash(qualityBytes),
      actual_path: definition.actual_path,
      actual_sha256: hash(actualBytes),
      expected_path: definition.expected_path,
      expected_sha256: hash(expectedBytes),
      accepted_chunks: checks.map(check => ({
        id: check.chunk_id,
        point_id: check.knowledge_point_id,
        text_sha256: check.actual_text_sha256 || check.actual_sha256,
      })),
    });
    points.push(...(expected.knowledge_points || expected.points));
  }
  const d26 = JSON.parse(await readFile(path.join(root, definitions[0].diagnostic_path), 'utf8'));
  const d27 = JSON.parse(await readFile(path.join(root, definitions[1].diagnostic_path), 'utf8'));
  const diagnosticQuestions = [
    ...d26.retrieval.map(item => ({
      question: item.question,
      top5: item.top5,
      source_document: 'DOC0026',
    })),
    ...d27.questions.map(item => ({
      test_id: item.test_id,
      question: item.question,
      top5: item.top5,
      source_document: 'DOC0027',
    })),
  ];
  const frozenQuestions = questions.map(([test_id, question, required]) => {
    const expected = required.map(id => {
      const point = points.find(item => item.knowledge_point_id === id);
      assert.ok(point, `Missing expected point ${id}`);
      return {
        knowledge_point_id: id,
        source_location: point.source_location,
        expected_text_sha256: hash(point.text),
        text: point.text,
      };
    });
    const diagnostic = required.length
      ? diagnosticQuestions.find(item => item.question === question)
        || diagnosticQuestions.find(item => item.source_document === (test_id.includes('26') ? 'DOC0026' : 'DOC0027')
          && required.every(id => item.top5.some(chunk => (chunk.point_id || chunk.point_id) === id
            || chunk.text?.includes(id))))
      : null;
    if (required.length) assert.ok(diagnostic, `No current retrieval evidence for ${test_id}`);
    for (const item of expected) {
      const found = diagnostic.top5.find(chunk => chunk.point_id === item.knowledge_point_id
        || chunk.point === item.knowledge_point_id
        || (chunk.text || chunk.content || '').includes(item.knowledge_point_id));
      assert.ok(found, `Expected point not in current Top-5: ${test_id}/${item.knowledge_point_id}`);
      const chunkText = found.text || found.content || '';
      assert.ok(normalize(chunkText).includes(normalize(item.text))
        || normalize(item.text).includes(normalize(chunkText)),
      `Retrieved evidence does not match frozen point: ${test_id}/${item.knowledge_point_id}`);
    }
    return {
      test_id,
      question,
      answerable_from_library: required.length > 0,
      expected,
      retrieval_evidence_path: diagnostic ? (test_id.includes('26')
        ? definitions[0].diagnostic_path : definitions[1].diagnostic_path) : null,
      retrieval_evidence_sha256: diagnostic ? hash(JSON.stringify(diagnostic)) : null,
      expected_blank_must_remain_unknown: test_id === 'XH26-D03' || test_id === 'XH27-D05',
    };
  });
  const userApp = await api(`/searches/${userAppID}`);
  assert.equal(userApp.search_config.use_rerank, true);
  const frozen = {
    scope: 'Local formal-answer/citation boundary audit for the two already-imported XH documents; not final 70-question regression or independent holdout.',
    documents,
    parameters: {
      top_k: 128,
      rerank_candidates_count: 64,
      rerank_id: userApp.search_config.rerank_id,
      use_rerank: true,
      use_kg: false,
      keyword: false,
      similarity_threshold: 0.1,
      keywords_similarity_weight: 0.5,
      temperature: 0.1,
    },
    chat_model_id: '102e9861e4e24a73abb7cff80df6c52e',
    questions: frozenQuestions,
  };
  const old = await optional(inputPath, null);
  if (old) assert.equal(hash(JSON.stringify(old)), hash(JSON.stringify(frozen)), 'Frozen audit inputs changed');
  else await save(inputPath, frozen);
  const manifest = await optional(manifestPath, {
    started_at: new Date().toISOString(),
    input_sha256: hash(JSON.stringify(frozen)),
    user_app_before_sha256: hash(JSON.stringify(userApp)),
  });
  assert.equal(manifest.input_sha256, hash(JSON.stringify(frozen)));
  assert.equal(manifest.user_app_before_sha256, hash(JSON.stringify(userApp)),
    'Existing user search application changed since audit freeze');
  await save(manifestPath, manifest);
  console.log(JSON.stringify({
    frozen: frozen.questions.length,
    answerable: frozen.questions.filter(item => item.answerable_from_library).length,
    no_evidence: frozen.questions.filter(item => !item.answerable_from_library).length,
    points: frozen.questions.reduce((count, item) => count + item.expected.length, 0),
  }, null, 2));
}

async function configureApp() {
  const input = await load(inputPath);
  const manifest = await load(manifestPath);
  assert.equal(manifest.input_sha256, hash(JSON.stringify(input)));
  const datasetIDs = [...new Set(input.documents.map(item => item.dataset_id))];
  const name = '铁路正式XH两篇回答引用审计';
  if (!manifest.audit_search_id) {
    const matches = (await api('/searches')).search_apps?.filter(item => item.name === name) || [];
    assert.ok(matches.length <= 1);
    manifest.audit_search_id = matches[0]?.id
      || (await api('/searches', 'POST', {
        name,
        description: 'DOC0026/27正式XH库局部回答、引用和无证据边界审计，不构成最终回归。',
      })).search_id;
    await save(manifestPath, manifest);
  }
  const config = {
    kb_ids: datasetIDs,
    chat_id: input.chat_model_id,
    top_k: input.parameters.top_k,
    rerank_candidates_count: input.parameters.rerank_candidates_count,
    rerank_id: input.parameters.rerank_id,
    use_rerank: true,
    use_kg: false,
    keyword: false,
    similarity_threshold: input.parameters.similarity_threshold,
    keywords_similarity_weight: input.parameters.keywords_similarity_weight,
    llm_setting: { temperature: input.parameters.temperature, temperature_enabled: true },
  };
  await api(`/searches/${manifest.audit_search_id}`, 'PUT', { name, search_config: config });
  const current = await api(`/searches/${manifest.audit_search_id}`);
  for (const [key, value] of Object.entries(config)) {
    assert.deepEqual(current.search_config[key], value, `Audit app config mismatch: ${key}`);
  }
  manifest.audit_app_sha256 = hash(JSON.stringify(current));
  manifest.dataset_ids = datasetIDs;
  await save(manifestPath, manifest);
  console.log(JSON.stringify({ audit_search_id: manifest.audit_search_id, datasets: datasetIDs }));
}

async function generateAnswers(selected) {
  const input = await load(inputPath);
  const manifest = await load(manifestPath);
  assert.equal(manifest.input_sha256, hash(JSON.stringify(input)));
  assert.ok(manifest.audit_search_id);
  const answers = await optional(`${folder}/answers.json`, []);
  for (const question of input.questions.filter(item => !selected.length || selected.includes(item.test_id))) {
    const index = answers.findIndex(item => item.test_id === question.test_id);
    const previous = answers[index];
    if (previous?.final_received && !previous.errors.length) continue;
    if (previous) assert.ok(selected.includes(question.test_id), 'Select failed question explicitly to retry');
    const attempt = (previous?.attempt || 0) + 1;
    const response = await api(`/searches/${manifest.audit_search_id}/completions`, 'POST', {
      question: question.question,
      kb_ids: manifest.dataset_ids,
    }, true);
    const raw = await response.text();
    const rawPath = `${folder}/answers/${question.test_id}${attempt > 1 ? `-attempt-${attempt}` : ''}.sse`;
    await save(rawPath, raw);
    const events = raw.split(/\r?\n/u).filter(line => line.startsWith('data: ')
      && line.slice(6) !== '[DONE]').map(line => JSON.parse(line.slice(6)));
    const final = events.findLast(event => event.data?.final === true);
    const errors = events.filter(event => event.code !== 0).map(event => event.message);
    const answer = {
      test_id: question.test_id,
      checked_at: new Date().toISOString(),
      raw_path: rawPath,
      final_received: Boolean(final),
      answer: final?.data?.answer || '',
      reference: final?.data?.reference || null,
      errors,
      attempt,
      semantic_and_citation_review: 'PENDING',
    };
    if (previous) answers[index] = { ...answer, prior_attempt: previous };
    else answers.push(answer);
    await save(`${folder}/answers.json`, answers);
    console.log(JSON.stringify({
      test_id: question.test_id,
      final: answer.final_received,
      answer_length: answer.answer.length,
      citations: answer.reference?.chunks?.length || 0,
      errors,
    }));
    assert.ok(answer.final_received && !errors.length, `Answer generation failed for ${question.test_id}`);
  }
  manifest.answers_finished_at = new Date().toISOString();
  await save(manifestPath, manifest);
  const userApp = await api(`/searches/${userAppID}`);
  assert.equal(hash(JSON.stringify(userApp)), manifest.user_app_before_sha256,
    'User search application changed during audit');
}

async function report() {
  const input = await load(inputPath);
  const answers = await load(`${folder}/answers.json`);
  const manifest = await load(manifestPath);
  assert.equal(manifest.input_sha256, hash(JSON.stringify(input)));
  const outcomes = [];
  for (const question of input.questions) {
    const answer = answers.find(item => item.test_id === question.test_id);
    assert.ok(answer?.final_received && !answer.errors.length, `Missing generated answer ${question.test_id}`);
    const refs = answer.reference?.chunks || [];
    const contextChecks = refs.map(chunk => {
      const doc = input.documents.find(item => item.document_id === chunk.document_id);
      const accepted = doc?.accepted_chunks.find(item => item.id === chunk.id);
      return {
        chunk_id: chunk.id,
        document_id: chunk.document_id,
        accepted_formal_chunk: Boolean(accepted),
        content_sha256: hash(chunk.content || ''),
        matched_expected_points: question.expected.filter(point => (chunk.content || '').includes(point.knowledge_point_id))
          .map(point => point.knowledge_point_id),
      };
    });
    assert.ok(contextChecks.every(item => item.accepted_formal_chunk),
      `Citation context is not a currently accepted formal chunk: ${question.test_id}`);
    outcomes.push({
      test_id: question.test_id,
      question: question.question,
      answerable_from_library: question.answerable_from_library,
      answer_sha256: hash(answer.answer),
      answer: answer.answer,
      raw_sse_path: answer.raw_path,
      raw_sse_sha256: hash(await readFile(path.join(root, answer.raw_path))),
      reference_sha256: hash(JSON.stringify(answer.reference)),
      context_checks: contextChecks,
      semantic_decision: 'PENDING_MANUAL_FULL_ANSWER_REVIEW',
    });
  }
  const reportData = {
    reviewed_at: new Date().toISOString(),
    scope: input.scope,
    input_sha256: manifest.input_sha256,
    audit_search_id: manifest.audit_search_id,
    document_bindings: input.documents.map(({ accepted_chunks, ...document }) => document),
    rerank_enabled: true,
    parameters: input.parameters,
    counts: {
      questions: outcomes.length,
      generated: outcomes.filter(item => item.raw_sse_sha256).length,
      answerable: outcomes.filter(item => item.answerable_from_library).length,
      no_evidence: outcomes.filter(item => !item.answerable_from_library).length,
      all_references_are_accepted_formal_chunks: true,
      semantic_acceptance: false,
      final_regression: false,
      independent_holdout: false,
    },
    outcomes,
  };
  await save(`${folder}/report.json`, reportData);
  console.log(JSON.stringify({ evidence: `${folder}/report.json`, counts: reportData.counts }, null, 2));
}

const [command, ...selected] = process.argv.slice(2);
if (command === 'freeze') await freeze();
else if (command === 'app') await configureApp();
else if (command === 'answers') await generateAnswers(selected);
else if (command === 'report') await report();
else throw Error('Use freeze, app, answers [test IDs...], or report');
