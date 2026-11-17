const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(
  process.env.RAGFLOW_TEST_PLAYWRIGHT || 'playwright',
);

async function main() {
  const origin = process.env.RAGFLOW_TEST_WEB_ORIGIN;
  const api = process.env.RAGFLOW_TEST_CHAT_API;
  const token = process.env.RAGFLOW_TEST_CHAT_TOKEN;
  const taskId = process.env.RAGFLOW_TEST_CHAT_IMAGE_TASK;
  assert.equal(origin, 'http://127.0.0.1:19222');
  assert.equal(api, 'http://127.0.0.1:19380');
  assert.ok(token && taskId, 'Requires an isolated, real image-edit task');
  const request = async (url) => {
    const response = await fetch(`${api}/api/v1${url}`, {
      headers: { Authorization: token },
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(response.status, 200, url);
    const envelope = await response.json();
    assert.equal(envelope.code, 0, envelope.message);
    return envelope.data;
  };
  const { task } = await request(`/chats/tasks/${taskId}`);
  assert.equal(task.state, 'succeeded');
  const session = await request(
    `/chats/${task.chat_id}/sessions/${task.session_id}?include_reference=true`,
  );
  const images = session.messages.flatMap(
    (message) =>
      message.media_assets?.filter((asset) => asset.kind === 'image') ?? [],
  );
  const edited = images.find((asset) => asset.parent_id);
  assert.ok(edited, 'Requires a real saved edited image');
  const parent = images.find((asset) => asset.id === edited.parent_id);
  assert.ok(parent, 'Saved parent is accessible in the same session');
  assert.ok(
    images.some((asset) => asset.id !== parent.id && asset.id !== edited.id),
    'A newer independent image makes the old edit target unambiguous',
  );
  assert.equal(edited.width, parent.width);
  assert.equal(edited.height, parent.height);
  const imageResponse = await fetch(new URL(edited.url, api), {
    headers: { Authorization: token },
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(imageResponse.status, 200);
  const original = Buffer.from(await imageResponse.arrayBuffer());
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ acceptDownloads: true });
    await context.addInitScript((authorization) => {
      localStorage.setItem('Authorization', authorization);
      localStorage.setItem('lng', 'zh');
    }, token);
    const page = await context.newPage();
    const errors = [];
    const generations = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (outgoing) => {
      if (
        outgoing.method() === 'POST' &&
        new URL(outgoing.url()).pathname === '/api/v1/chat/completions'
      ) {
        generations.push(outgoing.url());
      }
    });
    const results = [];
    for (const [name, width, height] of [
      ['desktop', 1440, 1000],
      ['mobile', 390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      await page.goto(
        `${origin}/chat/${task.chat_id}?conversationId=${task.session_id}&turn=${task.turn_id}`,
      );
      await page.getByTestId('chat-textarea').waitFor({ timeout: 90000 });
      const editedImage = page.locator(`[data-chat-media-id="${edited.id}"]`);
      await editedImage.getByRole('button', { name: '查看父版本' }).waitFor();
      await editedImage.scrollIntoViewIfNeeded();
      await page.waitForFunction((id) => {
        const img = document.querySelector(`[data-chat-media-id="${id}"] img`);
        return img?.complete && img.naturalWidth > 0;
      }, edited.id);
      const downloadEvent = page.waitForEvent('download');
      await editedImage.getByRole('button', { name: '下载原图' }).click();
      const download = await downloadEvent;
      const downloaded = await fs.readFile(await download.path());
      assert.equal(
        hash(downloaded),
        hash(original),
        'Original bytes downloaded',
      );
      assert.ok(download.suggestedFilename().endsWith('.png'));
      await editedImage.getByRole('button', { name: '查看父版本' }).click();
      const parentImage = page.locator(`[data-chat-media-id="${parent.id}"]`);
      await parentImage.waitFor();
      await page.waitForFunction((id) => {
        const element = document.querySelector(`[data-chat-media-id="${id}"]`);
        const rect = element?.getBoundingClientRect();
        return rect && rect.bottom > 0 && rect.top < innerHeight;
      }, parent.id);
      await parentImage
        .getByRole('button', { name: '继续编辑这张图片' })
        .click();
      await page
        .getByText(`编辑图片 ${parent.id.slice(0, 8)}`, { exact: false })
        .waitFor();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth + 1,
        ),
        false,
        'No horizontal page overflow',
      );
      await page.screenshot({
        path: path.join(
          process.env.RAGFLOW_TEST_SCREENSHOTS || '.',
          `chat-image-parent-${name}.png`,
        ),
        fullPage: true,
      });
      await page.getByRole('button', { name: '取消编辑目标' }).click();
      await page.getByRole('button', { name: '取消编辑目标' }).waitFor({
        state: 'detached',
      });
      results.push({
        name,
        downloadedBytes: downloaded.length,
        parent: parent.id,
      });
    }
    assert.deepEqual(errors, [], 'Browser errors');
    assert.deepEqual(
      generations,
      [],
      'Viewing/edit selection never regenerates',
    );
    console.log(
      JSON.stringify({
        pass: true,
        taskId,
        edited: edited.id,
        parent: parent.id,
        dimensions: [parent.width, parent.height],
        originalSHA256: hash(original),
        results,
        generatedCalls: generations.length,
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
