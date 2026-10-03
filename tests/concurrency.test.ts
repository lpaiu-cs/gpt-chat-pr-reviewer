import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewBatchSize } from '../src/queue.js';
import { parseIntent } from '../src/ui/server.js';
import { ChatGPTDriver } from '../src/chatgpt.js';
import { loadConfig } from '../src/config.js';

// ── 동시 리뷰 탭 ───────────────────────────────────────────
//
// 실측: 새 탭이 입력창을 15초 안에 못 띄워 PR 라운드가 실패로 기록됐고, 한 탭이
// 입력하는 동안 옆 탭이 전송하자 전송 버튼·입력창이 사라졌다. 새 탭은 라운드 전에
// 준비하고, 진입~전송은 한 줄로 서며, 겹치는 건 응답 대기뿐이다.

/** fork 가 새 탭을 입력창까지 미리 여는 데 필요한 만큼만 흉내 낸다. */
function freshTab(composer: () => Promise<void> = async () => {}) {
  const tab = {
    closed: false,
    isClosed: () => tab.closed, on() {}, goto: async () => {},
    url: () => 'https://chatgpt.com/', title: async () => 'Just a moment...',
    locator: () => ({ first: () => ({ waitFor: composer }), innerText: async () => 'Verify you are human' }),
    close: async () => { tab.closed = true; },
  };
  return tab;
}

function ownerWith(tab: ReturnType<typeof freshTab>) {
  const owner = new ChatGPTDriver({ ...loadConfig('tests/__missing__.json'), headless: false }) as any;
  owner.ctx = { browser: () => null, newPage: async () => tab };
  owner.page = freshTab();
  return owner;
}

test('새 탭이 입력창까지 못 가면 탭 임대가 실패하고 탭을 닫는다 — 라운드는 시작하지 않는다', async () => {
  // 실측: 새 탭이 입력창을 15초 안에 못 띄워 PR 라운드가 실패로 기록됐다.
  // 임대 단계에서 걸러야 PR 이 오류·재시도 횟수를 떠안지 않는다.
  const tab = freshTab(async () => { throw new Error('locator.waitFor: Timeout 15000ms exceeded.\nCall log:\n  - waiting'); });
  await assert.rejects(ownerWith(tab).fork(), (error: Error) => {
    const first = error.message.split('\n')[0];
    assert.match(first, /Timeout 15000ms/);
    assert.match(first, /Just a moment.*Verify you are human/); // 무엇이 떠 있었는지 첫 줄에 남는다
    return true;
  });
  assert.equal(tab.closed, true);
});

test('동시 리뷰 탭은 진입~전송을 한 줄로 하고 응답 대기만 겹친다', { timeout: 5_000 }, async () => {
  const owner = ownerWith(freshTab());
  const sibling = await owner.fork();
  const tab = freshTab();

  let answered!: () => void;
  const answer = new Promise<void>((resolve) => { answered = resolve; });
  owner.isStreaming = async () => false;
  owner.interruptedBanner = async () => null;
  owner.page = {
    ...tab,
    waitForTimeout: () => answer, // 응답이 올 때까지 대기 — 이 사이에 옆 탭이 들어와야 한다
    evaluate: async () => [{ role: 'user', id: 'q' }, { role: 'assistant', id: 'a' }],
    locator: () => ({ locator: () => ({ count: async () => 1, allInnerTexts: async () => ['answer'] }) }),
  };

  const log: string[] = [];
  const a = owner.withTurn(async () => {
    log.push('A 입력');
    await new Promise((resolve) => setTimeout(resolve, 20));
    log.push('A 전송');
    return owner.collectFrom(0, 60_000); // 실제 응답 대기 경로에서 차례를 넘긴다
  });
  await sibling.withTurn(async () => { log.push('B 입력'); });
  answered();
  assert.equal(await a, 'answer');
  assert.deepEqual(log, ['A 입력', 'A 전송', 'B 입력']);

  // 실패한 라운드도 차례를 넘긴다 — 아니면 옆 탭이 영영 못 들어온다.
  await assert.rejects(owner.withTurn(async () => { throw new Error('진입 실패'); }), /진입 실패/);
  assert.equal(await sibling.withTurn(async () => 'next'), 'next');
});

// ── 배치 크기 ──────────────────────────────────────────────

test('기본값 1 은 종전대로 한 건씩 돈다', () => {
  assert.equal(reviewBatchSize(1, 5), 1);
});

test('설정한 만큼 묶되 대기열보다 많이 잡지 않는다', () => {
  assert.equal(reviewBatchSize(5, 2), 2);
  assert.equal(reviewBatchSize(2, 5), 2);
});

test('0 은 제한 없음 — 대기열 전체', () => {
  assert.equal(reviewBatchSize(0, 7), 7);
});

test('대기열이 비면 아무것도 돌리지 않는다', () => {
  assert.equal(reviewBatchSize(0, 0), 0);
  assert.equal(reviewBatchSize(5, 0), 0);
});

test('손으로 고친 이상한 값은 순차로 접는다', () => {
  // 설정 파일은 사람이 직접 여는 곳이다. 여기서 흘려보내면 탭이 몇 개 열릴지
  // 아무도 모르게 된다 — 모르는 값의 기본 방향은 "덜 쓰는 쪽" 이다.
  assert.equal(reviewBatchSize(Number.NaN, 5), 1);
  assert.equal(reviewBatchSize(Number.POSITIVE_INFINITY, 5), 1);
  assert.equal(reviewBatchSize(2.7, 5), 2); // 소수는 내린다
  // 제한 없음은 정확히 0 뿐이다. `-1` 오타가 대기열 전체를 한꺼번에 돌리면,
  // 그 한 글자가 ChatGPT 한도와 브라우저를 통째로 태운다.
  assert.equal(reviewBatchSize(-1, 5), 1);
  assert.equal(reviewBatchSize(-3.5, 5), 1);
});

// ── 의도 검증 ──────────────────────────────────────────────

test('동시 실행 수 변경은 0 이상의 정수만 받는다', () => {
  assert.deepEqual(parseIntent({ kind: 'concurrency-set', value: 5 }), {
    kind: 'concurrency-set',
    value: 5,
  });
  assert.deepEqual(parseIntent({ kind: 'concurrency-set', value: 0 }), {
    kind: 'concurrency-set',
    value: 0,
  });
  for (const bad of [-1, 1.5, 'many', null, undefined]) {
    assert.equal(typeof parseIntent({ kind: 'concurrency-set', value: bad }), 'string');
  }
});

test('미룬 의도는 맨 앞으로 돌아가고 루프를 깨우지 않는다', async () => {
  const { intents } = await import('../src/intents.js');
  intents.drain();
  let woken = 0;
  intents.onPending = () => { woken++; };
  intents.push({ kind: 'pause' });
  const [switchA, switchB] = [{ kind: 'account-switch', action: 'start' }, { kind: 'account-switch', action: 'complete' }] as const;
  intents.defer([switchA, switchB]);
  assert.equal(woken, 1, 'defer 는 onPending 을 부르지 않는다 — 부르면 같은 의도를 미루며 스캔만 반복한다');
  assert.deepEqual(intents.drain(), [switchA, switchB, { kind: 'pause' }]);
  intents.onPending = undefined;
});
