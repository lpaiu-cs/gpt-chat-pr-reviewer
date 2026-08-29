import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQueue, TIER_FIRST_ROUND, TIER_AUTHOR_RESPONDED } from '../src/queue.js';
import { createContext } from '../src/state/store.js';
import type { PRContext, PRInfo } from '../src/types.js';

/**
 * 큐 순서 — **한 스캔에서 함께 발견한 PR 은 번호 오름차순으로 돈다.**
 *
 * probe 는 GitHub 이 주는 순서(최근 갱신 순 ≈ 번호 내림차순)로 돈다. 신규
 * 컨텍스트의 대기 시각이 생성 순간이면 그 순서가 그대로 큐 순서가 되어 #7 → #1
 * 로 거꾸로 처리된다 — 실측으로 그렇게 돌았다. 대기 시각을 스캔 단위로 맞춰야
 * 동점이 되고, 그때 비로소 번호 기준이 순서를 정한다.
 */

const info = (repo: string, number: number): PRInfo => ({
  owner: 'o',
  repo,
  number,
  url: `https://github.com/o/${repo}/pull/${number}`,
  title: `PR ${number}`,
  author: 'a',
  baseBranch: 'main',
  headBranch: `f${number}`,
  headSha: `sha${number}`,
});

const keys = (cs: PRContext[]): string[] =>
  buildQueue(cs).map((e) => `${e.ctx.repo}#${e.ctx.prNumber}`);

test('한 스캔에서 발견한 PR 은 번호 오름차순으로 돈다', () => {
  // probe 가 주는 순서 그대로 만든다 — 최근 갱신 순이라 번호가 큰 것부터다.
  const at = '2026-08-29T13:18:33.000Z';
  const cs = [7, 6, 5, 4, 3, 2, 1].map((n) => createContext(info('r', n), at));
  assert.deepEqual(keys(cs), ['r#1', 'r#2', 'r#3', 'r#4', 'r#5', 'r#6', 'r#7']);
});

test('발견 시각을 PR 마다 따로 찍으면 거꾸로 돈다 (회귀 재현)', () => {
  // 고치기 전 동작: createContext 가 호출마다 지금을 찍었다. 밀리초 차이가
  // 그대로 순서가 되어, probe 반환 순서(번호 내림차순)가 큐 순서가 됐다.
  const cs = [7, 6, 5, 4, 3, 2, 1].map((n, i) =>
    createContext(info('r', n), new Date(Date.parse('2026-08-29T13:18:33.000Z') + i * 500).toISOString()),
  );
  assert.deepEqual(keys(cs), ['r#7', 'r#6', 'r#5', 'r#4', 'r#3', 'r#2', 'r#1']);
});

test('동점이면 레포로 먼저 묶는다 — 번호만으로 줄 세워 번갈아 나오지 않게', () => {
  const at = '2026-08-29T13:18:33.000Z';
  const cs = [
    createContext(info('beta', 2), at),
    createContext(info('alpha', 3), at),
    createContext(info('beta', 1), at),
    createContext(info('alpha', 1), at),
  ];
  assert.deepEqual(keys(cs), ['alpha#1', 'alpha#3', 'beta#1', 'beta#2']);
});

test('실제로 오래 기다린 것은 여전히 먼저 간다 — 번호가 뒤집지 않는다', () => {
  // 스캔 단위로 맞추는 것은 **함께 발견한** 경우뿐이다. 사이클이 다르면 대기
  // 시각이 진짜로 다르고, 그 순서가 번호보다 우선이다.
  const older = createContext(info('r', 9), '2026-08-29T10:00:00.000Z');
  const newer = createContext(info('r', 2), '2026-08-29T13:00:00.000Z');
  assert.deepEqual(keys([newer, older]), ['r#9', 'r#2']);
});

test('티어가 번호보다 우선이다 — 1차 리뷰가 재리뷰보다 먼저', () => {
  const at = '2026-08-29T13:18:33.000Z';
  const fresh = createContext(info('r', 9), at); // round 0 = 1차
  const second = createContext(info('r', 1), at);
  second.round = 1;
  second.history = [
    { at, event: 'AUTHOR_RESPONDED', from: 'AWAITING_AUTHOR', to: 'REVIEW_DUE' },
  ] as PRContext['history'];

  const q = buildQueue([second, fresh]);
  assert.deepEqual(
    q.map((e) => e.ctx.prNumber),
    [9, 1],
  );
  assert.equal(q[0].tier, TIER_FIRST_ROUND);
  assert.equal(q[1].tier, TIER_AUTHOR_RESPONDED);
});
