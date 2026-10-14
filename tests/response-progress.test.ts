import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ChatGPTDriver, GenerationEndedError, QuotaLimitError, ResponseTimeoutError } from '../src/chatgpt.js';
import { loadConfig } from '../src/config.js';
import { progress } from '../src/progress.js';
import { VERSION } from '../src/version.js';

// 답은 서버 기록에서만 받는다 — 아래 탭은 서버 조회(`fetchServerInPage`) 말고는 아무것도 돌려주지 않는다.
const CHAT = 'https://chatgpt.com/g/g-p-6aa1d12d5db88191870747513394cb0e-jadong-pr-ribyu/c/6acd33bf-39f0-83e8-add2-09d48b0af407';
const sentAt = Date.parse('2026-10-14T22:20:58Z');

/** 서버 기록 — 마지막 질문의 시각과 그 뒤의 최종 답 (2026-10-15 실측 모양을 줄였다). */
const record = (askedAt: number, text = '{"summary":"ok"}', q = 'q') => ({
  current_node: 'a',
  mapping: {
    [q]: { parent: null, message: { author: { role: 'user' }, create_time: askedAt / 1000, content: { content_type: 'text', parts: ['리뷰'] } } },
    a: { parent: q, message: { author: { role: 'assistant' }, recipient: 'all', status: 'finished_successfully', end_turn: true,
      content: { content_type: 'text', parts: [text] } } },
  },
});

function rig(t: TestContext, server: (path: string, elapsed: number) => unknown, budget = 25 * 60_000) {
  let now = sentAt;
  t.mock.method(Date, 'now', () => now);
  const logs: string[] = [];
  t.mock.method(console, 'log', (line: unknown) => logs.push(String(line)));
  const driver = new ChatGPTDriver({ ...loadConfig('tests/__missing__.json'), responseTimeoutMs: budget }) as any;
  driver.nap = async (ms: number) => { now += ms; };
  driver.detectQuotaLimit = async () => null;
  driver.uiTextTail = async () => 'Something went wrong';
  const page = {
    url: () => CHAT,
    evaluate: async (_fn: unknown, arg?: { path?: string }) =>
      arg?.path ? server(arg.path, now - sentAt) : assert.fail('답을 화면에서 읽으면 안 된다'),
    locator: () => assert.fail('답을 화면에서 읽으면 안 된다'),
  };
  // 보내기 전 기록의 마지막 질문은 prev 였다
  const collect = () => driver.collectResponse(page, budget, { askedBefore: 'prev' });
  return { driver, collect, logs, elapsed: () => now - sentAt };
}

const status = (path: string, value: string) => path.endsWith('/stream_status') ? { status: value } : null;

// 9차가 7차의 답을 게시했던 모양 — 화면은 남의 노드를 끝난 답으로 읽었다. 이제 화면은 답의 출처가 아니다.
test('서버가 생성 중이면 기다렸다가, 끝나면 기록의 이번 답을 받는다', async (t) => {
  const phases: string[] = [];
  t.mock.method(progress, 'stream', (phase: string) => phases.push(phase));
  const r = rig(t, (path, ms) => status(path, ms < 90_000 ? 'IS_STREAMING' : 'COMPLETE') ?? record(sentAt + 1_000));
  assert.equal(await r.collect(), '{"summary":"ok"}');
  assert.ok(r.elapsed() >= 90_000, `${r.elapsed()}ms`);
  assert.ok(phases.includes('생성 중'));
  // 터미널에는 폴링마다가 아니라 상태가 바뀔 때만 한 줄
  assert.equal(r.logs.filter(line => line.includes('경과')).length, 1);
  assert.equal(progress.state().snapshot.version, VERSION);
});

test('직전 턴의 답만 기록에 있으면 받지 않는다 — 아무것도 오지 않으면 생성 종료, 한도 배너면 한도', async (t) => {
  // 앞 라운드가 빨리 끝나 직전 질문이 30초 전에 나갔다 — 시각으로는 못 가른다 (#68 리뷰)
  const stale = (path: string) => status(path, 'COMPLETE') ?? record(sentAt - 30_000, '직전 라운드의 답', 'prev');
  const ended = rig(t, stale);
  await assert.rejects(ended.collect(), (e: Error) => e instanceof GenerationEndedError && e.message.includes('Something went wrong'));
  // 회수 경로의 예산(150초) 안에 끝나야 회수 루프가 타임아웃으로 다시 돌지 않는다.
  assert.ok(ended.elapsed() < 150_000, `${ended.elapsed()}ms`);

  const quota = rig(t, stale);
  quota.driver.detectQuotaLimit = async () => "You've reached your limit";
  await assert.rejects(quota.collect(), QuotaLimitError);

  // 생성 요청이 아직 날아가는 중이면 끝난 게 아니다 — 예산까지 기다린다.
  const inFlight = rig(t, stale, 60_000);
  inFlight.driver.netInFlight = 1;
  await assert.rejects(inFlight.collect(), ResponseTimeoutError);
});

test('서버 기록을 계속 못 읽으면 화면 글자로 대신하지 않고 실패한다 — 한두 번의 실패는 넘긴다', async (t) => {
  const down = rig(t, () => null);
  await assert.rejects(down.collect(), (e: Error) =>
    !(e instanceof ResponseTimeoutError) && !(e instanceof GenerationEndedError) && /서버 기록을 .*읽지 못합니다/.test(e.message));
  assert.ok(down.elapsed() >= 120_000 && down.elapsed() < 150_000, `${down.elapsed()}ms`);

  const flaky = rig(t, (path, ms) => ms < 20_000 ? null : status(path, 'COMPLETE') ?? record(sentAt));
  assert.equal(await flaky.collect(), '{"summary":"ok"}');
});

test('예산이 다 돼도 서버가 생성 중이면 같은 예산을 더 주되, 연장 2회에서 접는다', async (t) => {
  const budget = 25 * 60_000;
  // 실측 39분 (sky-fishing#2, 1.8MB diff) — 25분 예산을 한 번 연장해 받는다.
  const slow = rig(t, (path, ms) => status(path, ms < 39 * 60_000 ? 'IS_STREAMING' : 'COMPLETE') ?? record(sentAt));
  assert.equal(await slow.collect(), '{"summary":"ok"}');

  const forever = rig(t, path => status(path, 'IS_STREAMING') ?? record(sentAt));
  await assert.rejects(forever.collect(), /75분/);
  assert.ok(forever.elapsed() >= 3 * budget && forever.elapsed() < 3 * budget + 15_000, `${forever.elapsed()}ms`);
});
