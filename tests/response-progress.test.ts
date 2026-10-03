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

test('앞선 중단을 복구한 이력으로 이번 빈 구간을 새로고침 없이 종료로 확정하지 않는다 (#51 리뷰)', async (t) => {
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'log', () => {});
  let reloads = 0;
  let resumeUntil = 0;
  const driver = new ChatGPTDriver({ ...loadConfig('tests/__missing__.json'), responseTimeoutMs: 25 * 60_000 }) as any;
  // 30초 생성 → 배너로 끊김 → 새로고침 뒤 30초 더 생성 → 배너 없이 버튼·답이 사라진다.
  driver.isStreaming = async () => now < 31_000 || (reloads === 1 && now < resumeUntil);
  driver.interruptedBanner = async () => (reloads === 0 && now >= 31_000 ? 'Connection interrupted' : null);
  driver.detectQuotaLimit = async () => null;
  driver.dumpStopButtons = async () => 'fixture';
  driver.uiTextTail = async () => '';
  const page = {
    waitForTimeout: async (ms: number) => { now += ms; },
    reload: async () => { reloads++; if (reloads === 1) resumeUntil = now + 36_000; },
    evaluate: async () => [{ role: 'user', id: 'question' }],
    locator: () => ({ locator: () => ({ count: async () => 0, allInnerTexts: async () => [] }) }),
  };
  await assert.rejects(driver.collectResponse(page, 0, null), GenerationEndedError);
  // 배너 복구 1회 + 이번 빈 구간의 재확인 1회. 이력만 보고 바로 던지면 1이다.
  assert.equal(reloads, 2);
});

test('예산이 다 돼도 생성이 확실히 진행 중이면 예산을 더 주고, 버튼만 남은 고장은 연장하지 않는다', async (t) => {
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'log', () => {});
  const budget = 25 * 60_000;
  const make = (alive: boolean, answerAt: number) => {
    const driver = new ChatGPTDriver({ ...loadConfig('tests/__missing__.json'), responseTimeoutMs: budget }) as any;
    driver.isStreaming = async () => now < answerAt;
    driver.sawGeneration = true;
    driver.netInFlight = alive ? 1 : 0; // 고장 쪽은 생성 요청이 없다
    driver.lastNetAt = 1_000;
    driver.interruptedBanner = async () => null;
    driver.detectQuotaLimit = async () => null;
    driver.dumpStopButtons = async () => 'fixture';
    driver.uiTextTail = async () => '';
    const page = {
      waitForTimeout: async (ms: number) => { now += ms; },
      evaluate: async () => [{ role: 'user', id: 'q' }, ...(now >= answerAt ? [{ role: 'assistant', id: 'a' }] : [])],
      locator: () => ({ locator: () => ({ count: async () => 1, allInnerTexts: async () => ['answer'] }) }),
    };
    return { driver, page };
  };

  // 실측 39분 (sky-fishing#2, 1.8MB diff) — 25분 예산을 한 번 연장해 받는다.
  const slow = make(true, 1_000 + 39 * 60_000);
  assert.equal(await slow.driver.collectResponse(slow.page, 0, null), 'answer');

  // 버튼만 남고 생성 요청이 없다 (이슈 #1) — 연장하지 않고 예산에서 접는다.
  now = 1_000;
  const stuck = make(false, Number.POSITIVE_INFINITY);
  await assert.rejects(stuck.driver.collectResponse(stuck.page, 0, null), ResponseTimeoutError);
  assert.ok(now - 1_000 < budget + 10_000, `${now - 1_000}ms`);

  // 생성 요청이 끝없이 살아 있어도 상한(연장 2회)에서 접는다.
  now = 1_000;
  const forever = make(true, Number.POSITIVE_INFINITY);
  await assert.rejects(forever.driver.collectResponse(forever.page, 0, null), /75분/);
  assert.ok(now - 1_000 >= 3 * budget && now - 1_000 < 3 * budget + 10_000, `${now - 1_000}ms`);
});
