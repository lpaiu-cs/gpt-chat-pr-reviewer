import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { enterProject, readProjectEntry } from '../src/project-entry.js';
import { ChatGPTDriver } from '../src/chatgpt.js';
import { loadConfig } from '../src/config.js';

test('실제 Chrome: 직접 로딩 실패·호버 비활성 버튼에서도 Enter 진입, ID와 초안 보호', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const entry = { url: 'https://chatgpt.com/g/g-p-1234-reviews/project', name: 'Reviews' };
  let destination = entry.url;
  let deepLoads = 0;
  await page.route('https://chatgpt.com/**', async route => {
    if (new URL(route.request().url()).pathname !== '/') {
      deepLoads++;
      return route.fulfill({ status: 500, body: 'Try again' });
    }
    await route.fulfill({ contentType: 'text/html', body: `
      <div><div role="button" tabindex="0">Reviews</div>
      <button aria-label="Open project home" style="pointer-events:none;opacity:0"
        onclick="history.pushState({}, '', '${destination}'); document.querySelector('h1').textContent='Reviews'">open</button></div>
      <h1>Home</h1><div id="prompt-textarea" contenteditable="true"></div>` });
  });
  try {
    for (let i = 0; i < 3; i++) {
      await page.goto('https://chatgpt.com/');
      await enterProject(page, entry, '#prompt-textarea');
      assert.deepEqual(await readProjectEntry(page, '#prompt-textarea'), entry);
    }
    assert.equal(deepLoads, 0, '프로젝트를 HTTP 문서로 요청하지 않아야 한다');
    const driver = new ChatGPTDriver({ ...loadConfig('tests/__missing__.json'), chatgptProjectUrl: entry.url });
    (driver as any).page = page;
    await driver.registerProject();
    assert.deepEqual(await driver.projectEntry(), entry);
    await page.evaluate(url => {
      const link = document.createElement('a');
      link.href = url;
      link.textContent = 'Existing review';
      link.onclick = event => { event.preventDefault(); history.pushState({}, '', url); };
      document.body.appendChild(link);
    }, entry.url.replace('/project', '/c/abcd'));
    assert.equal(await driver.resumeChat(entry.url.replace('/project', '/c/abcd'), { requireAssistant: false }), true);
    assert.equal(deepLoads, 0, '대화 복귀도 전체 문서 로딩을 피해야 한다');
    await page.goto('https://chatgpt.com/');
    await enterProject(page, entry, '#prompt-textarea');
    await page.locator('#prompt-textarea').fill('keep my draft');
    await assert.rejects(enterProject(page, entry, '#prompt-textarea'), /작성 중/);
    assert.equal(await page.locator('#prompt-textarea').innerText(), 'keep my draft');
    destination = entry.url.replace('1234', '5678');
    await page.goto('https://chatgpt.com/');
    await assert.rejects(enterProject(page, entry, '#prompt-textarea'), /ID/);
    await assert.rejects(enterProject(page, { ...entry, name: '' }, '#prompt-textarea'), /setup/);
  } finally { await browser.close(); }
});
