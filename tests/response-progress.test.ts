import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatGPTDriver, GenerationEndedError, ResponseTimeoutError } from '../src/chatgpt.js';
import { loadConfig } from '../src/config.js';
import { progress } from '../src/progress.js';
import { VERSION } from '../src/version.js';

test('회수 예산은 생성 중 부분 응답을 거부하고 고장난 중지 버튼의 120초 판정도 허용한다', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const cfg = { ...loadConfig('tests/__missing__.json'), responseTimeoutMs: 25 * 60_000 };
  const driver = new ChatGPTDriver(cfg) as any;
  let streaming = true;
  driver.isStreaming = async () => streaming;
  driver.interruptedBanner = async () => null;
  driver.detectQuotaLimit = async () => null;
  driver.dumpStopButtons = async () => 'fixture';
  driver.page = {
    waitForTimeout: async (ms: number) => { now += ms; },
    evaluate: async () => [{ role: 'user', id: 'question' }, { role: 'assistant', id: 'answer' }],
    locator: () => ({ locator: () => ({ count: async () => 1, allInnerTexts: async () => ['response'] }) }),
  };
  await assert.rejects(driver.collectFrom(0, 30_000), ResponseTimeoutError);
  assert(now < 60_000);
  assert.equal(cfg.responseTimeoutMs, 25 * 60_000);
  driver.sawGeneration = true;
  driver.netInFlight = 0;
  driver.lastNetAt = 1000;
  assert.equal(await driver.collectFrom(0, 150_000), 'response');
  streaming = false;
  assert.equal(await driver.collectFrom(0, 30_000), 'response');
});

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

test('생성 표시도 답도 없으면 한 번 새로고침한 뒤 GenerationEndedError 로 접는다', async (t) => {
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'log', () => {});
  const make = (inFlight: number) => {
    const driver = new ChatGPTDriver({ ...loadConfig('tests/__missing__.json'), responseTimeoutMs: 25 * 60_000 }) as any;
    driver.isStreaming = async () => false; // ChatGPT 에서 중지됨 — 버튼이 없다
    driver.netInFlight = inFlight;
    driver.interruptedBanner = async () => null;
    driver.detectQuotaLimit = async () => null;
    driver.dumpStopButtons = async () => 'fixture';
    driver.uiTextTail = async () => 'Something went wrong';
    return driver;
  };
  let reloads = 0;
  const page = {
    waitForTimeout: async (ms: number) => { now += ms; },
    reload: async () => { reloads++; },
    evaluate: async () => [{ role: 'user', id: 'question' }],
    locator: () => ({ locator: () => ({ count: async () => 0, allInnerTexts: async () => [] }) }),
  };

  await assert.rejects(make(0).collectResponse(page, 0, null),
    (e: Error) => e instanceof GenerationEndedError && e.message.includes('Something went wrong'));
  assert.equal(reloads, 1);
  // 회수 경로의 예산(150초) 안에 끝나야 회수 루프가 타임아웃으로 다시 돌지 않는다.
  assert.ok(now - 1_000 < 150_000, `${now - 1_000}ms`);

  // 생성 요청이 아직 날아가는 중이면 끝난 게 아니다 — 예산까지 기다린다.
  reloads = 0;
  await assert.rejects(make(1).collectResponse(page, 0, null, 60_000), ResponseTimeoutError);
  assert.equal(reloads, 0);
});
