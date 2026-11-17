const assert = require('node:assert/strict');
const path = require('node:path');
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
  const chat = await request('POST', '/chats', {
    name: 'Isolated browser task acknowledgement',
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
  const browser = await chromium.launch({ headless: true });
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
    const generationRequests = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (
        request.method() === 'POST' &&
        ['/api/v1/chat/completions', '/api/v1/chat/audio/speech'].includes(
          url.pathname,
        )
      ) {
        generationRequests.push(url.pathname);
      }
    });
    const measurements = [];
    for (const [name, width, height] of [
      ['desktop', 1440, 1000],
      ['mobile', 390, 844],
    ]) {
      const session = await request('POST', `/chats/${chat.id}/sessions`, {
        name: `Browser acknowledgement ${name}`,
      });
      await page.setViewportSize({ width, height });
      const initialList = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === '/api/v1/chats/tasks' &&
          url.searchParams.get('session_id') === session.id
        );
      });
      await page.goto(`${origin}/chat/${chat.id}?conversationId=${session.id}`);
      await initialList;
      await page.getByTestId('chat-textarea').waitFor({ timeout: 90000 });
      await page.getByRole('button', { name: '语音回答', exact: true }).click();
      await page
        .getByTestId('chat-textarea')
        .fill(
          '青禾项目的验收暗号和负责人分别是什么？请根据资料简短回答并标注来源。',
        );
      // Align the click just after a real list response, so a polling-only UI
      // cannot pass merely because its next scheduled poll happened to be near.
      await page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === '/api/v1/chats/tasks' &&
          url.searchParams.get('session_id') === session.id
        );
      });
      await page.evaluate(() => {
        window.taskAcceptance = {};
        const checkStatus = () => {
          const measurement = window.taskAcceptance;
          if (!measurement.clickedAt || measurement.elapsedMs !== undefined)
            return;
          const status = [...document.querySelectorAll('[role="status"]')].find(
            (element) =>
              /^(排队中|执行中|正在取消)\s*·/.test(
                element.textContent.trim(),
              ) && element.getClientRects().length > 0,
          );
          if (status) {
            measurement.elapsedMs = performance.now() - measurement.clickedAt;
            measurement.text = status.textContent.trim();
            observer.disconnect();
          }
        };
        const observer = new MutationObserver(checkStatus);
        observer.observe(document.body, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
        });
        document.addEventListener(
          'click',
          (event) => {
            if (event.target.closest('[data-testid="chat-detail-send"]')) {
              window.taskAcceptance.clickedAt = performance.now();
              checkStatus();
            }
          },
          { capture: true, once: true },
        );
      });
      await page.getByTestId('chat-detail-send').click();
      await page.waitForFunction(
        () => window.taskAcceptance.elapsedMs !== undefined,
        undefined,
        { timeout: 15000 },
      );
      const measurement = await page.evaluate(() => window.taskAcceptance);
      const listPath = `/chats/tasks?session_id=${session.id}&page=1&page_size=100`;
      let listed = await request('GET', listPath);
      assert.equal(
        listed.tasks.length,
        1,
        'Exactly one real task was accepted',
      );
      const id = listed.tasks[0].id;
      assert.equal(listed.tasks[0].session_id, session.id);
      await page.screenshot({
        path: path.join(
          process.env.RAGFLOW_TEST_SCREENSHOTS,
          `chat-task-acceptance-${name}.png`,
        ),
      });
      const deadline = Date.now() + 180000;
      while (
        !['succeeded', 'partial_succeeded', 'failed', 'cancelled'].includes(
          listed.tasks[0].state,
        ) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        listed = await request('GET', listPath);
      }
      assert.equal(
        listed.tasks[0].state,
        'succeeded',
        JSON.stringify({
          taskId: id,
          state: listed.tasks[0].state,
          error: listed.tasks[0].error_code,
        }),
      );
      const saved = await request(
        'GET',
        `/chats/${chat.id}/sessions/${session.id}?include_reference=true`,
      );
      const answer = saved.messages.find(
        (message) =>
          message.role === 'assistant' &&
          message.id === listed.tasks[0].turn_id,
      );
      assert.ok(answer?.content.includes('山海同行'));
      assert.ok(answer?.content.includes('林悦'));
      assert.ok(
        answer.reference?.chunks?.length > 0,
        'Saved answer has citations',
      );
      await page.reload();
      await page
        .getByRole('button', { name: '播放语音', exact: true })
        .waitFor({
          timeout: 30000,
        });
      const generatedBeforePlayback = [...generationRequests];
      const readButton = page.getByRole('button', {
        name: '朗读内容',
        exact: true,
      });
      const savedAudio = answer.media_assets?.find(
        (asset) => asset.kind === 'audio',
      );
      assert.ok(
        savedAudio?.url,
        'Answer retains its structured audio resource',
      );
      const readResponse = page.waitForResponse((response) =>
        response.url().endsWith(savedAudio.url),
      );
      await readButton.click();
      assert.equal((await readResponse).status(), 200);
      await page.waitForFunction(() =>
        [...document.querySelectorAll('audio:not([aria-label])')].some(
          (audio) =>
            !audio.paused && audio.currentTime > 0 && audio.duration > 0,
        ),
      );
      const playerResponse = page.waitForResponse((response) =>
        response.url().endsWith(savedAudio.url),
      );
      await page.getByRole('button', { name: '播放语音', exact: true }).click();
      assert.equal((await playerResponse).status(), 200);
      await page.waitForFunction(() => {
        const audio = document.querySelector('audio[aria-label="语音"]');
        return (
          audio &&
          !audio.paused &&
          audio.currentTime > 0 &&
          [...document.querySelectorAll('audio:not([aria-label])')].every(
            (other) => other.paused,
          ) &&
          [...document.querySelectorAll('audio')].filter(
            (other) => !other.paused,
          ).length === 1
        );
      });
      const repeatedRead = page.waitForResponse((response) =>
        response.url().endsWith(savedAudio.url),
      );
      await readButton.click();
      assert.equal((await repeatedRead).status(), 200);
      await page.waitForFunction(() => {
        const player = document.querySelector('audio[aria-label="语音"]');
        return (
          player?.paused &&
          [...document.querySelectorAll('audio:not([aria-label])')].some(
            (other) => !other.paused && other.currentTime > 0,
          ) &&
          [...document.querySelectorAll('audio')].filter(
            (other) => !other.paused,
          ).length === 1
        );
      });
      await readButton.click();
      await page.waitForFunction(() =>
        [...document.querySelectorAll('audio')].every((audio) => audio.paused),
      );
      assert.deepEqual(
        generationRequests,
        generatedBeforePlayback,
        'Read/play switching reuses saved audio without TTS or generation POSTs',
      );
      const bounds = await page.evaluate(() => ({
        viewport: innerWidth,
        width: document.documentElement.scrollWidth,
      }));
      assert.ok(bounds.width <= bounds.viewport, JSON.stringify(bounds));
      measurements.push({
        viewport: name,
        taskId: id,
        elapsedMs: Math.ceil(measurement.elapsedMs),
        status: measurement.text,
        finalState: listed.tasks[0].state,
        savedAudioReused: true,
        playbackMutuallyExclusive: true,
      });
      console.log('Real browser task acknowledgement', measurements.at(-1));
    }
    assert.equal(errors.length, 0, errors.join('\n'));
    for (const measurement of measurements) {
      assert.ok(
        measurement.elapsedMs <= 1000,
        `${measurement.viewport}: actual accepted task status took ${measurement.elapsedMs}ms (target <=1000ms)`,
      );
    }
    console.log(
      'PASS real click -> accepted task status within 1000ms -> Worker completion -> saved text/citations/audio -> browser refresh -> existing audio read/play reuse and mutual exclusion, desktop and mobile',
    );
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
