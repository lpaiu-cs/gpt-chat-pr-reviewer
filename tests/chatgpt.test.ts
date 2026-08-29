import test from 'node:test';
import assert from 'node:assert/strict';
import {
  anchorAnswer,
  findRoundBaseline,
  judgeRebind,
  judgeRevival,
  judgeStuckButton,
  matchInterrupt,
  type MessageRef,
} from '../src/chatgpt.js';

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

// 중지 버튼 고장 판정 (#109)
//
// 관측: 응답은 392초에 1,014자로 완성됐는데 stop-button 이 visible·enabled 로
// DOM 에 남아 완료 조건이 성립하지 않았고, 25분 예산을 태운 뒤 완성된 리뷰를
// 버렸다. 아래는 그 경로를 끊되, 이슈 #1(조기 절단)을 되살리지 않는다는 계약이다.
// collectResponse 와 waitUntilIdle 이 같은 조건을 쓴다.

/** 관측된 그 순간의 신호 — 생성은 끝났고 네트워크도 오래 조용했다. */
const stuck = {
  sawGeneration: true,
  inFlight: 0,
  quietMs: 10 * 60_000,
  idleMs: 18 * 60_000,
};

test('judgeStuckButton: 생성이 끝나고 네트워크도 조용한 채 오래 멎었으면 고장으로 본다', () => {
  assert.equal(judgeStuckButton(stuck), true);
});

test('judgeStuckButton: 생성 요청이 열려 있으면 진짜 만드는 중이다', () => {
  assert.equal(judgeStuckButton({ ...stuck, inFlight: 1 }), false);
});

test('judgeStuckButton: WebSocket 으로 흐르는 생성은 끊지 않는다', () => {
  // POST 가 닫힌 뒤에도 프레임이 오는 구간이 있다. 프레임이 오면 lastNetAt 이
  // 갱신되므로 quietMs 가 작고, 그때는 부분 응답을 완성본으로 게시하면 안 된다.
  assert.equal(judgeStuckButton({ ...stuck, quietMs: 5_000 }), false);
  assert.equal(judgeStuckButton({ ...stuck, quietMs: 179_999 }), false);
  assert.equal(judgeStuckButton({ ...stuck, quietMs: 180_000 }), true);
});

test('judgeStuckButton: 이번 라운드의 생성을 못 봤으면 근거가 없어 끊지 않는다', () => {
  // sawGeneration 은 전송 직전에 초기화된다 — 지난 라운드의 관측은 근거가 아니다.
  assert.equal(judgeStuckButton({ ...stuck, sawGeneration: false }), false);
});

test('judgeStuckButton: 토큰 간격 정도의 정지로는 끊지 않는다', () => {
  assert.equal(judgeStuckButton({ ...stuck, idleMs: 30_000 }), false);
  assert.equal(judgeStuckButton({ ...stuck, idleMs: 119_999 }), false);
  assert.equal(judgeStuckButton({ ...stuck, idleMs: 120_000 }), true);
});

// 죽은 브라우저 되살리기 (#109 의 별개 증상)
//
// 사람이 Chrome 창을 닫자 page.goto 가 "Target page, context or browser has
// been closed" 로 실패했고, launch() 는 기동 때 한 번뿐이라 그 뒤 모든
// 재시도가 같은 오류로 죽었다. 복구는 하되, 범위를 최소로 잡는다.

test('judgeRevival: 멀짱하면 그대로 쓴다', () => {
  assert.equal(judgeRevival({ ctxAlive: true, pageAlive: true, owned: true }), 'ok');
  assert.equal(judgeRevival({ ctxAlive: true, pageAlive: true, owned: false }), 'ok');
});

test('judgeRevival: 탭만 죽었으면 탭만 다시 연다', () => {
  // 동시 리뷰가 한 컨텍스트를 나눠 쓰므로, 여기서 컨텍스트를 다시
  // 띄우면 형제 라운드가 모두 죽는다.
  assert.equal(judgeRevival({ ctxAlive: true, pageAlive: false, owned: true }), 'reopen-tab');
  assert.equal(judgeRevival({ ctxAlive: true, pageAlive: false, owned: false }), 'reopen-tab');
});

test('judgeRevival: 브라우저까지 죽었고 소유자면 다시 띄운다', () => {
  assert.equal(judgeRevival({ ctxAlive: false, pageAlive: false, owned: true }), 'relaunch');
});

test('judgeRevival: 빌려 쓴 브라우저는 내가 다시 띄우지 않는다', () => {
  // fork 된 드라이버는 탭만 자기 것이다 — 남의 브라우저를 다시 띄울
  // 권한이 없으므로 분명히 실패해야 한다.
  assert.equal(judgeRevival({ ctxAlive: false, pageAlive: false, owned: false }), 'give-up');
});


// ── 연결 중단 배너 ──────────────────────────────────────────
//
// 이 판정은 **라운드를 통째로 버린다**. 게다가 매치한 문자열이 대화 본문에 있으면
// 새로고침해도 남으므로 복구 3회가 전부 즉시 실패하고, 재시도도 같은 자리에서
// 같은 이유로 죽는다 — 되살아날 길이 없는 고착이다. 실제로 그렇게 두 PR 이 24회
// 연속 실패했다. 그래서 오탐 쪽으로 기운 패턴은 여기서 막는다.

test('matchInterrupt: 진짜 배너 문구는 잡는다', () => {
  assert.equal(
    matchInterrupt('Connection interrupted. Reload the page.'),
    'Connection interrupted',
  );
  assert.equal(
    matchInterrupt('...waiting for the complete answer...'),
    'waiting for the complete answer',
  );
  assert.equal(matchInterrupt('연결이 중단되었습니다. 다시 시도하세요.'), '연결이 중단되었습니다');
});

test('matchInterrupt: 리뷰 본문에 나올 법한 평범한 문장은 잡지 않는다', () => {
  // 실패한 PR 이 정확히 이 주제였다 — "완전한 응답을 기다리지 않는다" 가 변경의 요지였고,
  // 그걸 한국어로 리뷰하면 아래 같은 문장이 나온다.
  for (const prose of [
    'API 완전한 응답을 기다려야 하므로 지연이 생깁니다.',
    '소켓 연결이 끊기면 재연결을 시도하세요.',
    '연결이 중단될 때의 복구 경로가 없습니다.',
    '완전한 답변을 기다리는 대신 스트리밍으로 바꾸는 편이 낫습니다.',
    'The client keeps waiting for the complete response before rendering.',
  ]) {
    assert.equal(matchInterrupt(prose), null, prose);
  }
});

test('matchInterrupt: 걸린 문구를 그대로 돌려준다 (오탐 진단의 유일한 근거)', () => {
  const hit = matchInterrupt('앞부분 blah Connection Interrupted 뒷부분');
  assert.equal(hit, 'Connection Interrupted'); // 원문 대소문자 그대로
});
