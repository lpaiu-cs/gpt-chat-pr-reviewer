import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatGPTDriver } from '../src/chatgpt.js';
import { loadConfig } from '../src/config.js';

test('paste success is determined by complete content, with no large or partial-input fallback', async (t) => {
  const logs: string[] = [];
  t.mock.method(console, 'log', (line: string) => logs.push(line));
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
        if (fn.name === 'readComposerInPage') return content; // 검증용 본문 읽기
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
  assert.equal(logs.length, 1, 'normal chunked input emits one summary');
  assert.match(logs[0], /입력 완료: .*7조각 · 검증 통과/);
  chunks = [];
  const unicode = '😀'.repeat(3999) + '\r\n' + '😀'.repeat(4001);
  pasted = unicode.replace(/\r\n/g, '\n');
  await driver.fillPrompt(page, unicode);
  assert.equal(chunks.join(''), pasted);
  pasted = text.slice(0, -10);
  logs.length = 0;
  // 실패는 무엇이 들어갔는지를 숫자로 말해야 한다 — 그게 원인을 가르는 증거다.
  await assert.rejects(driver.fillPrompt(page, text), /첫 불일치 \d+ .*조각별 누적 \d/s);
  assert.ok(logs.every(line => !line.includes('검증 통과')));
  // 실패한 입력은 비워둔다 — 남으면 다음 라운드의 프로젝트 진입 가드에 걸린다.
  assert.equal(content, '');
  pasted = '';
  await assert.rejects(driver.fillPrompt(page, text), /전체 내용/);
  assert.equal(inserts, 0);
  await driver.fillPrompt(page, 'small');
  assert.equal(inserts, 1);
});

test('입력 검증은 줄바꿈 개수만 무시하고 글자는 전부 대조한다', async () => {
  const { composerText } = await import('../src/chatgpt.js');
  // 실측(2026-09 개편 입력창): URL 이 링크 위젯이 되며 앞에 줄바꿈이 하나 더, 끝에 두 개가 붙었다.
  const sent = '## 대상 PR\nhttps://github.com/o/r/pull/1\n리뷰 라운드: 1차\n\n\n끝';
  const shown = '## 대상 PR\n\nhttps://github.com/o/r/pull/1\n리뷰 라운드: 1차\n\n\n끝\n\n';
  assert.equal(composerText(shown), composerText(sent));
  // 옛 칩 사고: URL 글자가 owner/repo#N 으로 바뀌면 여전히 불일치다.
  assert.notEqual(composerText(shown.replace('https://github.com/o/r/pull/1', '\uFEFFo/r#1\uFEFF')), composerText(sent));
  assert.notEqual(composerText(sent.slice(0, -1)), composerText(sent)); // 잘림
});
