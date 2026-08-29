import test from 'node:test';
import assert from 'node:assert/strict';
import { absorbsReviewedMerge } from '../src/reviewer.js';

/**
 * 스택 PR 의 베이스 머지는 새 코드가 아니다.
 *
 * 이 판정이 지켜야 할 것은 **미검토 코드를 검토 완료로 기록하지 않는 것**이다.
 * 그래서 부모 둘을 다 못 박고, 조금이라도 어긋나면 흡수하지 않는다 —
 * 틀리는 방향이 언제나 "한 번 더 리뷰한다" 쪽이어야 한다.
 */

const MINE = 'aaaa1111'; // 머지 전 이쪽 브랜치 tip = 우리가 검토한 head
const THEIRS = 'bbbb2222'; // 들어온 브랜치 tip = 다른 PR 에서 검토·수렴한 head

const judge = (over: Partial<Parameters<typeof absorbsReviewedMerge>[0]> = {}): boolean =>
  absorbsReviewedMerge({
    parents: [MINE, THEIRS],
    lastReviewedHead: MINE,
    reviewedHeads: new Set([THEIRS]),
    ...over,
  });

test('양쪽 부모가 모두 검토한 것이면 흡수한다 (실측 사례)', () => {
  // sleep-management#1 이 겪은 그 모양: parents = [#1 이 검토한 head,
  // #2 가 approve 로 수렴한 head].
  assert.equal(judge(), true);
});

test('들어온 쪽을 검토한 적이 없으면 재리뷰한다 — main 머지가 이 경우다', () => {
  assert.equal(judge({ reviewedHeads: new Set(['cccc3333']) }), false);
  assert.equal(judge({ reviewedHeads: new Set() }), false);
});

test('이쪽에 새 작업이 있으면 재리뷰한다 — 리뷰 도중 머지가 들어온 경우', () => {
  // parents[0] 이 우리가 검토한 head 가 아니다 = 그 사이 이쪽에도 커밋이 있었다.
  assert.equal(judge({ lastReviewedHead: 'dddd4444' }), false);
});

test('머지 커밋이 아니면 재리뷰한다 — 머지 뒤에 커밋을 더 얹은 경우', () => {
  assert.equal(judge({ parents: [MINE] }), false); // 보통 커밋
  assert.equal(judge({ parents: [MINE, THEIRS, 'eeee5555'] }), false); // 옥토퍼스
});

test('부모를 모르면 재리뷰한다 — 조회 실패는 근거가 아니다', () => {
  assert.equal(judge({ parents: null }), false);
});

test('검토한 적 없는 PR 이면 재리뷰한다 — 비교 기준이 없다', () => {
  assert.equal(judge({ lastReviewedHead: null }), false);
});

test('부모 순서를 뒤집어 맞추지 않는다 — 어느 쪽이 이쪽인지가 뜻이다', () => {
  // parents[0] 은 언제나 머지를 받은 쪽(이 PR 의 브랜치)이다. 순서를 무시하고
  // 집합으로 비교하면, 리뷰 도중 들어온 머지까지 통과시켜 미검토 코드를 놓친다.
  assert.equal(judge({ parents: [THEIRS, MINE] }), false);
});
