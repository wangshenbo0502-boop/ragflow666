const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { createParser } = require('eventsource-parser');
const { chromium } = require(
  process.env.RAGFLOW_TEST_PLAYWRIGHT || 'playwright',
);

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function main() {
  const origin = process.env.RAGFLOW_TEST_WEB_ORIGIN;
  const api = process.env.RAGFLOW_TEST_CHAT_API;
  const token = process.env.RAGFLOW_TEST_CHAT_TOKEN;
  const model = process.env.RAGFLOW_TEST_CHAT_MODEL;
  assert.equal(origin, 'http://127.0.0.1:19222');
  assert.equal(api, 'http://127.0.0.1:19380');
  assert.ok(token && model, 'Requires isolated test configuration');
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
  const chat = await request('POST', '/chats', {
    name: 'Isolated browser attachment lifecycle',
    dataset_ids: [],
    llm_id: model,
    llm_setting: { temperature: 0, max_tokens: 512 },
    prompt_config: {
      system: '根据用户提供的附件回答；不要猜测附件中未提供的信息。',
      parameters: [],
      quote: true,
    },
  });
  const sessions = [];
  for (const name of [
    'Retry order',
    'Remove pending',
    'Late upload source',
    'Late upload destination',
  ]) {
    sessions.push(
      await request('POST', `/chats/${chat.id}/sessions`, { name }),
    );
  }
  const browser = await chromium.launch({ headless: true });
  const holds = new Map();
  try {
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
    const page = await context.newPage();
    const errors = [];
    const uploads = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let failFirst = true;
    await page.route('**/api/v1/documents/upload', async (route) => {
      const incoming = route.request();
      const form = await new Response(incoming.postDataBuffer(), {
        headers: { 'Content-Type': incoming.headers()['content-type'] },
      }).formData();
      const name = form.get('file').name;
      const sessionId = form.get('conversation_id');
      if (name === 'A.txt' && failFirst) {
        failFirst = false;
        uploads.push({ name, sessionId, networkFailure: true });
        await route.abort('failed');
        return;
      }
      // Forward to the real Go upload/parser and MinIO. Only delivery timing
      // changes; successful upload responses are never fabricated.
      const response = await route.fetch({ timeout: 30000 });
      const envelope = await response.json();
      assert.equal(response.status(), 200);
      assert.equal(envelope.code, 0, envelope.message);
      uploads.push({ name, sessionId, id: envelope.data.id });
      const hold = holds.get(name);
      if (hold) {
        hold.received.resolve(envelope.data);
        await hold.release.promise;
      }
      try {
        await route.fulfill({ response });
      } finally {
        hold?.finished.resolve();
      }
    });
    const open = async (session) => {
      await page.goto(`${origin}/chat/${chat.id}?conversationId=${session.id}`);
      await page.getByTestId('chat-textarea').waitFor({ timeout: 90000 });
      await page.waitForFunction(
        (id) =>
          document.querySelector(
            `[data-testid="chat-detail-session-item"][data-session-id="${id}"]`,
          ) !== null,
        session.id,
      );
    };
    const file = (name, content) => ({
      name,
      mimeType: 'text/plain',
      buffer: Buffer.from(content),
    });
    const send = async (question, session) => {
      await page.getByTestId('chat-textarea').fill(question);
      await page.waitForFunction(
        () =>
          !document.querySelector('[data-testid="chat-detail-send"]')?.disabled,
      );
      const pendingResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/v1/chat/completions' &&
          response.request().method() === 'POST',
        { timeout: 90000 },
      );
      await page.getByTestId('chat-detail-send').click();
      const response = await pendingResponse;
      assert.equal(response.status(), 200);
      const submitted = response.request().postDataJSON();
      assert.equal(submitted.session_id, session.id);
      const stream = await response.text();
      const events = [];
      createParser((event) => {
        if (event.type === 'event') events.push(JSON.parse(event.data));
      }).feed(stream);
      assert.ok(
        events.some((event) => event.data === true),
        'Real SSE completed explicitly',
      );
      for (const event of events) {
        assert.equal(event.code, 0, event.message);
      }
      const saved = await request(
        'GET',
        `/chats/${chat.id}/sessions/${session.id}?include_reference=true`,
      );
      const turnId = submitted.messages[0].id;
      const questionMessage = saved.messages.find(
        (message) => message.role === 'user' && message.id === turnId,
      );
      const answer = saved.messages.find(
        (message) => message.role === 'assistant' && message.id === turnId,
      );
      assert.ok(questionMessage && answer?.content, 'Real turn is persisted');
      return { submitted, questionMessage, answer };
    };
    const previews = page.locator('[data-slot="file-upload-item"]');
    const input = page.locator('input[type="file"]');
    const firstSecret = `FIRST_${randomBytes(6).toString('hex')}`;
    const secondSecret = `SECOND_${randomBytes(6).toString('hex')}`;
    await open(sessions[0]);
    const secondUpload = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/documents/upload' &&
        response.request().postDataBuffer().includes(Buffer.from('B.txt')),
    );
    await input.setInputFiles([
      file('A.txt', `第一份材料的暗号为 ${firstSecret}。`),
      file('B.txt', `第二份材料的暗号为 ${secondSecret}。`),
    ]);
    assert.equal((await secondUpload).status(), 200);
    await page.getByRole('button', { name: '重新上传', exact: true }).waitFor();
    assert.equal(await page.getByTestId('chat-detail-send').isDisabled(), true);
    assert.deepEqual(
      await previews
        .locator('[data-slot="file-upload-metadata"] > span[title]')
        .allTextContents(),
      ['A.txt', 'B.txt'],
    );
    await page.getByRole('button', { name: '重新上传', exact: true }).click();
    await page.waitForFunction(
      () =>
        !document.querySelector('[aria-label="重新上传"]') &&
        !document.querySelector('[data-testid="chat-detail-send"]')?.disabled,
    );
    const order = await send(
      '请严格按第一份、第二份的顺序列出两个附件中的暗号。',
      sessions[0],
    );
    assert.deepEqual(
      order.submitted.messages[0].files.map((item) => item.name),
      ['A.txt', 'B.txt'],
    );
    assert.deepEqual(
      order.questionMessage.files.map((item) => item.name),
      ['A.txt', 'B.txt'],
    );
    assert.ok(
      order.answer.content.includes(firstSecret) &&
        order.answer.content.includes(secondSecret),
      'Real model read both uploaded attachments',
    );
    assert.ok(
      order.answer.content.indexOf(firstSecret) <
        order.answer.content.indexOf(secondSecret),
      'Answer preserves selected attachment order',
    );
    assert.deepEqual(
      uploads.slice(0, 3).map((item) => item.name),
      ['A.txt', 'B.txt', 'A.txt'],
    );
    console.log(
      'PASS browser failed A -> real B upload -> real A retry -> A/B request and saved order -> real model reads both',
      { sessionId: sessions[0].id },
    );

    const removed = {
      received: deferred(),
      release: deferred(),
      finished: deferred(),
    };
    holds.set('remove-pending.txt', removed);
    await open(sessions[1]);
    await input.setInputFiles(
      file(
        'remove-pending.txt',
        'This attachment is removed before upload delivery.',
      ),
    );
    const removedResource = await removed.received.promise;
    await page
      .getByRole('button', { name: '删除 remove-pending.txt', exact: true })
      .click();
    removed.release.resolve();
    await removed.finished.promise;
    const withoutRemoved = await send('请只回复：附件已移除。', sessions[1]);
    assert.equal(await previews.count(), 0);
    assert.equal(withoutRemoved.submitted.messages[0].files.length, 0);
    assert.equal(withoutRemoved.questionMessage.files?.length ?? 0, 0);
    console.log(
      'PASS real upload completes after UI removal; next request and saved turn have no attachment',
      { sessionId: sessions[1].id, removedUploadId: removedResource.id },
    );

    const late = {
      received: deferred(),
      release: deferred(),
      finished: deferred(),
    };
    holds.set('late-source.txt', late);
    await open(sessions[2]);
    await input.setInputFiles(
      file(
        'late-source.txt',
        'This upload belongs only to the previous session.',
      ),
    );
    const lateResource = await late.received.promise;
    await page
      .locator(
        `[data-testid="chat-detail-session-item"][data-session-id="${sessions[3].id}"]`,
      )
      .click();
    await page.waitForURL(
      (url) => url.searchParams.get('conversationId') === sessions[3].id,
    );
    late.release.resolve();
    await late.finished.promise;
    const newSession = await send('请只回复：这是一个新会话。', sessions[3]);
    assert.equal(await previews.count(), 0);
    assert.equal(newSession.submitted.messages[0].files.length, 0);
    assert.equal(newSession.questionMessage.files?.length ?? 0, 0);
    assert.equal(
      await page.getByRole('button', { name: '重新上传', exact: true }).count(),
      0,
    );
    const source = await request(
      'GET',
      `/chats/${chat.id}/sessions/${sessions[2].id}`,
    );
    assert.equal(
      source.messages.filter((message) => message.role === 'user').length,
      0,
    );
    assert.equal(
      uploads.find((item) => item.name === 'late-source.txt').sessionId,
      sessions[2].id,
    );
    assert.equal(errors.length, 0, errors.join('\n'));
    await page.screenshot({
      path: path.join(
        process.env.RAGFLOW_TEST_SCREENSHOTS,
        'chat-attachment-lifecycle.png',
      ),
    });
    console.log(
      'PASS real source upload delivered after session switch; destination has no attachment or stale error',
      {
        sourceSessionId: sessions[2].id,
        destinationSessionId: sessions[3].id,
        sourceUploadId: lateResource.id,
      },
    );
  } finally {
    for (const hold of holds.values()) hold.release.resolve();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
