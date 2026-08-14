import test from 'node:test';
import assert from 'node:assert/strict';
import { anchorAnswer, findRoundBaseline, judgeRebind, type MessageRef } from '../src/chatgpt.js';

const u = (id: string): MessageRef => ({ role: 'user', id });
const a = (id: string): MessageRef => ({ role: 'assistant', id });

test('anchorAnswer: 마지막 질문 뒤의 첫 응답을 가리킨다', () => {
  const got = anchorAnswer([u('u1'), a('a1'), u('u2'), a('a2')]);
  assert.deepEqual(got, { status: 'ready', id: 'a2', userId: 'u2', nth: 1 });
});

test('anchorAnswer: 답 노드가 아직 없으면 pending — 직전 응답으로 물러서지 않는다', () => {
  const got = anchorAnswer([u('u1'), a('a1'), u('u2')]);
  assert.deepEqual(got, { status: 'pending', userId: 'u2', nth: 1 });
});

test('anchorAnswer: 우리 질문이 아직 안 그려졌으면 직전 턴에 고정하지 않는다', () => {
  // 전송 직후의 화면 — 마지막 질문이 아직 전송 전의 그것이다.
  const screen = [u('u1'), a('a1'), u('u2'), a('a2')];
  assert.equal(anchorAnswer(screen, 'u2').status, 'pending');
  // 우리 질문이 그려지면 그때 고정한다.
  assert.deepEqual(anchorAnswer([...screen, u('u3'), a('a3')], 'u2'), {
    status: 'ready',
    id: 'a3',
    userId: 'u3',
    nth: 2,
  });
});

test('anchorAnswer: 사용자 메시지가 없으면 unknown', () => {
  assert.deepEqual(anchorAnswer([a('a1')]), { status: 'unknown' });
  assert.deepEqual(anchorAnswer([]), { status: 'unknown' });
});

test('anchorAnswer: 화면 밖 메시지가 떨어져 나가도 현재 화면 기준 위치를 준다', () => {
  // 전송 시점에는 어시스턴트가 3건이었지만(nth=3), 위쪽 두 턴이 떨어져 나간 화면.
  // 여기서 전송 시점 값(3)을 그대로 쓰면 아무 노드도 가리키지 못해 "0자" 로 굳는다.
  const got = anchorAnswer([a('a3'), u('u4'), a('a4')]);
  assert.deepEqual(got, { status: 'ready', id: 'a4', userId: 'u4', nth: 1 });
});

test('anchorAnswer: id 가 없어도 위치는 준다', () => {
  const got = anchorAnswer([u('u1'), { role: 'assistant', id: null }]);
  assert.deepEqual(got, { status: 'ready', id: null, userId: 'u1', nth: 0 });
});

// ── 노드 교체 판정 ─────────────────────────────────────────

const bound = { id: 'a2', userId: 'u2', nth: 1 };

test('judgeRebind: 노드가 그대로면 그대로 읽는다', () => {
  assert.deepEqual(judgeRebind([u('u1'), a('a1'), u('u2'), a('a2')], bound), { action: 'keep' });
});

test('judgeRebind: 같은 질문의 답이면 새 식별자로 다시 고정한다', () => {
  // ChatGPT 가 임시 식별자(a2)로 그린 답 노드를 서버 식별자(srv-9)로 갈아 끼운 화면.
  const got = judgeRebind([u('u1'), a('a1'), u('u2'), a('srv-9')], bound);
  assert.deepEqual(got, { action: 'rebind', id: 'srv-9' });
});

test('judgeRebind: 앵커가 직전 턴으로 물러섰으면 따라가지 않는다', () => {
  // 우리 질문(u2)이 화면 밖으로 밀려난 화면 — 여기서 a1 로 갈아타면 직전 라운드의
  // 답을 이번 응답으로 게시하게 된다.
  const got = judgeRebind([u('u1'), a('a1')], bound);
  assert.deepEqual(got, { action: 'hold', reason: 'turn-moved' });
});

test('judgeRebind: 판별할 화면이 없으면 유예한다', () => {
  assert.deepEqual(judgeRebind([], bound), { action: 'hold', reason: 'anchor-unknown' });
});

test('judgeRebind: 같은 질문의 답이 아직 없으면 기다린다 (18차 실패 경로)', () => {
  // 추론 중 답 노드가 지워진 화면. 우리 질문(u2)이 여전히 마지막이므로 대기다 —
  // 여기서 실패로 접으면, 같은 화면을 두고 고정 전에는 기다리고 고정 후에는
  // 버리는 모순이 된다.
  assert.deepEqual(judgeRebind([u('u1'), a('a1'), u('u2')], bound), { action: 'wait' });
  // 식별자가 아직 안 붙은 답 노드도 같다 — 붙으면 그때 다시 고정한다.
  assert.deepEqual(judgeRebind([u('u1'), a('a1'), u('u2'), { role: 'assistant', id: null }], bound), {
    action: 'wait',
  });
});

test('judgeRebind: 다른 질문이 마지막이면 그 답을 기다리지 않는다', () => {
  // 우리 질문 뒤에 다른 질문이 들어온 화면 — 그 답은 우리 것이 아니다.
  assert.deepEqual(judgeRebind([u('u1'), a('a1'), u('u2'), u('u3')], bound), {
    action: 'hold',
    reason: 'turn-moved',
  });
});

test('judgeRebind: 질문에 식별자가 없으면 위치로 대조한다', () => {
  const noId = { id: 'a2', userId: null, nth: 1 };
  assert.deepEqual(
    judgeRebind([{ role: 'user', id: null }, a('a1'), { role: 'user', id: null }, a('srv-9')], noId),
    { action: 'rebind', id: 'srv-9' },
  );
  // 뒤로 물러선 앵커는 언제나 더 작은 nth 를 낸다 — 그래서 위치 대조로도 갈린다.
  assert.deepEqual(judgeRebind([{ role: 'user', id: null }, a('a1')], noId), {
    action: 'hold',
    reason: 'turn-moved',
  });
});

test('anchorAnswer 의 nth 는 findRoundBaseline 과 같은 기준이다', () => {
  const msgs = [
    { role: 'user', id: 'u1', text: '리뷰 라운드: 1차' },
    { role: 'assistant', id: 'a1', text: '…' },
    { role: 'user', id: 'u2', text: '리뷰 라운드: 2차' },
    { role: 'assistant', id: 'a2', text: '…' },
  ];
  const baseline = findRoundBaseline(msgs, '리뷰 라운드: 2차');
  const anchor = anchorAnswer(msgs);
  assert.equal(anchor.status, 'ready');
  assert.equal(baseline, anchor.status === 'ready' ? anchor.nth : -1);
});
