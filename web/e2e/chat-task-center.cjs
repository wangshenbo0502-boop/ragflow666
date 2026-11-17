const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(
  process.env.RAGFLOW_TEST_PLAYWRIGHT || 'playwright',
);

async function main() {
  const origin = process.env.RAGFLOW_TEST_WEB_ORIGIN;
  const api = process.env.RAGFLOW_TEST_CHAT_API;
  const token = process.env.RAGFLOW_TEST_CHAT_TOKEN;
  assert.equal(origin, 'http://127.0.0.1:19222');
  assert.equal(api, 'http://127.0.0.1:19380');
  assert.ok(token, 'Requires disposable environment authorization');
  const get = async (url) => {
    const response = await fetch(`${api}/api/v1${url}`, {
      headers: { Authorization: token },
    });
    assert.equal(response.status, 200, url);
    const envelope = await response.json();
    assert.equal(envelope.code, 0, url);
    return envelope.data;
  };
  const all = await get('/chats/tasks?page=1&page_size=100');
  assert.ok(all.total > 10, 'Requires multiple pages of real persisted tasks');
  let target;
  let message;
  for (const task of all.tasks.filter((task) => task.state === 'succeeded')) {
    const session = await get(
      `/chats/${task.chat_id}/sessions/${task.session_id}`,
    );
    message = session.messages.find(
      (item) => item.role === 'assistant' && item.id === task.turn_id,
    );
    if (message?.content) {
      target = task;
      break;
    }
  }
  assert.ok(target, 'Requires a completed task with a persisted answer');
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
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(
      `${origin}/chat/${target.chat_id}?conversationId=${target.session_id}`,
    );
    await page.getByTestId('chat-textarea').waitFor({ timeout: 90000 });
    await page.getByRole('button', { name: '任务中心', exact: true }).click();
    const sheet = page.getByRole('dialog');
    const assertRows = async (query) => {
      const data = await get(`/chats/tasks?${query}`);
      await page.waitForFunction(
        (ids) =>
          JSON.stringify(
            [
              ...document.querySelectorAll('[role="dialog"] [data-task-id]'),
            ].map((item) => item.dataset.taskId),
          ) === JSON.stringify(ids),
        data.tasks.map((task) => task.id),
      );
      return data;
    };
    const first = await assertRows('page=1&page_size=10');
    assert.equal(first.tasks.length, 10);
    await sheet.getByRole('button', { name: '下一页', exact: true }).click();
    const second = await assertRows('page=2&page_size=10');
    assert.ok(
      second.tasks.every(
        (task) => !first.tasks.some((item) => item.id === task.id),
      ),
    );
    await sheet.getByRole('button', { name: '上一页', exact: true }).click();
    await assertRows('page=1&page_size=10');
    await sheet
      .getByRole('combobox', { name: '任务状态', exact: true })
      .click();
    await page.getByRole('option', { name: '部分完成', exact: true }).click();
    const partials = await assertRows(
      'state=partial_succeeded&page=1&page_size=10',
    );
    assert.ok(partials.tasks.length > 0);
    const partial = partials.tasks[0];
    await sheet.locator(`[data-task-id="${partial.id}"]`).click();
    const detail = await get(`/chats/tasks/${partial.id}`);
    await sheet.getByRole('button', { name: '原对话', exact: true }).waitFor();
    for (const stage of ['image', 'audio']) {
      assert.equal(
        await sheet
          .getByRole('button', {
            name: stage === 'image' ? '重试图片' : '重试音频',
            exact: true,
          })
          .count(),
        Number(detail.retry_stages.includes(stage)),
        'Retry controls must match backend stages',
      );
    }
    assert.equal(
      await sheet
        .getByRole('button', { name: '取消任务', exact: true })
        .count(),
      Number(detail.can_cancel),
    );
    await sheet
      .getByRole('combobox', { name: '任务类型', exact: true })
      .click();
    await page.getByRole('option', { name: '图片与配音', exact: true }).click();
    await assertRows(
      'state=partial_succeeded&kind=image_voice&page=1&page_size=10',
    );
    await page.screenshot({
      path: path.join(
        process.env.RAGFLOW_TEST_SCREENSHOTS,
        'chat-task-center-desktop.png',
      ),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = await page.evaluate(() => ({
      viewport: innerWidth,
      width: document.documentElement.scrollWidth,
      sheet: document.querySelector('[role="dialog"]').getBoundingClientRect()
        .width,
    }));
    assert.ok(
      bounds.width <= bounds.viewport && bounds.sheet <= bounds.viewport,
      JSON.stringify(bounds),
    );
    await page.screenshot({
      path: path.join(
        process.env.RAGFLOW_TEST_SCREENSHOTS,
        'chat-task-center-mobile.png',
      ),
    });
    await sheet
      .getByRole('combobox', { name: '任务状态', exact: true })
      .click();
    await page.getByRole('option', { name: '已完成', exact: true }).click();
    await sheet
      .getByRole('combobox', { name: '任务类型', exact: true })
      .click();
    await page.getByRole('option', { name: '全部类型', exact: true }).click();
    const completed = await assertRows('state=succeeded&page=1&page_size=10');
    assert.ok(completed.tasks.some((task) => task.id === target.id));
    await sheet.locator(`[data-task-id="${target.id}"]`).click();
    await sheet.getByRole('button', { name: '原对话', exact: true }).click();
    await sheet.waitFor({ state: 'hidden' });
    const destination = new URL(page.url());
    assert.equal(destination.pathname, `/chat/${target.chat_id}`);
    assert.equal(
      destination.searchParams.get('conversationId'),
      target.session_id,
    );
    assert.equal(destination.searchParams.get('turn'), target.turn_id);
    const excerpt = message.content.slice(0, 18);
    await page.getByText(excerpt, { exact: false }).first().waitFor();
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(
      'PASS real task center: pagination, state/kind filters, backend retry/cancel controls, desktop/mobile, close and jump to persisted turn',
      {
        total: all.total,
        target: target.id,
        bounds,
      },
    );
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
