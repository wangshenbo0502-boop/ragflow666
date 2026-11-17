const assert = require('node:assert/strict');
const path = require('node:path');
const { createParser } = require('eventsource-parser');
const { chromium } = require(
  process.env.RAGFLOW_TEST_PLAYWRIGHT || 'playwright',
);

async function main() {
  const origin = process.env.RAGFLOW_TEST_WEB_ORIGIN;
  const api = process.env.RAGFLOW_TEST_CHAT_API;
  const token = process.env.RAGFLOW_TEST_CHAT_TOKEN;
  const datasetId = process.env.RAGFLOW_TEST_CHAT_DATASET;
  const model = process.env.RAGFLOW_TEST_CHAT_MODEL;
  assert.equal(origin, 'http://127.0.0.1:19222');
  assert.equal(api, 'http://127.0.0.1:19380');
  assert.ok(
    token && datasetId && model,
    'Requires isolated test configuration',
  );
  const request = async (method, url, body) => {
    const response = await fetch(`${api}/api/v1${url}`, {
      method,
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(response.status, 200, url);
    const envelope = await response.json();
    assert.equal(envelope.code, 0, `${url}: ${envelope.message}`);
    return envelope.data;
  };
  const control = async (body = {}) => {
    const response = await fetch('http://127.0.0.1:19980/control', {
      method: 'POST',
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const waitFor = async (read, ready, label) => {
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const current = await read();
      if (ready(current)) return current;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.fail(`Timed out: ${label}`);
  };
  const taskDetail = (id) => request('GET', `/chats/tasks/${id}`);
  const terminalTask = (id) =>
    waitFor(
      () => taskDetail(id),
      ({ task }) =>
        ['succeeded', 'partial_succeeded', 'failed', 'cancelled'].includes(
          task.state,
        ),
      `terminal task ${id}`,
    );
  const chat = await request('POST', '/chats', {
    name: 'Isolated two-tab answer version retry',
    dataset_ids: [datasetId],
    llm_id: model,
    llm_setting: { temperature: 0, max_tokens: 1024 },
    prompt_config: {
      system: '请根据知识库回答，保留来源引用。{knowledge}',
      parameters: [{ key: 'knowledge', optional: false }],
      quote: true,
    },
    similarity_threshold: 0,
  });
  const session = await request('POST', `/chats/${chat.id}/sessions`, {
    name: 'Two tabs retry one answer revision',
  });
  const sessionPath = `/chats/${chat.id}/sessions/${session.id}?include_reference=true`;
  const before = await control();
  assert.equal(before.holding, 0, 'Another test owns the TTS gate');
  const browser = await chromium.launch({ headless: true });
  try {
    await control({ fail_next: 1, hold_next: 0 });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    await context.addInitScript(
      ({ authorization }) => {
        localStorage.setItem('Authorization', authorization);
        localStorage.setItem('lng', 'zh');
      },
      { authorization: token },
    );
    const pages = await Promise.all([context.newPage(), context.newPage()]);
    const errors = [];
    const submissions = [];
    for (const page of pages) {
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('request', (outgoing) => {
        if (
          new URL(outgoing.url()).pathname === '/api/v1/chat/completions' &&
          outgoing.method() === 'POST'
        ) {
          submissions.push(outgoing.postDataJSON());
        }
      });
      await page.goto(`${origin}/chat/${chat.id}?conversationId=${session.id}`);
      await page.getByTestId('chat-textarea').waitFor({ timeout: 90000 });
    }
    const first = pages[0];
    await first.getByRole('button', { name: '语音回答', exact: true }).click();
    await first
      .getByTestId('chat-textarea')
      .fill(
        '青禾项目的验收暗号和负责人分别是什么？请根据资料简短回答并标注来源。',
      );
    const admission = first.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/chat/completions' &&
        response.request().method() === 'POST',
    );
    await first.getByTestId('chat-detail-send').click();
    const events = [];
    createParser((event) => {
      if (event.type === 'event') events.push(JSON.parse(event.data));
    }).feed(await (await admission).text());
    const admitted = events.find((event) => event.data?.task_id)?.data;
    assert.ok(
      admitted?.accepted && admitted.task_id,
      'Durable acknowledgement',
    );
    const original = await terminalTask(admitted.task_id);
    assert.equal(original.task.state, 'partial_succeeded');
    assert.deepEqual(original.retry_stages, ['audio']);
    const oldAnswer = original.task.outputs.answer;
    assert.ok(oldAnswer.content.includes('山海同行'));
    assert.ok(oldAnswer.content.includes('林悦'));
    assert.ok(oldAnswer.reference?.chunks?.length > 0);
    assert.ok(oldAnswer.answer_version >= 1);

    for (const page of pages) {
      await page.getByRole('button', { name: '任务中心', exact: true }).click();
      const sheet = page.getByRole('dialog');
      await sheet.locator(`[data-task-id="${original.task.id}"]`).click();
      await sheet
        .getByRole('button', { name: '重试音频', exact: true })
        .waitFor();
    }
    await control({ fail_next: 0, hold_next: 1 });
    const retryPath = `/api/v1/chats/tasks/${original.task.id}/retry`;
    const responses = pages.map((page) =>
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === retryPath &&
          response.request().method() === 'POST',
      ),
    );
    // Both real buttons submit the same original task revision. Only the
    // external TTS response is delayed; no application response is replaced.
    await Promise.all(
      pages.map((page) =>
        page.getByRole('button', { name: '重试音频', exact: true }).click(),
      ),
    );
    const retries = await Promise.all(
      responses.map(async (responsePromise) => {
        const response = await responsePromise;
        assert.equal(response.status(), 200);
        const envelope = await response.json();
        assert.equal(envelope.code, 0, envelope.message);
        assert.equal(
          response.request().postDataJSON().revision,
          original.task.revision,
        );
        return envelope.data;
      }),
    );
    assert.equal(retries[0].id, retries[1].id, 'Two tabs reuse one retry');
    const held = await waitFor(
      () => control(),
      (counts) =>
        counts.ready === 1 && counts.forwarded === before.forwarded + 1,
      'real synthesized TTS response held before publication',
    );
    assert.equal(held.rejected, before.rejected + 1);
    const list = await request(
      'GET',
      `/chats/tasks?session_id=${session.id}&page=1&page_size=100`,
    );
    assert.equal(list.total, 2, 'Original task plus one deduplicated retry');
    const during = await request('GET', sessionPath);
    const answerAt = (saved) =>
      saved.messages.find(
        (message) =>
          message.role === 'assistant' && message.id === original.task.turn_id,
      );
    assert.equal(answerAt(during).answer_version, oldAnswer.answer_version);
    assert.deepEqual(answerAt(during).reference, oldAnswer.reference);
    await control({ release: true, hold_next: 0 });
    const completed = await terminalTask(retries[0].id);
    assert.equal(completed.task.state, 'succeeded');
    assert.equal(
      completed.attempts.length,
      1,
      'Retry never repeats the answer',
    );
    assert.equal(completed.attempts[0].stage, 'audio');
    assert.deepEqual((await taskDetail(original.task.id)).task, original.task);
    const answer = answerAt(await request('GET', sessionPath));
    assert.equal(answer.answer_version, oldAnswer.answer_version + 1);
    assert.deepEqual(answer.reference, oldAnswer.reference);
    assert.ok(answer.content.startsWith(oldAnswer.content));
    assert.equal(answer.media_assets.length, 1);
    assert.equal(answer.media_assets[0].kind, 'audio');
    const currentDetail = await taskDetail(original.task.id);
    assert.equal(currentDetail.can_retry, false);
    assert.equal(currentDetail.retry_disabled_reason, 'revision_conflict');
    for (const [index, page] of pages.entries()) {
      await page.keyboard.press('Escape');
      await page.reload();
      await page
        .getByRole('button', { name: '播放语音', exact: true })
        .waitFor({
          timeout: 30000,
        });
      await page.getByText('山海同行', { exact: false }).last().waitFor();
      await page.getByText('林悦', { exact: false }).last().waitFor();
      await page.getByRole('button', { name: '任务中心', exact: true }).click();
      const detail = page.getByRole('dialog');
      await detail.locator(`[data-task-id="${original.task.id}"]`).click();
      await detail
        .getByText('暂不能重试：回答已更新，不能重试旧版本', { exact: true })
        .waitFor();
      assert.equal(
        await detail
          .getByRole('button', { name: '重试音频', exact: true })
          .count(),
        0,
        'Both tabs follow the backend answer-version retry restriction',
      );
      await page.screenshot({
        path: path.join(
          process.env.RAGFLOW_TEST_SCREENSHOTS,
          `chat-answer-version-tab-${index + 1}.png`,
        ),
      });
    }
    const after = await control();
    assert.equal(after.forwarded, before.forwarded + 1);
    assert.equal(after.completed, before.completed + 1);
    assert.equal(after.rejected, before.rejected + 1);
    assert.equal(submissions.length, 1, 'Neither tab repeats grounded Q&A');
    assert.deepEqual(errors, []);
    console.log('PASS real two-tab failed-audio retry deduplicated', {
      taskId: original.task.id,
      retryId: retries[0].id,
      answerVersions: [oldAnswer.answer_version, answer.answer_version],
      realTTS: 1,
      groundedSubmissions: 1,
      originalTerminalUnchanged: true,
      citationsPreservedAfterBothTabsRefresh: true,
      staleRetryDisabledInBothTabs: true,
    });
  } finally {
    await control({ release: true, hold_next: 0, fail_next: 0 });
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
