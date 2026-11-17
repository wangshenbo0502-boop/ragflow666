const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createParser } = require('eventsource-parser');
const { chromium } = require(
  process.env.RAGFLOW_TEST_PLAYWRIGHT || 'playwright',
);

async function main() {
  const origin = process.env.RAGFLOW_TEST_WEB_ORIGIN;
  const api = process.env.RAGFLOW_TEST_CHAT_API;
  const token = process.env.RAGFLOW_TEST_CHAT_TOKEN;
  const isolatedWorkers = {
    'http://127.0.0.1:19222': [
      'http://127.0.0.1:19380',
      'ragflow-chat-test-ingestor',
    ],
    'http://127.0.0.1:19223': [
      'http://127.0.0.1:19383',
      'ragflow-chat-test-planning-ingestor',
    ],
  };
  const [expectedAPI, workerName] = isolatedWorkers[origin] || [];
  assert.ok(expectedAPI, 'The browser must use a disposable chat environment');
  assert.equal(api, expectedAPI);
  assert.ok(
    token &&
      process.env.RAGFLOW_TEST_CHAT_DATASET &&
      process.env.RAGFLOW_TEST_CHAT_MODEL,
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
  const control = async (port, body = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/control`, {
      method: 'POST',
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const terminal = async (id, expectedState) => {
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      const detail = await request('GET', `/chats/tasks/${id}`);
      if (
        ['succeeded', 'partial_succeeded', 'failed', 'cancelled'].includes(
          detail.task.state,
        )
      ) {
        if (detail.task.state !== expectedState) {
          await printFailureDiagnostic(detail);
          assert.equal(
            detail.task.state,
            expectedState,
            `Task ${id} reached an unexpected terminal state`,
          );
        }
        return detail;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const detail = await request('GET', `/chats/tasks/${id}`);
    await printFailureDiagnostic(detail);
    assert.fail(`Task timed out: ${id}`);
  };
  const printFailureDiagnostic = async (detail) => {
    const task = detail.task;
    const routing = detail.routing_snapshot || {};
    let events = [];
    try {
      const eventData = await request(
        'GET',
        `/chats/tasks/${task.id}/events?after_seq=0`,
      );
      events = (eventData.events || eventData || []).slice(-8).map((event) => ({
        type: event.type,
        seq: event.seq,
        data: event.data,
      }));
    } catch {
      events = ['unavailable'];
    }
    let worker = { inspection: 'unavailable' };
    try {
      const inspected = execFileSync(
        'docker',
        [
          'inspect',
          '--format',
          '{{.Config.Image}}|{{.Image}}|{{.State.StartedAt}}',
          workerName,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      const [image, imageId, startedAt] = inspected.split('|');
      worker = { image, image_id: imageId, started_at: startedAt };
    } catch {}
    console.error(
      JSON.stringify({
        diagnostic: 'chat task failure',
        task: {
          id: task.id,
          state: task.state,
          stage: task.stage,
          error_code: task.error_code,
          upstream_status: task.upstream_status,
          calls: task.calls,
        },
        attempts: (detail.attempts || []).slice(-5).map((attempt) => ({
          id: attempt.id,
          stage: attempt.stage,
          state: attempt.state,
          upstream_status: attempt.upstream_status,
          error_code: attempt.error_code,
        })),
        events,
        identity: {
          tenant_id: routing.tenant_id,
          tenant_llm_id: routing.tenant_llm_id,
          tenant_decision_id: routing.tenant_decision_id,
          model_id: routing.model_id,
          route_policy: routing.route_policy,
        },
        worker,
      }),
    );
  };
  const chat = await request('POST', '/chats', {
    name: 'Isolated browser combined branch recovery',
    dataset_ids: [process.env.RAGFLOW_TEST_CHAT_DATASET],
    llm_id: process.env.RAGFLOW_TEST_CHAT_MODEL,
    llm_setting: { temperature: 0, max_tokens: 1024 },
    prompt_config: {
      system: '请根据知识库回答，保留来源引用。{knowledge}',
      parameters: [{ key: 'knowledge', optional: false }],
      quote: true,
    },
    similarity_threshold: 0,
  });
  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    const context = await browser.newContext({ acceptDownloads: true });
    await context.addInitScript((authorization) => {
      localStorage.setItem('Authorization', authorization);
      localStorage.setItem('lng', 'zh');
    }, token);
    const page = await context.newPage();
    const errors = [];
    let generations = 0;
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (outgoing) => {
      if (
        outgoing.method() === 'POST' &&
        new URL(outgoing.url()).pathname === '/api/v1/chat/completions'
      )
        generations++;
    });
    const scenarios = [
      ['image', 'desktop', 1440, 1000],
      ['audio', 'mobile', 390, 844],
    ].filter(
      (scenario) =>
        !process.env.RAGFLOW_TEST_VIEWPORT ||
        scenario[1] === process.env.RAGFLOW_TEST_VIEWPORT,
    );
    assert.ok(scenarios.length > 0, 'Expected desktop or mobile viewport');
    for (const [failed, name, width, height] of scenarios) {
      const imageBefore = await control(19982);
      const audioBefore = await control(19980);
      assert.equal(imageBefore.holding || 0, 0, 'Another test owns image gate');
      assert.equal(audioBefore.holding || 0, 0, 'Another test owns TTS gate');
      await control(19982, { fail_next: failed === 'image' ? 1 : 0 });
      await control(19980, { fail_next: failed === 'audio' ? 1 : 0 });
      const session = await request('POST', `/chats/${chat.id}/sessions`, {
        name: `Combined ${failed} failure ${name}`,
      });
      const sessionPath = `/chats/${chat.id}/sessions/${session.id}?include_reference=true`;
      await page.setViewportSize({ width, height });
      await page.goto(`${origin}/chat/${chat.id}?conversationId=${session.id}`);
      await page.getByTestId('chat-textarea').waitFor({ timeout: 90000 });
      await page
        .getByRole('button', { name: '图片与配音', exact: true })
        .click();
      await page
        .getByTestId('chat-textarea')
        .fill(
          '根据知识库简短回答青禾项目的验收暗号和负责人，保留引用。同时画一幅青山与小河的插画，并为回答配音。',
        );
      const admission = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/v1/chat/completions' &&
          response.request().method() === 'POST',
      );
      await page.getByTestId('chat-detail-send').click();
      const events = [];
      const admittedResponse = await admission;
      assert.equal(admittedResponse.status(), 200);
      createParser((event) => {
        if (event.type === 'event') events.push(JSON.parse(event.data));
      }).feed(await admittedResponse.text());
      const admitted = events.find((event) => event.data?.task_id)?.data;
      assert.ok(admitted?.accepted && admitted.task_id);
      const original = await terminal(admitted.task_id, 'partial_succeeded');
      assert.equal(original.task.kind, 'image_voice');
      assert.equal(original.task.state, 'partial_succeeded');
      assert.deepEqual(original.retry_stages, [failed]);
      const first = original.task.outputs.answer;
      assert.ok(
        first.content.includes('山海同行') && first.content.includes('林悦'),
      );
      assert.ok(first.reference?.chunks?.length > 0);
      assert.equal(first.media_assets.length, 1);
      const successfulAsset = first.media_assets[0];
      assert.equal(
        successfulAsset.kind,
        failed === 'audio' ? 'image' : 'audio',
      );
      const retryLabel = failed === 'image' ? '重试图片' : '重试音频';
      const otherLabel = failed === 'image' ? '重试音频' : '重试图片';
      const latest = async () => {
        const saved = await request('GET', sessionPath);
        const answer = saved.messages.find(
          (message) =>
            message.role === 'assistant' &&
            message.id === original.task.turn_id,
        );
        assert.ok(answer, 'Refresh retains the original answer');
        assert.deepEqual(answer.reference, first.reference);
        return answer;
      };
      assert.equal((await latest()).answer_version, first.answer_version);
      await page.reload();
      await page.getByTestId('chat-textarea').waitFor({ timeout: 90000 });
      await page
        .getByText(/山海同行/)
        .last()
        .waitFor();
      assert.ok((await page.locator('body').innerText()).includes('林悦'));
      await page.getByRole('button', { name: '任务中心', exact: true }).click();
      const sheet = page.getByRole('dialog');
      await sheet.locator(`[data-task-id="${original.task.id}"]`).click();
      await sheet
        .getByRole('button', { name: retryLabel, exact: true })
        .waitFor();
      assert.equal(
        await sheet
          .getByRole('button', { name: otherLabel, exact: true })
          .count(),
        0,
        'Only failed branch is offered',
      );
      const retryResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
            `/api/v1/chats/tasks/${original.task.id}/retry` &&
          response.request().method() === 'POST',
      );
      await sheet
        .getByRole('button', { name: retryLabel, exact: true })
        .click();
      const response = await retryResponse;
      assert.equal(response.status(), 200);
      assert.deepEqual(response.request().postDataJSON(), {
        stage: failed,
        revision: original.task.revision,
      });
      const envelope = await response.json();
      assert.equal(envelope.code, 0, envelope.message);
      const completed = await terminal(envelope.data.id, 'succeeded');
      assert.equal(completed.task.state, 'succeeded');
      assert.equal(completed.task.retry_of, original.task.id);
      assert.equal(completed.attempts.length, 1);
      assert.equal(completed.attempts[0].stage, failed);
      assert.deepEqual(
        (await request('GET', `/chats/tasks/${original.task.id}`)).task,
        original.task,
        'Original terminal is immutable',
      );
      const answer = await latest();
      assert.equal(answer.answer_version, first.answer_version + 1);
      assert.equal(answer.media_assets.length, 2);
      assert.deepEqual(
        answer.media_assets.find((asset) => asset.id === successfulAsset.id),
        successfulAsset,
        'Successful asset is unchanged',
      );
      await page.keyboard.press('Escape');
      await page.reload();
      const image = answer.media_assets.find((asset) => asset.kind === 'image');
      const audio = answer.media_assets.find((asset) => asset.kind === 'audio');
      const imageBlock = page.locator(`[data-chat-media-id="${image.id}"]`);
      await imageBlock.waitFor({ timeout: 90000 });
      await imageBlock.scrollIntoViewIfNeeded();
      await page.waitForFunction((id) => {
        const img = document.querySelector(`[data-chat-media-id="${id}"] img`);
        return img?.complete && img.naturalWidth > 0;
      }, image.id);
      const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
      const downloaded = [];
      for (const asset of [image, audio]) {
        const direct = await fetch(new URL(asset.url, api), {
          headers: { Authorization: token },
          signal: AbortSignal.timeout(30000),
        });
        assert.equal(direct.status, 200);
        const expected = Buffer.from(await direct.arrayBuffer());
        const event = page.waitForEvent('download');
        await page
          .getByRole('button', {
            name: asset.kind === 'image' ? '下载原图' : '下载语音',
            exact: true,
          })
          .click();
        const download = await event;
        assert.equal(await download.failure(), null);
        const actual = await fs.readFile(await download.path());
        assert.equal(hash(actual), hash(expected));
        downloaded.push({
          kind: asset.kind,
          bytes: actual.length,
          sha256: hash(actual),
        });
      }
      const read = page.waitForResponse((response) =>
        response.url().endsWith(audio.url),
      );
      await page.getByRole('button', { name: '播放语音', exact: true }).click();
      assert.equal((await read).status(), 200);
      await page.waitForFunction(() =>
        [...document.querySelectorAll('audio[aria-label="语音"]')].some(
          (element) =>
            !element.paused && element.duration > 0 && element.currentTime > 0,
        ),
      );
      await page.getByRole('button', { name: '暂停', exact: true }).click();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth + 1,
        ),
        false,
        'No horizontal overflow',
      );
      await page.screenshot({
        path: path.join(
          process.env.RAGFLOW_TEST_SCREENSHOTS || '.',
          `chat-combined-${name}.png`,
        ),
        fullPage: true,
      });
      const imageAfter = await control(19982);
      const audioAfter = await control(19980);
      assert.equal(imageAfter.forwarded - imageBefore.forwarded, 1);
      assert.equal(audioAfter.forwarded - audioBefore.forwarded, 1);
      assert.equal(
        imageAfter.rejected - imageBefore.rejected,
        failed === 'image' ? 1 : 0,
      );
      assert.equal(
        audioAfter.rejected - audioBefore.rejected,
        failed === 'audio' ? 1 : 0,
      );
      results.push({
        name,
        failed,
        taskId: original.task.id,
        retryId: completed.task.id,
        answerVersions: [first.answer_version, answer.answer_version],
        successfulAssetPreserved: true,
        downloads: downloaded,
      });
    }
    assert.equal(
      generations,
      scenarios.length,
      'Refresh, playback and retries never resubmit answers',
    );
    assert.deepEqual(errors, [], 'Browser errors');
    console.warn(
      JSON.stringify({
        pass: true,
        results,
        generations,
        browserErrors: errors.length,
      }),
    );
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
