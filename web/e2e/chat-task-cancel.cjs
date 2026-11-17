const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(
  process.env.RAGFLOW_TEST_PLAYWRIGHT || 'playwright',
);

async function cancelTask({ chat_id, session_id, task_id, viewport }, token) {
  assert.ok(['desktop', 'mobile'].includes(viewport));
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport:
        viewport === 'mobile'
          ? { width: 390, height: 844 }
          : { width: 1440, height: 1000 },
    });
    await context.addInitScript((authorization) => {
      localStorage.setItem('Authorization', authorization);
      localStorage.setItem('lng', 'zh');
    }, token);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(
      `http://127.0.0.1:19223/chat/${encodeURIComponent(chat_id)}?conversationId=${encodeURIComponent(session_id)}`,
    );
    await page.getByTestId('chat-textarea').waitFor({ timeout: 60000 });
    await page.getByRole('button', { name: '任务中心', exact: true }).click();
    const sheet = page.getByRole('dialog');
    await sheet.locator(`[data-task-id="${task_id}"]`).click();
    const cancel = sheet.getByRole('button', { name: '取消任务', exact: true });
    await cancel.waitFor();
    const response = page.waitForResponse((item) => {
      const url = new URL(item.url());
      return (
        item.request().method() === 'POST' &&
        url.pathname === `/api/v1/chats/tasks/${task_id}/cancel`
      );
    });
    await cancel.click();
    const result = await response;
    assert.equal(result.status(), 200);
    assert.equal((await result.json()).code, 0);
    await cancel.waitFor({ state: 'hidden', timeout: 30000 });
    await sheet.getByText(/^已取消 ·/).waitFor({ timeout: 30000 });
    const bounds = await page.evaluate(() => ({
      viewport: innerWidth,
      width: document.documentElement.scrollWidth,
      sheet: document.querySelector('[role="dialog"]').getBoundingClientRect()
        .width,
    }));
    assert.ok(
      bounds.width <= bounds.viewport && bounds.sheet <= bounds.viewport,
    );
    await page.screenshot({
      path: path.join('D:/ragflow/.run', `chat-task-cancel-${viewport}.png`),
    });
    assert.deepEqual(errors, []);
    console.log(
      `PASS real ${viewport} task-center cancellation task=${task_id}`,
    );
  } finally {
    await browser.close();
  }
}

module.exports = { cancelTask };
