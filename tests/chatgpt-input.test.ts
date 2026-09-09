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
    keyboard: { press: async () => {}, insertText: async (text: string) => { inserts++; content = text; } },
    locator: () => ({ first: () => ({
      innerText: async () => content,
      evaluate: async (_fn: unknown, chunk: string) => {
        chunks.push(chunk);
        assert.ok(chunk.length <= 8000); // below the 10k attachment threshold even for emoji
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
  await assert.rejects(driver.fillPrompt(page, text), /전체 내용/);
  pasted = '';
  await assert.rejects(driver.fillPrompt(page, text), /전체 내용/);
  assert.equal(inserts, 0);
  await driver.fillPrompt(page, 'small');
  assert.equal(inserts, 1);
});
