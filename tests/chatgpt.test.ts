import test from 'node:test';
import assert from 'node:assert/strict';
import { anchorAnswer, findRoundBaseline, type MessageRef } from '../src/chatgpt.js';

const u = (id: string): MessageRef => ({ role: 'user', id });
const a = (id: string): MessageRef => ({ role: 'assistant', id });

test('anchorAnswer: 마지막 질문 뒤의 첫 응답을 가리킨다', () => {
  const got = anchorAnswer([u('u1'), a('a1'), u('u2'), a('a2')]);
  assert.deepEqual(got, { status: 'ready', id: 'a2', nth: 1 });
});

test('anchorAnswer: 답 노드가 아직 없으면 pending — 직전 응답으로 물러서지 않는다', () => {
  const got = anchorAnswer([u('u1'), a('a1'), u('u2')]);
  assert.deepEqual(got, { status: 'pending', nth: 1 });
});

test('anchorAnswer: 사용자 메시지가 없으면 unknown', () => {
  assert.deepEqual(anchorAnswer([a('a1')]), { status: 'unknown' });
  assert.deepEqual(anchorAnswer([]), { status: 'unknown' });
});

test('anchorAnswer: 화면 밖 메시지가 떨어져 나가도 현재 화면 기준 위치를 준다', () => {
  // 전송 시점에는 어시스턴트가 3건이었지만(nth=3), 위쪽 두 턴이 떨어져 나간 화면.
  // 여기서 전송 시점 값(3)을 그대로 쓰면 아무 노드도 가리키지 못해 "0자" 로 굳는다.
  const got = anchorAnswer([a('a3'), u('u4'), a('a4')]);
  assert.deepEqual(got, { status: 'ready', id: 'a4', nth: 1 });
});

test('anchorAnswer: id 가 없어도 위치는 준다', () => {
  const got = anchorAnswer([u('u1'), { role: 'assistant', id: null }]);
  assert.deepEqual(got, { status: 'ready', id: null, nth: 0 });
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
