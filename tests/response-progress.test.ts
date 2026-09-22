import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatGPTDriver } from '../src/chatgpt.js';
import { loadConfig } from '../src/config.js';
import { progress } from '../src/progress.js';
import { VERSION } from '../src/version.js';

test('본문 전 생성 대기는 정상 진행으로 표시하고 관측 한계 경고는 한 번만 남긴다', async (t) => {
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const logs: string[] = [];
  const phases: string[] = [];
  t.mock.method(console, 'log', (line: string) => logs.push(line));
  t.mock.method(progress, 'stream', (phase: string) => phases.push(phase));
  for (const tracked of [true, false]) {
    logs.length = 0;
    phases.length = 0;
    let step = 0;
    const driver = new ChatGPTDriver({ ...loadConfig('tests/__missing__.json'), responseTimeoutMs: 300_000 }) as any;
    driver.sawGeneration = tracked;
    driver.isStreaming = async () => step <= 81;
    driver.interruptedBanner = async () => null;
    const page = {
      waitForTimeout: async (ms: number) => {
        now += ms;
        step++;
        if (tracked) driver.lastNetAt = now - 2_000;
      },
      evaluate: async () => [
        { role: 'user', id: 'question' },
        ...(step >= 81 ? [{ role: 'assistant', id: 'answer' }] : []),
      ],
      locator: () => ({ locator: () => ({
        count: async () => 1,
        allInnerTexts: async () => ['complete answer'],
      }) }),
    };
    assert.equal(await driver.collectResponse(page, 0, null), 'complete answer');
    assert.ok(phases.includes('생성 중 · 본문 대기'));
    assert.ok(phases.includes('답변 수신 중'));
    assert.ok(phases.includes('완료 확인 중'));
    assert.equal(logs.filter(line => line.includes('⚠')).length, tracked ? 0 : 1);
    assert.equal(logs.filter(line => line.includes('본문 대기')).length, 2);
    assert.ok(logs.every(line => !line.includes('화면 변화 없음')));
  }
  assert.equal(progress.state().snapshot.version, VERSION);
});
