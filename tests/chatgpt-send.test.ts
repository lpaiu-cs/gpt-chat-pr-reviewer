import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { ChatGPTDriver } from '../src/chatgpt.js';
import { loadConfig } from '../src/config.js';
import { enterProject } from '../src/project-entry.js';

test('실제 Chrome: 전송 실패 초안 회수와 첨부 완료 경계', async (t) => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const entry = { url: 'https://chatgpt.com/g/g-p-1234-reviews/project', name: 'Reviews' };
  await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: `
    <form><div id="prompt-textarea" contenteditable="true"></div><input id="upload-files" type="file">
      <button type="button" id="composer-plus-btn">Add</button></form>
    <span onclick="document.querySelector('input').click()">Add photos &amp; files</span>
    <script>document.addEventListener('keydown', e => { if (e.key === 'Enter') window.unintendedSend = true; });
    document.querySelector('input').onchange = e => {
      const name = e.target.files[0].name;
      const card = document.createElement('div'); card.setAttribute('role', 'group'); card.setAttribute('aria-label', name);
      card.innerHTML = '<span data-testid="library-file-icon" hidden>ready</span><button type="button">remove</button>';
      const button = card.querySelector('button'); button.setAttribute('aria-label', 'Remove file 1: ' + name);
      button.onclick = () => card.remove(); document.querySelector('form').append(card);
      setTimeout(() => card.querySelector('span').hidden = false, 50);
    };</script>` }));
  const input = page.locator('#prompt-textarea');
  const file = { name: 'review-diff-test.txt', buffer: Buffer.from('한글 diff\n+all lines\n') };
  const prompt = 'review round 1\nfixed head and base';
  async function driver() {
    await page.goto(entry.url);
    const d = new ChatGPTDriver({ ...loadConfig('tests/__missing__.json'), chatgptProjectUrl: entry.url }) as any;
    d.page = page;
    d.waitUntilIdle = async () => {};
    d.countSettledMessages = async () => 0;
    d.lastUserMessageId = async () => null;
    d.countUserMessages = async () => 0;
    d.isStreaming = async () => false;
    d.fillPrompt = async (_p: unknown, text: string) => input.fill(text);
    d.verifyPromptSent = async () => true;
    d.waitForConversationUrl = async () => entry.url.replace('/project', '/c/fixture');
    d.collectResponse = async () => 'answer';
    return d;
  }
  try {
    await t.test('클릭 실패 후 다른 PR의 프로젝트 진입이 막히지 않는다', async () => {
      const d = await driver();
      d.clickSend = async () => { throw new Error('disabled'); };
      await assert.rejects(d.sendAndCollect(prompt), /disabled/);
      assert.equal((await input.innerText()).trim(), '');
      await enterProject(page, entry, '#prompt-textarea');
    });
    await t.test('첨부 완료를 기다리고 전체 원문을 전달한다', async () => {
      const d = await driver();
      d.fillPrompt = async (_p: unknown, text: string) => {
        assert(await page.getByTestId('library-file-icon').isVisible(), '첨부 완료 후 프롬프트를 입력한다');
        await input.fill(text);
      };
      d.clickSend = async () => {
        assert(await page.getByTestId('library-file-icon').isVisible());
        const uploaded = await page.locator('#upload-files').evaluate(async (el: HTMLInputElement) => el.files![0].text());
        assert.equal(uploaded, file.buffer.toString());
      };
      assert.equal(await d.sendAndCollect(prompt, undefined, file), 'answer');
    });
    await t.test('전송 확인 실패 시 자기 첨부도 제거한다', async () => {
      const d = await driver(); d.clickSend = async () => {}; d.verifyPromptSent = async () => false;
      await assert.rejects(d.sendAndCollect(prompt, undefined, file), /전송되지/);
      assert.equal((await input.innerText()).trim(), '');
      assert.equal(await page.getByRole('group').count(), 0);
      assert.equal(await page.evaluate(() => (window as any).unintendedSend), undefined, '첨부 제거에 전송 단축키를 사용하지 않는다');
    });
    await t.test('업로드 실패 시 클릭하지 않고 자기 초안을 회수한다', async () => {
      const d = await driver();
      const mocked = t.mock.method(page, 'waitForEvent', (async () => ({
        setFiles: async () => { throw new Error('upload failed'); },
      })) as typeof page.waitForEvent);
      d.clickSend = async () => assert.fail('upload failed; must not send');
      try { await assert.rejects(d.sendAndCollect(prompt, undefined, file), /upload failed/); }
      finally { mocked.mock.restore(); }
      assert.equal((await input.innerText()).trim(), '');
    });
    await t.test('기존 초안과 기존 첨부는 덮어쓰지 않는다', async () => {
      const d = await driver();
      await input.fill('personal draft');
      await assert.rejects(d.sendAndCollect(prompt), /보존/);
      assert.equal(await input.innerText(), 'personal draft');
      await input.fill('');
      await page.locator('#upload-files').setInputFiles({ ...file, mimeType: 'text/plain' });
      await assert.rejects(d.sendAndCollect(prompt), /보존/);
      assert.equal(await page.getByRole('group').count(), 1);
    });
    await t.test('생성 중이거나 사용자 편집이 있으면 오류 후에도 보존한다', async () => {
      const d = await driver();
      d.isStreaming = async () => true;
      d.clickSend = async () => { throw new Error('uncertain'); };
      await assert.rejects(d.sendAndCollect(prompt), /uncertain/);
      assert.equal(await input.innerText(), prompt);
      await input.fill(''); d.isStreaming = async () => false;
      d.clickSend = async () => { await input.fill('user changed this'); throw new Error('changed'); };
      await assert.rejects(d.sendAndCollect(prompt), /changed/);
      assert.equal(await input.innerText(), 'user changed this');
    });
  } finally { await browser.close(); }
});
