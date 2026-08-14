import test from 'node:test';
import assert from 'node:assert/strict';
import { commentDigest, dropDuplicateComments } from '../src/poster.js';
import { adoptThreads, latestRoundThreads, fullSyncDue } from '../src/reviewer.js';
import type { AppConfig, PRContext, ReviewComment } from '../src/types.js';
import type { SyncThread } from '../src/github.js';

const VIEWER = 'reviewer-bot';

function ctxWith(threads: PRContext['threads']): PRContext {
  return {
    prUrl: 'https://github.com/o/r/pull/1',
    owner: 'o',
    repo: 'r',
    prNumber: 1,
    title: 't',
    state: 'AWAITING_AUTHOR',
    round: 2,
    requestedCount: 0,
    retryCount: 0,
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    threads,
    history: [],
  } as PRContext;
}

function thread(over: Partial<SyncThread> & { id: string }): SyncThread {
  return {
    isResolved: false,
    path: 'a.ts',
    line: 10,
    isHidden: false,
    comments: [{ author: VIEWER, body: '지적입니다', isHidden: false }],
    ...over,
  } as SyncThread;
}

// ── 중복 코멘트 ────────────────────────────────────────────

const comment = (path: string, line: number, body: string): ReviewComment => ({ path, line, body });

test('같은 자리·같은 내용은 게시 대상에서 빠진다', () => {
  const live = [{ path: 'a.ts', line: 10, digest: commentDigest('같은 지적') }];
  const { kept, dropped } = dropDuplicateComments(
    [comment('a.ts', 10, '같은 지적'), comment('a.ts', 20, '다른 지적')],
    live,
  );
  assert.deepEqual(kept.map((c) => c.line), [20]);
  assert.deepEqual(dropped.map((c) => c.line), [10]);
});

test('공백 차이는 같은 지적으로 본다', () => {
  const live = [{ path: 'a.ts', line: 10, digest: commentDigest('같은  지적\n입니다') }];
  const { dropped } = dropDuplicateComments([comment('a.ts', 10, '같은 지적 입니다')], live);
  assert.equal(dropped.length, 1);
});

test('같은 문구라도 다른 줄이면 남긴다', () => {
  const live = [{ path: 'a.ts', line: 10, digest: commentDigest('같은 실수') }];
  const { kept } = dropDuplicateComments([comment('a.ts', 44, '같은 실수')], live);
  assert.equal(kept.length, 1);
});

test('지문이 없는 구버전 스레드는 대조하지 않는다', () => {
  const { kept } = dropDuplicateComments([comment('a.ts', 10, '지적')], [
    { path: 'a.ts', line: 10 },
  ]);
  assert.equal(kept.length, 1);
});

// ── 숨긴 스레드 ────────────────────────────────────────────

test('숨긴 스레드는 추적하지 않는다', () => {
  const ctx = ctxWith([]);
  adoptThreads(ctx, [thread({ id: 'T1', isHidden: true }), thread({ id: 'T2' })], VIEWER, 2);
  assert.deepEqual(ctx.threads.map((t) => t.id), ['T2']);
  // id 는 남겨야 probe 가 매번 "미지의 스레드" 로 전체 동기화를 부르지 않는다
  assert.deepEqual([...(ctx.knownThreadIds ?? [])].sort(), ['T1', 'T2']);
});

test('이미 추적 중이던 스레드도 숨겨지면 빠진다', () => {
  const ctx = ctxWith([
    { id: 'T1', path: 'a.ts', line: 10, isResolved: false, authorReplied: false, round: 2, snippet: '' },
  ]);
  adoptThreads(ctx, [thread({ id: 'T1', isHidden: true })], VIEWER, 2);
  assert.equal(ctx.threads.length, 0);
});

test('숨긴 답글은 작성자 응답으로 세지 않는다', () => {
  const ctx = ctxWith([]);
  adoptThreads(
    ctx,
    [
      thread({
        id: 'T1',
        comments: [
          { author: VIEWER, body: '지적', isHidden: false },
          { author: 'someone', body: '답글', isHidden: true },
        ],
      }),
    ],
    VIEWER,
    2,
  );
  assert.equal(ctx.threads[0].authorReplied, false);
});

test('adoptThreads 는 첫 코멘트 본문의 지문을 남긴다', () => {
  const ctx = ctxWith([]);
  adoptThreads(ctx, [thread({ id: 'T1' })], VIEWER, 2);
  assert.equal(ctx.threads[0].digest, commentDigest('지적입니다'));
});

test('전체 동기화는 주기가 지나면 다시 돈다 (숨김을 보는 유일한 경로)', () => {
  const cfg = { fullSyncIntervalMs: 600_000 } as AppConfig;
  const now = Date.parse('2026-08-14T01:00:00.000Z');
  const ctx = ctxWith([]);

  assert.equal(fullSyncDue(cfg, ctx, now), true); // 한 번도 안 돌았다
  ctx.lastFullSyncAt = '2026-08-14T00:55:00.000Z';
  assert.equal(fullSyncDue(cfg, ctx, now), false); // 5분 전 — 아직
  ctx.lastFullSyncAt = '2026-08-14T00:45:00.000Z';
  assert.equal(fullSyncDue(cfg, ctx, now), true); // 15분 전 — 다시 돈다
  ctx.lastFullSyncAt = '알 수 없는 값';
  assert.equal(fullSyncDue(cfg, ctx, now), true); // 판별 불가는 도는 쪽으로
});

test('마지막 라운드가 통째로 숨겨지면 직전 라운드가 판정 대상이 된다', () => {
  const ctx = ctxWith([
    { id: 'T1', path: 'a.ts', line: 1, isResolved: false, authorReplied: false, round: 6, snippet: '' },
    { id: 'T2', path: 'a.ts', line: 2, isResolved: false, authorReplied: false, round: 7, snippet: '' },
  ]);
  assert.deepEqual(latestRoundThreads(ctx).map((t) => t.id), ['T2']);

  ctx.threads = ctx.threads.filter((t) => t.round !== 7); // 7차가 숨겨져 빠진 상태
  assert.deepEqual(latestRoundThreads(ctx).map((t) => t.id), ['T1']);
});
