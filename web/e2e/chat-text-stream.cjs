const assert = require('node:assert/strict');
const http = require('node:http');
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
    assert.equal(envelope.code, 0, envelope.message);
    return envelope.data;
  };
  const chat = await request('POST', '/chats', {
    name: 'Isolated browser ordinary SSE reliability',
    dataset_ids: [],
    llm_id: model,
    llm_setting: { temperature: 0, max_tokens: 2048 },
    prompt_config: {
      system: '请按照用户的要求直接回答。',
      parameters: [],
      quote: true,
    },
  });
  const knowledgeChat = await request('POST', '/chats', {
    name: 'Isolated browser ordinary knowledge SSE',
    dataset_ids: [datasetId],
    llm_id: model,
    llm_setting: { temperature: 0, max_tokens: 512 },
    prompt_config: {
      system: '请根据知识库回答，保留来源引用。{knowledge}',
      parameters: [{ key: 'knowledge', optional: false }],
      quote: true,
    },
    similarity_threshold: 0,
  });
  // Forward real traffic unchanged; destroy only the selected active SSE
  // connection to exercise a transport failure rather than emulate a response.
  let activeStream;
  const proxy = http.createServer((incoming, outgoing) => {
    const upstream = http.request(
      new URL(incoming.url, origin),
      {
        method: incoming.method,
        headers: { ...incoming.headers, host: new URL(origin).host },
      },
      (response) => {
        outgoing.writeHead(response.statusCode, response.headers);
        response.pipe(outgoing);
        response.on('error', () => outgoing.destroy());
      },
    );
    upstream.on('error', () => outgoing.destroy());
    outgoing.on('close', () => upstream.destroy());
    if (
      incoming.method === 'POST' &&
      incoming.url === '/api/v1/chat/completions'
    ) {
      activeStream = { upstream, outgoing };
    }
    incoming.pipe(upstream);
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const browserOrigin = `http://127.0.0.1:${proxy.address().port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    await context.addInitScript(
      ({ authorization }) => {
        performance.setResourceTimingBufferSize(5000);
        localStorage.setItem('Authorization', authorization);
        localStorage.setItem('lng', 'zh');
      },
      { authorization: token },
    );
    const page = await context.newPage();
    const errors = [];
    const submissions = [];
    const transport = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('requestfailed', (request) => {
      if (new URL(request.url()).pathname === '/api/v1/chat/completions') {
        transport.push({
          event: 'failed',
          error: request.failure()?.errorText,
        });
      }
    });
    page.on('requestfinished', (request) => {
      if (new URL(request.url()).pathname === '/api/v1/chat/completions') {
        transport.push({ event: 'finished' });
      }
    });
    page.on('request', (request) => {
      if (
        new URL(request.url()).pathname === '/api/v1/chat/completions' &&
        request.method() === 'POST'
      ) {
        submissions.push(request.postDataJSON());
      }
    });
    const open = async (targetChat, name) => {
      const session = await request(
        'POST',
        `/chats/${targetChat.id}/sessions`,
        {
          name,
        },
      );
      await page.goto(
        `${browserOrigin}/chat/${targetChat.id}?conversationId=${session.id}`,
      );
      await page.getByTestId('chat-textarea').waitFor({ timeout: 90000 });
      // Read the actual application store without replacing any production
      // module, network response, SSE parser or generation implementation.
      await page.evaluate(async () => {
        const storeUrl = performance
          .getEntriesByType('resource')
          .map((entry) => entry.name)
          .reverse()
          .find((url) =>
            new URL(url).pathname.endsWith('/chat-stream/store.ts'),
          );
        if (!storeUrl) throw new Error('Application store module not loaded');
        const { useChatStreamStore } = await import(storeUrl);
        window.readChatStream = (id) =>
          useChatStreamStore.getState().sessions[id];
        window.chatStreamSessionIds = () =>
          Object.keys(useChatStreamStore.getState().sessions);
      });
      try {
        await page.waitForFunction(
          (id) => Boolean(window.readChatStream(id)),
          session.id,
          { timeout: 15000 },
        );
      } catch (error) {
        console.log('Session store diagnostics', {
          sessionId: session.id,
          url: page.url(),
          stores: await page.evaluate(() => window.chatStreamSessionIds()),
        });
        throw error;
      }
      return session;
    };
    const begin = async (question) => {
      await page.getByTestId('chat-textarea').fill(question);
      const response = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/v1/chat/completions' &&
          response.request().method() === 'POST',
        { timeout: 90000 },
      );
      await page.getByTestId('chat-detail-send').click();
      return { response };
    };
    const normal = async (targetChat, question, expected, citations) => {
      const session = await open(targetChat, citations ? 'Knowledge' : 'Plain');
      const before = submissions.length;
      const { response } = await begin(question);
      const actual = await response;
      assert.equal(actual.status(), 200);
      const events = [];
      createParser((event) => {
        if (event.type === 'event') events.push(JSON.parse(event.data));
      }).feed(await actual.text());
      assert.ok(events.some((event) => event.data === true));
      events.forEach((event) => assert.equal(event.code, 0, event.message));
      await page.getByTestId('chat-detail-send').waitFor();
      assert.equal(await page.getByTestId('chat-textarea').inputValue(), '');
      assert.equal(submissions.length - before, 1);
      const saved = await request(
        'GET',
        `/chats/${targetChat.id}/sessions/${session.id}?include_reference=true`,
      );
      const turnId = submissions.at(-1).messages[0].id;
      const answer = saved.messages.find(
        (message) => message.role === 'assistant' && message.id === turnId,
      );
      for (const text of expected) assert.ok(answer?.content.includes(text));
      if (citations) assert.ok(answer.reference?.chunks?.length > 0);
      await page.reload();
      await page.getByTestId('chat-textarea').waitFor();
      for (const text of expected)
        await page.getByText(text, { exact: false }).last().waitFor();
      console.log(
        'PASS ordinary browser SSE -> explicit completion -> saved answer -> refresh',
        {
          sessionId: session.id,
          citations,
        },
      );
    };
    await normal(chat, '请只回复：普通流验收通过。', ['普通流验收通过'], false);
    await normal(
      knowledgeChat,
      '青禾项目的验收暗号和负责人分别是什么？根据资料简短回答并标注来源。',
      ['山海同行', '林悦'],
      true,
    );

    for (const kind of ['disconnect', 'stop']) {
      const session = await open(chat, kind);
      const before = submissions.length;
      const question = '请用中文解释定期备份的重要性，并给出三个简单建议。';
      await begin(question);
      try {
        await page.waitForFunction(
          (id) => {
            const session = window.readChatStream(id);
            return (
              session?.isStreaming &&
              session.messages.at(-1)?.role === 'assistant' &&
              session.messages.at(-1).content.length >= 60
            );
          },
          session.id,
          { timeout: 45000, polling: 25 },
        );
      } catch (error) {
        console.log('Stream start diagnostics', {
          kind,
          session: await page.evaluate((id) => {
            const session = window.readChatStream(id);
            return {
              isStreaming: session?.isStreaming,
              messages: session?.messages.map((message) => ({
                role: message.role,
                content: message.content?.slice(0, 100),
              })),
            };
          }, session.id),
          submissions: submissions.length - before,
          transport,
          errors: await page
            .locator('[data-sonner-toast][data-type="error"]')
            .allTextContents(),
        });
        throw error;
      }
      const prefix = await page.evaluate(
        (id) => window.readChatStream(id).messages.at(-1).content.slice(0, 50),
        session.id,
      );
      if (kind === 'disconnect') {
        assert.ok(activeStream && !activeStream.outgoing.writableEnded);
        activeStream.outgoing.destroy();
        activeStream.upstream.destroy();
      } else {
        await page.getByTestId('chat-stream-status').click();
      }
      await page.waitForFunction(
        (id) => window.readChatStream(id)?.isStreaming === false,
        session.id,
        { timeout: 15000 },
      );
      const partial = await page.evaluate(
        (id) => window.readChatStream(id).messages.at(-1)?.content,
        session.id,
      );
      assert.ok(
        partial?.startsWith(prefix),
        'Already received text is retained',
      );
      if (kind === 'disconnect') {
        try {
          await page.waitForFunction(
            (expected) =>
              document.querySelector('[data-testid="chat-textarea"]')?.value ===
              expected,
            question,
            { timeout: 5000 },
          );
        } catch (error) {
          console.log('Disconnection recovery diagnostics', {
            session: await page.evaluate((id) => {
              const session = window.readChatStream(id);
              return {
                isStreaming: session?.isStreaming,
                pendingInput: session?.pendingInput,
                messages: session?.messages.map((message) => ({
                  role: message.role,
                  id: message.id,
                  content: message.content?.slice(0, 80),
                })),
              };
            }, session.id),
            input: await page.getByTestId('chat-textarea').inputValue(),
            errors: await page
              .locator('[data-sonner-toast][data-type="error"]')
              .allTextContents(),
            transport,
            submissions: submissions.length - before,
          });
          throw error;
        }
        assert.ok(
          await page.locator('[data-sonner-toast][data-type="error"]').count(),
        );
      } else {
        assert.equal(await page.getByTestId('chat-textarea').inputValue(), '');
        assert.equal(
          await page.locator('[data-sonner-toast][data-type="error"]').count(),
          0,
        );
      }
      // Allow two actual authoritative polls; a retained partial answer must
      // survive background refresh rather than only the first render.
      for (let poll = 0; poll < 2; poll++) {
        await page.waitForResponse((response) =>
          new URL(response.url()).pathname.endsWith(`/sessions/${session.id}`),
        );
      }
      const afterPoll = await page.evaluate(
        (id) => window.readChatStream(id).messages.at(-1)?.content,
        session.id,
      );
      assert.ok(
        afterPoll?.startsWith(prefix),
        `${kind}: refresh erased received text`,
      );
      if (kind === 'disconnect') {
        assert.equal(
          await page.getByTestId('chat-textarea').inputValue(),
          question,
          'Interrupted question remains available after session refresh',
        );
      }
      assert.equal(
        submissions.length - before,
        1,
        'No automatic generation replay',
      );
      console.log('PASS real browser ordinary stream interruption', {
        kind,
        sessionId: session.id,
        retainedCharacters: afterPoll.length,
        noAutomaticReplay: true,
      });
    }
    assert.deepEqual(errors, []);
    await page.screenshot({
      path: path.join(
        process.env.RAGFLOW_TEST_SCREENSHOTS,
        'chat-text-stream.png',
      ),
    });
  } finally {
    await browser.close();
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
  }
}

main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
