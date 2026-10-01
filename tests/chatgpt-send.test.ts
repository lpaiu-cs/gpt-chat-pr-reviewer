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
      <button type="button" id="composer-plus-btn">Add</button>
      <button type="button" id="model" aria-label="Select ChatGPT model">Instant</button></form>
    <div id="menu" role="menu" data-state="closed" hidden>
      <div role="menuitem" aria-label="Power" data-reasoning-slider tabindex="-1" aria-describedby="power-label">
        <span role="slider" aria-hidden="true" aria-valuemin="0" aria-valuemax="4" aria-valuenow="0"></span></div>
      <span id="power-label">Instant, 1 of 5.</span><div role="menuitemradio" aria-checked="true">Latest</div></div>
    <script>document.addEventListener('keydown', e => { if (e.key === 'Enter') window.unintendedSend = true; });
    // 개편 화면(2026-09) 실측 마크업: 추론 슬라이더 메뉴, 업로드 중 진행 막대 → 파일명 버튼
    const menu = document.getElementById('menu'), slider = menu.querySelector('[role="slider"]');
    document.getElementById('model').onclick = () => { menu.hidden = false; menu.dataset.state = 'open'; };
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { menu.hidden = true; menu.dataset.state = 'closed'; } });
    menu.querySelector('[data-reasoning-slider]').onkeydown = e => {
      if (e.key !== 'ArrowRight') return;
      const v = Math.min(4, +slider.getAttribute('aria-valuenow') + 1);
      slider.setAttribute('aria-valuenow', v);
      document.getElementById('power-label').textContent = ['Instant', 'Medium', 'High', 'Extra High', 'Pro'][v] + ', ' + (v + 1) + ' of 5.';
    };
    document.querySelector('input').onchange = e => {
      const name = e.target.files[0].name;
      const card = document.createElement('div');
      card.innerHTML = '<span role="progressbar"></span><button type="button">x</button>';
      const bar = card.firstChild, remove = card.lastChild;
      bar.setAttribute('aria-label', 'Uploading ' + name); remove.setAttribute('aria-label', 'Remove ' + name);
      remove.onclick = () => card.remove(); document.querySelector('form').append(card);
      setTimeout(() => { const b = document.createElement('button'); b.type = 'button'; b.textContent = 'file';
        b.setAttribute('aria-label', name); bar.replaceWith(b); }, 50);
    };</script>` }));
  const input = page.locator('#prompt-textarea');
  const file = { name: 'review-diff-test.txt', buffer: Buffer.from('한글 diff\n+all lines\n') };
  const prompt = 'review round 1\nfixed head and base';
  const uploaded = () => page.getByRole('button', { name: file.name, exact: true });
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
        assert(await uploaded().isVisible(), '첨부 완료 후 프롬프트를 입력한다');
        assert.equal(await page.getByRole('progressbar').count(), 0);
        await input.fill(text);
      };
      d.clickSend = async () => {
        assert(await uploaded().isVisible());
        assert.equal(await page.locator('[role="slider"]').getAttribute('aria-valuenow'), '4', '추론 강도를 최대로 두고 보낸다');
        assert.equal(await page.getByRole('menu').count(), 0, '메뉴를 닫고 보낸다');
        const sent = await page.locator('#upload-files').evaluate(async (el: HTMLInputElement) => el.files![0].text());
        assert.equal(sent, file.buffer.toString());
      };
      let reasoning = '';
      assert.equal(await d.sendAndCollect(prompt, (_url: string | null, r: string) => { reasoning = r; }, file), 'answer');
      assert.equal(reasoning, 'Latest · Pro (5/5)');
    });
    await t.test('숨은 이전 화면 입력창이 먼저 있어도 보이는 입력창의 모델 메뉴를 쓴다', async () => {
      // 실측: 홈에서 화면 내부 이동으로 들어온 프로젝트 홈에 홈 입력창이 숨은 채(display:none 조상) 먼저 남았고,
      // 그 폼의 모델 버튼을 기다리다 "추론 강도를 최대로 맞추지 못했습니다" 로 매 라운드가 실패했다.
      const d = await driver();
      await page.evaluate(() => document.body.insertAdjacentHTML('afterbegin', '<div hidden><form data-chatgpt-composer>'
        + '<div contenteditable="true" role="textbox"></div><button type="button" aria-label="Select ChatGPT model">Pro</button></form></div>'));
      d.clickSend = async () => {};
      let reasoning = '';
      assert.equal(await d.sendAndCollect(prompt, (_url: string | null, r: string) => { reasoning = r; }), 'answer');
      assert.equal(reasoning, 'Latest · Pro (5/5)');
    });
    await t.test('추론 강도를 못 맞추면 보내지 않는다', async () => {
      const d = await driver();
      await page.locator('[data-reasoning-slider]').evaluate((el) => el.removeAttribute('data-reasoning-slider'));
      d.clickSend = async () => assert.fail('추론 강도 미확인 상태로 전송하면 안 된다');
      await assert.rejects(d.sendAndCollect(prompt, undefined, file), /추론 강도를 최대로 맞추지 못했습니다/);
      assert.equal(await uploaded().count(), 0, '첨부 전에 멈춘다');
    });
    await t.test('전송 확인 실패 시 자기 첨부도 제거한다', async () => {
      const d = await driver(); d.clickSend = async () => {}; d.verifyPromptSent = async () => false;
      await assert.rejects(d.sendAndCollect(prompt, undefined, file), /전송되지/);
      assert.equal((await input.innerText()).trim(), '');
      assert.equal(await page.getByRole('button', { name: /^Remove / }).count(), 0);
      assert.equal(await page.evaluate(() => (window as any).unintendedSend), undefined, '첨부 제거에 전송 단축키를 사용하지 않는다');
    });
    await t.test('업로드 실패 시 클릭하지 않고 자기 초안을 회수한다', async () => {
      const d = await driver();
      const mocked = t.mock.method(Object.getPrototypeOf(page.locator('body')), 'setInputFiles',
        async () => { throw new Error('upload failed'); });
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
      assert.equal(await page.getByRole('button', { name: `Remove ${file.name}` }).count(), 1);
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
