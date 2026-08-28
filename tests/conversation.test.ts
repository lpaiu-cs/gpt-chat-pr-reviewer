import test from 'node:test';
import assert from 'node:assert/strict';
import { planConversation } from '../src/reviewer.js';
import { loadConfig } from '../src/config.js';
import type { AppConfig, PRContext } from '../src/types.js';

/**
 * 대화 회전 상한 — 몇 차 리뷰까지 **한 대화에서** 이어 가는가.
 *
 * 회전은 공짜가 아니다. 새 대화는 이전 지적을 스니펫으로만 받으므로 같은 곳을
 * 다시 집거나, 이미 고친 맥락을 놓친다. 그래서 이 값은 "성능 튜닝 상수" 가
 * 아니라 리뷰 품질을 정하는 약속이고, 조용히 낮아지면 사용자가 5차부터
 * 대화가 끊기는 것을 겪는다 — 실제로 그 신고를 받고 10 으로 올렸다.
 */

const URL = 'https://chatgpt.com/c/0000-1111';

function ctx(turns: number): PRContext {
  return {
    prUrl: 'https://github.com/o/r/pull/1',
    owner: 'o',
    repo: 'r',
    prNumber: 1,
    title: 't',
    state: 'REVIEW_DUE',
    round: turns,
    requestedCount: 0,
    retryCount: 0,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
    threads: [],
    history: [],
    conversationUrl: URL,
    conversationStartRound: 1,
    conversationTurns: turns,
  } as PRContext;
}

// 설정 파일이 없는 경로를 준다 — 이 저장소의 pr-review.config.json 은
// 사용자별 파일이라 있으면 기본값 대신 그 값이 섞인다.
const cfg = (): AppConfig => loadConfig('tests/__no-such-config__.json');

test('기본 상한은 10 — 10차 리뷰까지는 한 대화에서 이어 간다', () => {
  assert.equal(cfg().maxTurnsPerConversation, 10);
});

test('10회 전송 전까지는 이전 대화를 이어 간다', () => {
  for (let turns = 1; turns < 10; turns++) {
    const plan = planConversation(cfg(), ctx(turns), turns + 1);
    assert.equal(plan.action, 'resume', `${turns}회 전송 뒤에는 이어 가야 한다`);
    assert.equal(plan.action === 'resume' && plan.url, URL);
  }
});

test('10회를 채우면 그때 회전한다 (11차부터 새 대화)', () => {
  const plan = planConversation(cfg(), ctx(10), 11);
  assert.equal(plan.action, 'new');
  assert.equal(plan.action === 'new' && plan.reason, 'rotate');
  assert.equal(plan.turnsUsed, 10);
});

test('설정으로 낮추면 그 값이 상한이다 — 상한은 설정이 정한다', () => {
  const low = { ...cfg(), maxTurnsPerConversation: 3 };
  assert.equal(planConversation(low, ctx(2), 3).action, 'resume');
  assert.equal(planConversation(low, ctx(3), 4).action, 'new');
});

test('구버전 컨텍스트(전송 횟수 없음)는 라운드 차이로 근사한다', () => {
  const old = ctx(0);
  delete old.conversationTurns;
  old.conversationStartRound = 1;
  // 11차 = 시작 라운드로부터 10 — 상한에 정확히 닿는다.
  assert.equal(planConversation(cfg(), old, 11).action, 'new');
  assert.equal(planConversation(cfg(), old, 10).action, 'resume');
});
