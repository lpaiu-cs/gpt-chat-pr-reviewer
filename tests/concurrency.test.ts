import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewBatchSize } from '../src/queue.js';
import { parseIntent } from '../src/ui/server.js';

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
  assert.equal(reviewBatchSize(-3, 5), 5); // 음수는 0 과 같이 제한 없음
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
