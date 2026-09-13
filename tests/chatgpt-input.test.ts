import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatGPTDriver } from '../src/chatgpt.js';
import { loadConfig } from '../src/config.js';

test('paste success is determined by complete content, with no large or partial-input fallback', async () => {
  const driver = new ChatGPTDriver(loadConfig()) as any;
  driver.focusInput = async () => {};
  let content = '';
  let pasted = '';
  let inserts = 0;
  let chunks: string[] = [];
  const page = {
    keyboard: { press: async (key: string) => { if (key === 'Delete') content = ''; }, insertText: async (text: string) => { inserts++; content = text; } },
    locator: () => ({ first: () => ({
      innerText: async () => content,
      evaluate: async (fn: (el: unknown, chunk: string) => void, chunk?: string) => {
        if (chunk === undefined) return content.length; // 조각마다 재는 누적 길이
        chunks.push(chunk);
        assert.ok(chunk.length <= 8000); // below the 10k attachment threshold even for emoji
        // 실제 붙여넣기 함수를 돌려 clipboard 형식을 본다. text/plain 이 다시 들어가면
        // ChatGPT 가 본문의 GitHub URL 을 참조 칩으로 바꿔 검증이 영영 실패한다.
        const types: string[] = [];
        const g = globalThis as any;
        g.DataTransfer = class { setData(type: string) { types.push(type); } };
        g.ClipboardEvent = class { constructor(_type: string, _init: unknown) {} };
        fn({ focus() {}, dispatchEvent: () => false }, chunk);
        assert.deepEqual(types, ['text/html']);
        content = pasted;
        return false; // preventDefault is normal success
      },
    }) }),
  };
  const text = '한글 <code>  \n\n'.repeat(2000);
  pasted = text;
  await driver.fillPrompt(page, text);
  assert.equal(inserts, 0);
  assert.equal(chunks.join(''), text);
  chunks = [];
  const unicode = '😀'.repeat(3999) + '\r\n' + '😀'.repeat(4001);
  pasted = unicode.replace(/\r\n/g, '\n');
  await driver.fillPrompt(page, unicode);
  assert.equal(chunks.join(''), pasted);
  pasted = text.slice(0, -10);
  // 실패는 무엇이 들어갔는지를 숫자로 말해야 한다 — 그게 원인을 가르는 증거다.
  await assert.rejects(driver.fillPrompt(page, text), /첫 불일치 \d+ .*조각별 누적 \d/s);
  // 실패한 입력은 비워둔다 — 남으면 다음 라운드의 프로젝트 진입 가드에 걸린다.
  assert.equal(content, '');
  pasted = '';
  await assert.rejects(driver.fillPrompt(page, text), /전체 내용/);
  assert.equal(inserts, 0);
  await driver.fillPrompt(page, 'small');
  assert.equal(inserts, 1);
});
