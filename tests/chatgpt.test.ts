import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGPTResponse } from '../src/parser.js';
import { loadConfig } from '../src/config.js';
import {
  anchorAnswer,
  ChatGPTDriver,
  findRoundBaseline,
  judgePromptSent,
  judgeRebind,
  judgeRevival,
  judgeStuckButton,
  isOwnDraft,
  isUnloadedAnswer,
  judgeServerAnswer,
  pickServerAnswer,
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

// ── 전송 확인 ──────────────────────────────────────────────

test('judgePromptSent: 직전 질문 뒤의 새 질문 · 떼어진 직전 질문 · 아직 모름', () => {
  assert.equal(judgePromptSent([u('u1'), u('u2')], 'u1', 1), 'sent');
  assert.equal(judgePromptSent([u('u1')], 'u1', 1), 'pending');
  // 실측(osk-system#162·#165): 새 질문을 띄우며 직전 질문을 떼어내 질문 수가 그대로다
  assert.equal(judgePromptSent([u('u2')], 'u1', 1), 'detached');
  assert.equal(judgePromptSent([], 'u1', 1), 'pending');
  assert.equal(judgePromptSent([{ role: 'user', id: null }], null, 0), 'sent');
});

test('verifyPromptSent: 질문 노드로 못 가르면 입력창이 비었는지로 확정한다', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const page = { waitForTimeout: async (ms: number) => t.mock.timers.tick(ms) };
  let users: MessageRef[] = [];
  let composer = '';
  let streaming = false;
  const d = new ChatGPTDriver(loadConfig('tests/__missing__.json')) as any;
  d.userMessages = async () => users;
  d.isStreaming = async () => streaming;
  const sent = () => d.verifyPromptSent(page, { evaluate: async () => composer }, 'u1', 1);

  users = [u('u2')];
  assert.equal(await sent(), true, '직전 질문이 떼어지고 입력창이 비었으면 보낸 것이다');
  composer = 'review round 2';
  assert.equal(await sent(), false, '입력창에 글이 남았으면 떼어진 화면만으로는 보낸 것이 아니다');
  users = [u('u1')];
  composer = '';
  streaming = true;
  assert.equal(await sent(), true, '질문이 아직 안 그려져도 생성이 시작되고 입력창이 비었으면 보낸 것이다');
  streaming = false;
  assert.equal(await sent(), false);
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

test('재개 문구 대신 최신 답의 리뷰 형식과 대상으로 회수 여부를 판단한다', () => {
  const question = { role: 'user', text: '리뷰 라운드: 1차' };
  const head = 'a'.repeat(40), base = 'b'.repeat(40);
  const review = { summary: '완성된 리뷰', approval: 'approve', comments: [], reviewedHeadSha: head, reviewedBaseSha: base };
  const answer = { role: 'assistant', text: JSON.stringify(review) };
  const accept = (raw: string) => {
    const result = parseGPTResponse(raw);
    return result.parsed === true && result.reviewedHeadSha === head && result.reviewedBaseSha === base;
  };
  assert.equal(findRoundBaseline([question], question.text, true), null, '끝난 빈 생성은 다시 기다리지 않는다');
  assert.equal(findRoundBaseline([question, answer], question.text, true), 0, '늦게 도착한 답은 회수한다');
  for (const text of ['continue', '계속해줘', '이어서 진행해', '중단된 리뷰를 원래 형식으로 마무리해줘']) {
    const continued = [question, { role: 'assistant', text: '' }, { role: 'user', text }];
    assert.equal(findRoundBaseline([...continued, answer], question.text, true, accept), 1);
    assert.equal(findRoundBaseline(continued, question.text, true, accept), null, '생성이 끝난 빈 답은 기다리지 않는다');
    assert.equal(findRoundBaseline(continued, question.text, false, () => true), 1, '생성 중 판정은 완료까지 수집하게 한다');
    assert.equal(findRoundBaseline([...continued, answer, { role: 'user', text: '다른 질문' }, { role: 'assistant', text: '다른 답' }], question.text, true, accept), null, '이전의 유효한 답으로 물러서지 않는다');
  }
  const followup = [question, answer, { role: 'user', text: '계속해줘' }];
  for (const text of ['리뷰가 아닌 답', '{"summary":', JSON.stringify({ ...review, reviewedHeadSha: 'c'.repeat(40) }), JSON.stringify({ ...review, reviewedBaseSha: 'c'.repeat(40) })]) {
    assert.equal(findRoundBaseline([...followup, { role: 'assistant', text }], question.text, true, accept), null);
  }
  assert.equal(findRoundBaseline([{ role: 'user', text: 'continue' }, answer], question.text, false, accept), null, '원래 질문이 없으면 추측하지 않는다');
  assert.equal(findRoundBaseline([...followup, answer], question.text), null, '검증 없이 후속 답을 인정하지 않는다');
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

// 탭이 멎어도 서버가 마친 답은 받는다 — lolchess_base#137: 수집 루프가 51분 멎은 채 서버가 마친 답을 버렸다.
test('collectResponse: 탭이 멎으면 서버 기록의 답을 받고, 그 탭은 다음 라운드 전에 갈아 끼운다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.method(console, 'log', () => {});
  const driver = new ChatGPTDriver(loadConfig('tests/__missing__.json')) as any;
  driver.preparePage = async () => {};
  // 이번 생성을 IS_STREAMING 으로 본 뒤의 COMPLETE 만 믿는다 — 첫 COMPLETE 를 직전 턴의 것으로 두지 않게.
  const statuses = ['COMPLETE', 'IS_STREAMING', 'COMPLETE'];
  const conv = { current_node: 'a', mapping: {
    u: { message: { author: { role: 'user' } } },
    a: { parent: 'u', message: { author: { role: 'assistant' }, status: 'finished_successfully', end_turn: true,
      content: { content_type: 'text', parts: ['{"summary":"ok"}'] } } },
  } };
  const hung = new Promise<never>(() => {});
  let probes = 0;
  const page = {
    url: () => 'https://chatgpt.com/g/g-p-6aa1d12d5db88191870747513394cb0e-jadong-pr-ribyu/c/6acd33bf-39f0-83e8-add2-09d48b0af407',
    waitForTimeout: () => hung, // 탭에 대한 호출이 돌아오지 않는다
    evaluate: () => hung,
    context: () => ({
      newPage: async () => {
        probes++;
        return {
          goto: async () => {},
          close: async () => {},
          evaluate: async (_fn: unknown, { path }: { path: string }) =>
            path.endsWith('/stream_status') ? { status: statuses.shift() ?? 'COMPLETE' } : conv,
        };
      },
    }),
  };
  let answer: string | undefined;
  const collecting = driver.collectResponse(page, 0, null).then((a: string) => { answer = a; });
  for (let i = 0; i < 200 && answer === undefined; i++) {
    await new Promise(setImmediate);
    t.mock.timers.tick(5_000);
  }
  await collecting;
  assert.equal(answer, '{"summary":"ok"}');
  assert.ok(probes >= 3, `${probes}`);
  assert.equal(driver.pageRetired, true);
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
  // 2026-10 화면의 실측 문구 — 두 문장 중 어느 쪽만 보여도 잡는다.
  assert.equal(matchInterrupt('연결이 해제되었습니다. 전체 답변을 기다리는 중입니다.'), '연결이 해제되었습니다');
  assert.equal(matchInterrupt('… 전체 답변을 기다리는 중입니다.'), '전체 답변을 기다리는 중');
});

test('matchInterrupt: 리뷰 본문에 나올 법한 평범한 문장은 잡지 않는다', () => {
  // 실패한 PR 이 정확히 이 주제였다 — "완전한 응답을 기다리지 않는다" 가 변경의 요지였고,
  // 그걸 한국어로 리뷰하면 아래 같은 문장이 나온다.
  for (const prose of [
    'API 완전한 응답을 기다려야 하므로 지연이 생깁니다.',
    '소켓 연결이 끊기면 재연결을 시도하세요.',
    '연결이 중단될 때의 복구 경로가 없습니다.',
    '완전한 답변을 기다리는 대신 스트리밍으로 바꾸는 편이 낫습니다.',
    '세션 연결이 해제되면 재시도하세요.',
    '전체 답변을 기다리지 않고 부분 응답을 그대로 씁니다.',
    'The client keeps waiting for the complete response before rendering.',
  ]) {
    assert.equal(matchInterrupt(prose), null, prose);
  }
});

test('matchInterrupt: 걸린 문구를 그대로 돌려준다 (오탐 진단의 유일한 근거)', () => {
  const hit = matchInterrupt('앞부분 blah Connection Interrupted 뒷부분');
  assert.equal(hit, 'Connection Interrupted'); // 원문 대소문자 그대로
});

test('isOwnDraft: 우리가 넣다 만 리뷰 프롬프트만 지울 대상으로 본다', () => {
  const template = loadConfig('tests/__missing__.json').promptTemplate;
  const head = template.split('{{')[0];
  const file = 'review-diff-0123456789ab-ba9876543210-deadbeef.txt';
  // 템플릿 머리말로 시작하는 잔해와 우리 첨부 — 지운다
  assert.equal(isOwnDraft(`${head}https://github.com/o/r/pull/1`, [file], template), true);
  // 보내려던 프롬프트의 앞부분 — 지운다
  assert.equal(isOwnDraft('PR 리뷰 요청 앞', [], '{{instructions}}', 'PR 리뷰 요청 앞부분 그리고 뒤'), true);
  // 글 없이 우리 첨부만 — 지운다
  assert.equal(isOwnDraft('', [file], template), true);
  // 사람의 글·남의 첨부·머리말이 짧은 템플릿 — 남긴다
  assert.equal(isOwnDraft('keep my draft', [], template), false);
  assert.equal(isOwnDraft(head, ['notes.txt'], template), false);
  assert.equal(isOwnDraft('짧은 머리말 뒤 사람 글', [], '짧은 {{url}}'), false);
});

test('isUnloadedAnswer: 답 자리의 화면 오류 문구만 알아본다', () => {
  assert.equal(isUnloadedAnswer('This response couldn’t load'), true);
  assert.equal(isUnloadedAnswer(" This response couldn't load. \n"), true);
  assert.equal(isUnloadedAnswer('{"summary":"This response couldn’t load"}'), false);
});

test('pickServerAnswer: 현재 가지에서 마지막 질문 뒤의 최종 답만 고른다', () => {
  const msg = (role: string, text: string, extra: Record<string, unknown> = {}) =>
    ({ author: { role }, recipient: 'all', content: { content_type: 'text', parts: [text] }, ...extra });
  const conv = {
    current_node: 'a2',
    mapping: {
      u1: { parent: null, message: msg('user', '1차 질문') },
      a1: { parent: 'u1', message: msg('assistant', '1차 답') },
      u2: { parent: 'a1', message: msg('user', '2차 질문') },
      t2: { parent: 'u2', message: { author: { role: 'assistant' }, content: { content_type: 'thoughts', parts: [] } } },
      c2: { parent: 't2', message: msg('assistant', 'python(...)', { recipient: 'python' }) },
      a2: { parent: 'c2', message: msg('assistant', '{"summary":"ok"}') },
      old: { parent: 'u2', message: msg('assistant', '다시 생성되기 전 옛 답') },
    },
  };
  assert.equal(pickServerAnswer(conv), '{"summary":"ok"}');
  // 마지막 질문 뒤에 답이 아직 없으면 직전 라운드의 답으로 물러서지 않는다
  assert.equal(pickServerAnswer({ ...conv, current_node: 't2' }), null);
  assert.equal(pickServerAnswer({}), null);
});

// 서버 기록 우선 (2026-10-15 실측 모양: 질문 create_time · 도구 호출·결과·추론 노드 · 최종 답 end_turn)
const sentAt = Date.parse('2026-10-14T22:20:58Z');
const record = (askedAt: number, final: Record<string, unknown> = {}) => ({
  current_node: 'a',
  mapping: {
    root: { parent: null, message: null },
    q: { parent: 'root', message: { author: { role: 'user' }, recipient: 'all', status: 'finished_successfully', create_time: askedAt / 1000,
      content: { content_type: 'text', parts: ['당신은 코드 리뷰어입니다.\\n\\n\## 대상 PR'] } } },
    call: { parent: 'q', message: { author: { role: 'assistant' }, recipient: 'api_tool.call_tool', status: 'finished_successfully', end_turn: false,
      content: { content_type: 'code', parts: [] } } },
    out: { parent: 'call', message: { author: { role: 'tool' }, recipient: 'all', content: { content_type: 'multimodal_text', parts: ['Page: turn21'] } } },
    think: { parent: 'out', message: { author: { role: 'assistant' }, recipient: 'all', end_turn: false, content: { content_type: 'thoughts', parts: [] } } },
    a: { parent: 'think', message: { author: { role: 'assistant' }, recipient: 'all', status: 'finished_successfully', end_turn: true,
      content: { content_type: 'text', parts: ['```json\n{"summary":"ok"}\n```'] }, ...final } },
  },
});

test('judgeServerAnswer: 이번 질문의 끝난 답만 답으로 인정한다', () => {
  const seen = { sentAt, sawStreaming: false };
  assert.deepEqual(judgeServerAnswer(record(sentAt + 2_000), 'COMPLETE', seen), { kind: 'answer', text: '```json\n{"summary":"ok"}\n```' });
  // 서버 시계가 조금 늦어 질문 시각이 전송보다 앞서도 같은 질문이다
  assert.equal(judgeServerAnswer(record(sentAt - 30_000), 'COMPLETE', seen).kind, 'answer');
  // 생성 중이면 기록을 보지 않고 기다린다 — 화면이 끝났다고 해도
  assert.deepEqual(judgeServerAnswer(null, 'IS_STREAMING', seen), { kind: 'pending' });
});

test('judgeServerAnswer: 직전 턴의 기록·중간 답·모르는 모양은 판정하지 않는다 (화면 답으로 돌아간다)', () => {
  const seen = { sentAt, sawStreaming: false };
  // 이어 쓰는 대화에서 이번 질문이 기록에 오르기 전 — 마지막 질문은 직전 라운드의 것이다
  assert.equal(judgeServerAnswer(record(sentAt - 5 * 60_000), 'COMPLETE', seen).kind, 'unknown');
  // 이번 생성을 서버가 생성 중이라고 한 적이 있으면 마지막 턴이 이번 것이다 (전송 시각을 모르는 회수 경로)
  assert.equal(judgeServerAnswer(record(sentAt - 5 * 60_000), 'COMPLETE', { sentAt: null, sawStreaming: true }).kind, 'answer');
  assert.equal(judgeServerAnswer(record(sentAt), 'COMPLETE', { sentAt: null, sawStreaming: false }).kind, 'unknown');
  // 도구 호출 앞의 중간 답·덜 끝난 답
  assert.equal(judgeServerAnswer(record(sentAt, { end_turn: false }), 'COMPLETE', seen).kind, 'unknown');
  assert.equal(judgeServerAnswer(record(sentAt, { status: 'in_progress' }), 'COMPLETE', seen).kind, 'unknown');
  assert.equal(judgeServerAnswer(record(sentAt, { end_turn: undefined, status: undefined }), 'COMPLETE', seen).kind, 'unknown');
  // 기록의 답도 화면 오류 문구 · 조회 실패
  assert.equal(judgeServerAnswer(record(sentAt, { content: { content_type: 'text', parts: ['This response couldn’t load'] } }), 'COMPLETE', seen).kind, 'unknown');
  assert.equal(judgeServerAnswer(null, null, seen).kind, 'unknown');
});

// 9차가 7차의 답을 게시했던 모양 — 화면은 남의 노드를 끝난 답으로 읽었다.
test('collectResponse: 화면이 끝났다고 해도 서버가 생성 중이면 받지 않고, 끝나면 서버 기록의 이번 답을 쓴다', async (t) => {
  let now = sentAt;
  t.mock.method(Date, 'now', () => now);
  const logs: string[] = [];
  t.mock.method(console, 'log', (line: string) => logs.push(line));
  const driver = new ChatGPTDriver({ ...loadConfig('tests/__missing__.json'), responseTimeoutMs: 25 * 60_000 }) as any;
  driver.isStreaming = async () => false;
  driver.interruptedBanner = async () => null;
  driver.detectQuotaLimit = async () => null;
  const page = {
    url: () => 'https://chatgpt.com/g/g-p-6aa1d12d5db88191870747513394cb0e-jadong-pr-ribyu/c/6acd33bf-39f0-83e8-add2-09d48b0af407',
    waitForTimeout: async (ms: number) => { now += ms; },
    evaluate: async (_fn: unknown, arg: { path?: string } | null) => !arg?.path
      ? [u('prev'), a('old'), u('q'), a('a')]
      : arg.path.endsWith('/stream_status') ? { status: now - sentAt < 90_000 ? 'IS_STREAMING' : 'COMPLETE' } : record(sentAt + 1_000),
    locator: () => ({ locator: () => ({ count: async () => 1, allInnerTexts: async () => ['화면이 읽은 남의 답'] }) }),
  };
  assert.equal(await driver.collectResponse(page, 1, 'prev', 25 * 60_000, sentAt), '```json\n{"summary":"ok"}\n```');
  assert.ok(now - sentAt >= 90_000, `${now - sentAt}ms`);
  assert.equal(logs.filter(line => line.includes('서버는 아직 생성 중')).length, 1);
});
