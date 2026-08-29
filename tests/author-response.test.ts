import test from 'node:test';
import assert from 'node:assert/strict';
import { awaitedThreadsResolved } from '../src/reviewer.js';
import type { PRContext } from '../src/types.js';

/**
 * 작성자 응답 판정 — **게시 시점에 열려 있던 스레드**가 전부 resolve 됐는가.
 *
 * 이 판정이 잘못 서면 리뷰가 무한히 돈다. 실측: `sleep-management#3` 이 8~13차에서
 * 게시 6~11초 만에 재리뷰로 되돌아가며 14라운드·17요청까지 갔다. 원인은 인라인이
 * 하나도 안 달린 라운드(지적이 전부 리뷰 본문으로 간 경우) 뒤에 판정이 **예전
 * 라운드의 이미 resolve 된 스레드**로 물러선 것이었다.
 */

const thread = (id: string, isResolved: boolean, round = 1): PRContext['threads'][number] =>
  ({ id, path: 'a.ts', line: 1, isResolved, authorReplied: false, round, snippet: '' }) as PRContext['threads'][number];

const ctx = (over: Partial<PRContext>): PRContext =>
  ({ round: 1, threads: [], history: [], ...over }) as PRContext;

test('기다리던 스레드가 전부 resolve 되면 응답이다', () => {
  const c = ctx({
    awaitedThreadIds: ['T1', 'T2'],
    threads: [thread('T1', true), thread('T2', true)],
  });
  assert.equal(awaitedThreadsResolved(c), true);
});

test('하나라도 남아 있으면 응답이 아니다', () => {
  const c = ctx({
    awaitedThreadIds: ['T1', 'T2'],
    threads: [thread('T1', true), thread('T2', false)],
  });
  assert.equal(awaitedThreadsResolved(c), false);
});

test('지적이 전부 본문으로 간 라운드는 resolve 로 응답을 판정하지 않는다', () => {
  // 무한 재리뷰의 정확한 재현: 이번 라운드는 인라인을 하나도 만들지 않았고
  // (`awaitedThreadIds` 가 빈 배열), 예전 라운드 스레드는 이미 전부 resolve 다.
  // 예전에는 이 상태가 곧바로 "전체 resolve" 로 성립해 게시 직후 재리뷰가 돌았다.
  const c = ctx({
    round: 9,
    awaitedThreadIds: [],
    threads: [thread('T1', true, 7), thread('T2', true, 7)],
  });
  assert.equal(awaitedThreadsResolved(c), false, '새 커밋만이 응답이어야 한다');
});

test('게시 시점에 이미 resolve 되어 있던 스레드는 근거가 아니다', () => {
  // 스냅샷에 들어가지 않으므로, 그 상태가 그대로여도 응답으로 세지 않는다.
  const c = ctx({
    round: 9,
    awaitedThreadIds: ['T-new'],
    threads: [thread('T-old', true, 7), thread('T-new', false, 9)],
  });
  assert.equal(awaitedThreadsResolved(c), false);

  c.threads[1].isResolved = true; // 이번 라운드 것이 resolve 되면 그때가 응답이다
  assert.equal(awaitedThreadsResolved(c), true);
});

test('기다리던 스레드가 숨겨져 사라지면 응답으로 세지 않는다', () => {
  // 숨김은 resolve 가 아니다. 여기서 응답으로 세면 숨김 하나가 재리뷰를 부른다.
  const c = ctx({ round: 3, awaitedThreadIds: ['T1'], threads: [] });
  assert.equal(awaitedThreadsResolved(c), false);
});

test('전부 중복이라 게시하지 않은 라운드는 열려 있던 지적을 계속 기다린다', () => {
  // 새 스레드는 없지만 이미 열려 있던 지적이 스냅샷에 담긴다 — 그것이 대기의
  // 근거이므로, resolve 되면 응답이다.
  const c = ctx({
    round: 4,
    awaitedThreadIds: ['T-open'],
    threads: [thread('T-open', false, 2)],
  });
  assert.equal(awaitedThreadsResolved(c), false);
  c.threads[0].isResolved = true;
  assert.equal(awaitedThreadsResolved(c), true);
});

test('구버전 컨텍스트는 마지막 라운드 스레드로 근사한다', () => {
  // 스냅샷이 없으면(undefined) 마지막 라운드 것만 본다. 예전 라운드로 물러서지
  // 않으므로 무한 루프는 여기서도 성립하지 않는다.
  const old = ctx({ round: 5, threads: [thread('T1', true, 5), thread('T2', true, 5)] });
  assert.equal(awaitedThreadsResolved(old), true);

  const bodyOnly = ctx({ round: 9, threads: [thread('T1', true, 7)] }); // 9차는 스레드 없음
  assert.equal(awaitedThreadsResolved(bodyOnly), false, '예전 라운드로 물러서면 안 된다');
});
