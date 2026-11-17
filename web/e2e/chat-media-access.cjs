const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { chromium } = require(
  process.env.RAGFLOW_TEST_PLAYWRIGHT || 'playwright',
);

async function main() {
  const origin = process.env.RAGFLOW_TEST_WEB_ORIGIN;
  const api = process.env.RAGFLOW_TEST_CHAT_API;
  const token = process.env.RAGFLOW_TEST_CHAT_TOKEN;
  const otherToken = process.env.RAGFLOW_TEST_CHAT_OTHER_TOKEN;
  const schema = process.env.RAGFLOW_TEST_CHAT_SCHEMA;
  const userId = process.env.RAGFLOW_TEST_CHAT_USER;
  const otherUserId = process.env.RAGFLOW_TEST_CHAT_OTHER_USER;
  const taskId = process.env.RAGFLOW_TEST_CHAT_ACCESS_TASK;
  assert.equal(origin, 'http://127.0.0.1:19222');
  assert.equal(api, 'http://127.0.0.1:19380');
  assert.match(schema, /^ragflow_chat_test_e2e_[a-z0-9]+$/);
  for (const id of [userId, otherUserId, taskId]) {
    assert.match(id, /^[a-f0-9]{32}$/);
  }
  assert.ok(token && otherToken && token !== otherToken);
  const sql = (statement) =>
    execFileSync(
      'docker',
      [
        'exec',
        '-i',
        'docker-mysql-1',
        'sh',
        '-c',
        'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot --batch --raw --skip-column-names "$1"',
        'sh',
        schema,
      ],
      {
        input: statement,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ).trim();
  const request = async (url) => {
    const response = await fetch(`${api}/api/v1${url}`, {
      headers: { Authorization: token },
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(response.status, 200);
    const envelope = await response.json();
    assert.equal(envelope.code, 0);
    return envelope.data;
  };
  const { task } = await request(`/chats/tasks/${taskId}`);
  assert.equal(task.state, 'succeeded');
  assert.match(task.chat_id, /^[a-f0-9]{32}$/);
  const session = await request(
    `/chats/${task.chat_id}/sessions/${task.session_id}?include_reference=true`,
  );
  const answer = session.messages.find(
    (message) => message.role === 'assistant' && message.id === task.turn_id,
  );
  const image = answer?.media_assets?.find((asset) => asset.kind === 'image');
  const audio = answer?.media_assets?.find((asset) => asset.kind === 'audio');
  assert.ok(image && audio, 'Requires existing real image and audio outputs');
  const chatWhere = `id='${task.chat_id}' AND user_id='${userId}' AND tenant_id='${userId}'`;
  const memberWhere = `user_id='${otherUserId}' AND tenant_id='${userId}' AND role='normal'`;
  assert.equal(sql(`SELECT status FROM dialog WHERE ${chatWhere};`), '1');
  assert.equal(
    sql(`SELECT status FROM user_tenant WHERE ${memberWhere};`),
    '1',
  );
  assert.equal(
    sql(
      `SELECT COUNT(*) FROM user_tenant WHERE user_id='${otherUserId}' AND tenant_id='${otherUserId}' AND role='owner' AND status='1';`,
    ),
    '1',
    'Other identity has its own tenant',
  );
  const leaseSnapshot = sql(
    'SELECT resource_id,task_id,lease_epoch FROM chat_task_resource_lease ORDER BY resource_id,task_id,lease_epoch;',
  );
  const counterSnapshot = sql('SELECT id,calls FROM chat_task ORDER BY id;');
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const generations = [];
  const errors = [];
  let chatChanged = false;
  let memberChanged = false;
  const restoreChat = () => {
    assert.equal(
      sql(
        `UPDATE dialog SET status='1' WHERE ${chatWhere} AND status='0'; SELECT ROW_COUNT();`,
      ),
      '1',
      'Restore exactly the isolated test chat',
    );
    chatChanged = false;
  };
  const checkRead = async (page, asset, expectedStatus) => {
    const result = await page.evaluate(async (url) => {
      const response = await fetch(url, {
        headers: { Authorization: localStorage.getItem('Authorization') },
        // Use the browser's normal cache policy to detect unsafe HTTP caching.
        cache: 'default',
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      const digest = new Uint8Array(
        await crypto.subtle.digest('SHA-256', bytes),
      );
      return {
        status: response.status,
        cache: response.headers.get('cache-control'),
        bytes: bytes.byteLength,
        sha256: Array.from(digest, (value) =>
          value.toString(16).padStart(2, '0'),
        ).join(''),
      };
    }, asset.url);
    assert.equal(result.status, expectedStatus);
    if (expectedStatus === 200) {
      assert.equal(result.cache, 'private, no-store');
      assert.ok(result.bytes > 44);
    }
    return result;
  };
  try {
    assert.equal(
      sql(
        `UPDATE user_tenant SET status='0' WHERE ${memberWhere} AND status='1'; SELECT ROW_COUNT();`,
      ),
      '1',
    );
    memberChanged = true;
    assert.equal(
      sql(
        `SELECT COUNT(*) FROM user_tenant WHERE user_id='${otherUserId}' AND tenant_id='${userId}' AND status='1';`,
      ),
      '0',
      'Cross-tenant reader has no active membership in the resource tenant',
    );
    for (const [name, width, height] of [
      ['desktop', 1440, 1000],
      ['mobile', 390, 844],
    ]) {
      const context = await browser.newContext({
        viewport: { width, height },
        acceptDownloads: true,
      });
      await context.addInitScript((authorization) => {
        localStorage.setItem('Authorization', authorization);
        localStorage.setItem('lng', 'zh');
        const created = [];
        const revoked = [];
        const createObjectURL = URL.createObjectURL.bind(URL);
        const revokeObjectURL = URL.revokeObjectURL.bind(URL);
        window.__chatMediaAudioURLs = { created, revoked };
        URL.createObjectURL = (blob) => {
          const url = createObjectURL(blob);
          if (blob.type?.startsWith('audio/')) created.push(url);
          return url;
        };
        URL.revokeObjectURL = (url) => {
          revoked.push(url);
          revokeObjectURL(url);
        };
      }, token);
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('request', (outgoing) => {
        if (
          outgoing.method() === 'POST' &&
          ['/api/v1/chat/completions', '/api/v1/chat/audio/speech'].includes(
            new URL(outgoing.url()).pathname,
          )
        ) {
          generations.push(new URL(outgoing.url()).pathname);
        }
      });
      await page.goto(
        `${origin}/chat/${task.chat_id}?conversationId=${task.session_id}&turn=${task.turn_id}`,
      );
      await page.getByTestId('chat-textarea').waitFor({ timeout: 90000 });
      const imageBlock = page.locator(`[data-chat-media-id="${image.id}"]`);
      await page.waitForFunction((id) => {
        const img = document.querySelector(`[data-chat-media-id="${id}"] img`);
        return (
          img?.complete && img.naturalWidth > 0 && img.src.startsWith('blob:')
        );
      }, image.id);
      const initialImage = await checkRead(page, image, 200);
      const initialAudio = await checkRead(page, audio, 200);
      const play = page.getByRole('button', { name: '播放语音', exact: true });
      const readAudio = page.waitForResponse((response) =>
        response.url().endsWith(audio.url),
      );
      await play.click();
      assert.equal((await readAudio).status(), 200);
      await page.waitForFunction(() => {
        const element = document.querySelector('audio[aria-label="语音"]');
        return element && !element.paused && element.currentTime > 0;
      });
      const read = page.getByRole('button', {
        name: '朗读内容',
        exact: true,
      });
      const readExistingAudio = page.waitForResponse((response) =>
        response.url().endsWith(audio.url),
      );
      await read.click();
      assert.equal((await readExistingAudio).status(), 200);
      await page.waitForFunction(() => {
        const media = document.querySelector('audio[aria-label="语音"]');
        const reading = document.querySelector('audio:not([aria-label])');
        const playing = [...document.querySelectorAll('audio')].filter(
          (element) => !element.paused,
        );
        return (
          media?.paused &&
          reading &&
          !reading.paused &&
          reading.currentTime > 0 &&
          playing.length === 1
        );
      });
      const resumeExistingAudio = page.waitForResponse((response) =>
        response.url().endsWith(audio.url),
      );
      await play.click();
      assert.equal((await resumeExistingAudio).status(), 200);
      await page.waitForFunction(() => {
        const media = document.querySelector('audio[aria-label="语音"]');
        const reading = document.querySelector('audio:not([aria-label])');
        const playing = [...document.querySelectorAll('audio')].filter(
          (element) => !element.paused,
        );
        return (
          media &&
          !media.paused &&
          media.currentTime > 0 &&
          reading?.paused &&
          playing.length === 1
        );
      });
      await page.getByRole('button', { name: '暂停', exact: true }).click();
      assert.equal(
        await page
          .locator('audio[aria-label="语音"]')
          .evaluate((element) => element.src.startsWith('blob:')),
        true,
        'Keep a real cached audio blob across revocation',
      );
      let downloads = 0;
      page.on('download', () => downloads++);
      assert.equal(
        sql(
          `UPDATE dialog SET status='0' WHERE ${chatWhere} AND status='1'; SELECT ROW_COUNT();`,
        ),
        '1',
      );
      chatChanged = true;
      await checkRead(page, image, 404);
      await checkRead(page, audio, 404);
      const deniedPlayback = page.waitForResponse((response) =>
        response.url().endsWith(audio.url),
      );
      await play.click();
      assert.equal((await deniedPlayback).status(), 404);
      await page
        .getByRole('alert')
        .filter({ hasText: '音频不可用，请重试' })
        .waitFor();
      assert.equal(
        await page
          .locator('audio[aria-label="语音"]')
          .evaluate((element) => element.paused),
        true,
      );
      for (const [asset, button] of [
        [image, imageBlock.getByRole('button', { name: '下载原图' })],
        [audio, page.getByRole('button', { name: '下载语音' })],
      ]) {
        const denied = page.waitForResponse((response) =>
          response.url().endsWith(asset.url),
        );
        await button.click();
        assert.equal((await denied).status(), 404);
      }
      await imageBlock
        .getByRole('alert')
        .filter({ hasText: '下载失败，请重试' })
        .waitFor();
      assert.equal(downloads, 0, 'Revocation produces no download');
      await page.screenshot({
        path: path.join(
          process.env.RAGFLOW_TEST_SCREENSHOTS,
          `chat-media-access-${name}.png`,
        ),
        fullPage: true,
      });
      restoreChat();
      const restoredImage = await checkRead(page, image, 200);
      const restoredAudio = await checkRead(page, audio, 200);
      assert.equal(restoredImage.sha256, initialImage.sha256);
      assert.equal(restoredAudio.sha256, initialAudio.sha256);

      // Switch identity in the same context after priming the HTTP/blob caches.
      await page.evaluate((authorization) => {
        localStorage.setItem('Authorization', authorization);
      }, otherToken);
      await checkRead(page, image, 404);
      await checkRead(page, audio, 404);
      const otherResume = page.waitForResponse((response) =>
        response.url().endsWith(audio.url),
      );
      await play.click();
      assert.equal((await otherResume).status(), 404);
      assert.equal(
        await page
          .locator('audio[aria-label="语音"]')
          .evaluate((element) => element.paused),
        true,
      );
      for (const asset of [image, audio]) {
        const fresh = await context.request.get(`${api}${asset.url}`, {
          headers: { Authorization: otherToken },
        });
        assert.equal(fresh.status(), 404);
        await fresh.dispose();
      }
      assert.equal(downloads, 0);
      await page.evaluate((authorization) => {
        localStorage.setItem('Authorization', authorization);
      }, token);
      await page.getByRole('link', { name: /轨知\s*RailMind/ }).click();
      await page.waitForURL(`${origin}/`);
      await page.waitForFunction(() => {
        const { created, revoked } = window.__chatMediaAudioURLs;
        return (
          created.length >= 3 &&
          created.every((url) => revoked.includes(url)) &&
          document.querySelectorAll('audio').length === 0
        );
      });
      results.push({
        viewport: name,
        readAloudReusedExistingAudio: true,
        playbackExclusive: true,
        audioURLsReleasedOnUnmount: true,
        cachedRevocation: true,
        crossTenantFreshAndCachedDenied: true,
        restoredSHA256: [restoredImage.sha256, restoredAudio.sha256],
      });
      await context.close();
    }
    assert.deepEqual(errors, [], 'No browser exceptions');
    assert.deepEqual(generations, [], 'Viewing/access checks never generate');
    assert.equal(
      sql('SELECT id,calls FROM chat_task ORDER BY id;'),
      counterSnapshot,
      'No task calls changed',
    );
    assert.equal(
      sql(
        'SELECT resource_id,task_id,lease_epoch FROM chat_task_resource_lease ORDER BY resource_id,task_id,lease_epoch;',
      ),
      leaseSnapshot,
      'All existing leases remain unchanged',
    );
  } finally {
    try {
      if (chatChanged) restoreChat();
    } finally {
      try {
        if (memberChanged) {
          assert.equal(
            sql(
              `UPDATE user_tenant SET status='1' WHERE ${memberWhere} AND status='0'; SELECT ROW_COUNT();`,
            ),
            '1',
            'Restore exactly the isolated test membership',
          );
          memberChanged = false;
        }
        assert.equal(sql(`SELECT status FROM dialog WHERE ${chatWhere};`), '1');
        assert.equal(
          sql(`SELECT status FROM user_tenant WHERE ${memberWhere};`),
          '1',
        );
      } finally {
        await browser.close();
      }
    }
  }
  process.stdout.write(
    JSON.stringify({
      pass: true,
      taskId,
      results,
      generatedRequests: 0,
      permissionsRestored: true,
    }) + '\n',
  );
}

main().catch((error) => {
  // Process failures can echo configuration; assertion values here are public.
  console.error(
    error instanceof assert.AssertionError
      ? error.message
      : 'FAIL real cached media access verification',
  );
  console.error(
    String(error.stack)
      .split('\n')
      .filter((line) => /^\s+at /.test(line))
      .join('\n'),
  );
  process.exitCode = 1;
});
