import test from 'node:test';
import assert from 'node:assert/strict';
import { absorbsReviewedMerge, endedConverged } from '../src/reviewer.js';
import type { PRContext } from '../src/types.js';

/**
 * 스택 PR 의 베이스 머지는 새 코드가 아니다.
 *
 * 이 판정이 지켜야 할 것은 **미검토 코드를 검토 완료로 기록하지 않는 것**이다.
 * 흡수하면 그 변경은 영구히 리뷰를 건너뛰므로, 조금이라도 어긋나면 흡수하지
 * 않는다 — 틀리는 방향이 언제나 "한 번 더 리뷰한다" 쪽이어야 한다.
 */

const MINE = 'aaaa1111'; // 머지 전 이쪽 브랜치 tip = 우리가 검토한 head
const THEIRS = 'bbbb2222'; // 들어온 브랜치 tip = 다른 PR 이 수렴시킨 head
const MERGE = 'cccc3333'; // GitHub 이 그 PR 을 머지하며 만든 커밋 = 새 head

const judge = (over: Partial<Parameters<typeof absorbsReviewedMerge>[0]> = {}): boolean =>
  absorbsReviewedMerge({
    head: MERGE,
    parents: [MINE, THEIRS],
    lastReviewedHead: MINE,
    source: { reviewedHead: THEIRS, mergeCommit: MERGE },
    ...over,
  });

test('세 근거가 모두 서면 흡수한다 (실측 사례)', () => {
  // sleep-management: #1 의 새 head 가 #2 의 merge_commit_sha 와 같았다.
  assert.equal(judge(), true);
});

test('이쪽에 새 작업이 있으면 재리뷰한다 — 리뷰 도중 머지가 들어온 경우', () => {
  assert.equal(judge({ lastReviewedHead: 'dddd4444' }), false);
});

test('들어온 tip 을 수렴시킨 PR 이 없으면 재리뷰한다 — main 머지가 이 경우다', () => {
  assert.equal(judge({ source: null }), false);
  assert.equal(judge({ source: { reviewedHead: 'eeee5555', mergeCommit: MERGE } }), false);
});

test('머지 커밋이 아니면 재리뷰한다 — 머지 뒤에 커밋을 더 얹은 경우', () => {
  assert.equal(judge({ parents: [MINE] }), false); // 보통 커밋
  assert.equal(judge({ parents: [MINE, THEIRS, 'ffff6666'] }), false); // 옥토퍼스
});

test('부모를 모르면 재리뷰한다 — 조회 실패는 근거가 아니다', () => {
  assert.equal(judge({ parents: null }), false);
});

test('검토한 적 없는 PR 이면 재리뷰한다 — 비교 기준이 없다', () => {
  assert.equal(judge({ lastReviewedHead: null }), false);
});

test('부모 순서를 뒤집어 맞추지 않는다 — 어느 쪽이 이쪽인지가 뜻이다', () => {
  assert.equal(judge({ parents: [THEIRS, MINE] }), false);
});

// ── P1: 부모가 검토됐다는 것만으로는 머지 **결과**를 보증하지 못한다 ──

test('손으로 해결한 머지는 흡수하지 않는다 — 부모가 둘 다 검토됐어도', () => {
  // 충돌을 손으로 해결하거나 `git merge --no-commit` 뒤 손대면, 부모가
  // [검토한 P, 검토한 Q] 여도 머지 커밋 자체에 아무도 본 적 없는 코드가 들어간다.
  // 그때 GitHub 이 만든 커밋과 지금 head 가 달라지므로 여기서 걸린다.
  assert.equal(judge({ head: '9999zzzz' }), false);
  assert.equal(judge({ source: { reviewedHead: THEIRS, mergeCommit: '9999zzzz' } }), false);
});

test('아직 머지되지 않은 PR 은 근거가 아니다 — 열린 PR 의 테스트 머지 커밋 방지', () => {
  // GitHub 은 열린 PR 에도 merge_commit_sha 를 채워둔다(테스트 머지). 조회 쪽에서
  // merged=false 를 null 로 떨어뜨리고, 여기서 null 을 거절한다.
  assert.equal(judge({ source: { reviewedHead: THEIRS, mergeCommit: null } }), false);
});

// ── P1: CLOSED 는 수렴을 뜻하지 않는다 ──

const ctx = (state: PRContext['state'], history: [string, string][] = []): PRContext =>
  ({
    state,
    history: history.map(([from, to]) => ({ at: '2026-08-29T00:00:00.000Z', event: 'PR_CLOSED', from, to })),
  }) as unknown as PRContext;

test('endedConverged: CONVERGED 는 근거가 된다', () => {
  assert.equal(endedConverged(ctx('CONVERGED')), true);
});

test('endedConverged: 수렴하고 닫힌 것은 근거가 된다', () => {
  assert.equal(endedConverged(ctx('CLOSED', [['CONVERGED', 'CLOSED']])), true);
});

test('endedConverged: 지적을 남긴 채 닫힌 것은 근거가 아니다', () => {
  // request_changes 를 받아 AWAITING_AUTHOR 인 PR 을 그대로 머지·종료하면 CLOSED
  // 가 되지만, 그 head 에는 미해결 지적이 남아 있다. 근거로 쓰면 상위 PR 이 알려진
  // 결함을 재검토 없이 통과시킨다.
  assert.equal(endedConverged(ctx('CLOSED', [['AWAITING_AUTHOR', 'CLOSED']])), false);
  assert.equal(endedConverged(ctx('CLOSED', [['ERROR', 'CLOSED']])), false);
});

test('endedConverged: 아직 진행 중인 것은 근거가 아니다', () => {
  for (const s of ['REVIEW_DUE', 'REVIEWING', 'AWAITING_AUTHOR', 'ERROR', 'QUOTA_BLOCKED'] as const) {
    assert.equal(endedConverged(ctx(s)), false, s);
  }
});

test('endedConverged: 이력 없이 CLOSED 인 구버전 컨텍스트는 근거가 아니다', () => {
  assert.equal(endedConverged(ctx('CLOSED')), false);
});
