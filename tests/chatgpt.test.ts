import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGPTResponse } from '../src/parser.js';
import { loadConfig } from '../src/config.js';
import {
  ChatGPTDriver,
  findRoundBaseline,
  judgePromptSent,
  judgeRevival,
  judgeStuckButton,
  isOwnDraft,
  judgeServerAnswer,
  type MessageRef,
} from '../src/chatgpt.js';

const u = (id: string): MessageRef => ({ role: 'user', id });
const a = (id: string): MessageRef => ({ role: 'assistant', id });

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
// 전송 전 가드(waitUntilIdle)가 이 조건을 쓴다.

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
  const statuses = ['IS_STREAMING', 'COMPLETE'];
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
  driver.page = page;
  let answer: string | undefined;
  const collecting = driver.collectFrom(25 * 60_000, { askedBefore: 'prev' }).then((a: string) => { answer = a; });
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

// 서버 기록 우선 (2026-10-15 실측 모양: 질문 create_time · 도구 호출·결과·추론 노드 · 최종 답 end_turn)
const sentAt = Date.parse('2026-10-14T22:20:58Z');
const record = (askedAt: number, final: Record<string, unknown> = {}, q = 'q') => ({
  current_node: 'a',
  mapping: {
    root: { parent: null, message: null },
    [q]: { parent: 'root', message: { author: { role: 'user' }, recipient: 'all', status: 'finished_successfully', create_time: askedAt / 1000,
      content: { content_type: 'text', parts: ['당신은 코드 리뷰어입니다.\\n\\n\## 대상 PR'] } } },
    call: { parent: q, message: { author: { role: 'assistant' }, recipient: 'api_tool.call_tool', status: 'finished_successfully', end_turn: false,
      content: { content_type: 'code', parts: [] } } },
    out: { parent: 'call', message: { author: { role: 'tool' }, recipient: 'all', content: { content_type: 'multimodal_text', parts: ['Page: turn21'] } } },
    think: { parent: 'out', message: { author: { role: 'assistant' }, recipient: 'all', end_turn: false, content: { content_type: 'thoughts', parts: [] } } },
    a: { parent: 'think', message: { author: { role: 'assistant' }, recipient: 'all', status: 'finished_successfully', end_turn: true,
      content: { content_type: 'text', parts: ['```json\n{"summary":"ok"}\n```'] }, ...final } },
  },
});

test('judgeServerAnswer: 보내기 전 마지막 질문 뒤의 끝난 답만 답으로 인정한다', () => {
  const ok = { kind: 'answer', text: '```json\n{"summary":"ok"}\n```' };
  // 이어 쓰는 대화 — 기록의 마지막 질문(q)이 보내기 전의 그것(prev)이 아니다
  assert.deepEqual(judgeServerAnswer(record(sentAt + 2_000), 'COMPLETE', { askedBefore: 'prev' }), ok);
  // 새 대화 — 보내기 전에는 질문이 없었다
  assert.deepEqual(judgeServerAnswer(record(sentAt), 'COMPLETE', { askedBefore: null }), ok);
  // 생성 중이면 기록을 보지 않고 기다린다
  assert.deepEqual(judgeServerAnswer(null, 'IS_STREAMING', { askedBefore: 'prev' }), { kind: 'pending' });
  // 구버전 기록(기준 id 없음)의 회수 — 전송 시각으로 가른다 (서버 시계가 조금 늦어도 같은 질문)
  assert.deepEqual(judgeServerAnswer(record(sentAt - 30_000), 'COMPLETE', { sentAt }), ok);
  assert.equal(judgeServerAnswer(record(sentAt - 5 * 60_000), 'COMPLETE', { sentAt }).kind, 'unknown');
  assert.equal(judgeServerAnswer(record(sentAt), 'COMPLETE', {}).kind, 'unknown');
});

// #68 리뷰: 앞 라운드가 빨리 끝나 직전 질문이 30초 전에 나갔고, 전송 직후의 상태 API·기록은 아직 직전 턴의
// COMPLETE·끝난 답이다. 시각 여유(60초)나 "생성 중을 봤다" 로 가르면 직전 답을 이번 답으로 게시한다.
test('judgeServerAnswer: 1분 안에 나간 직전 질문의 끝난 답을 이번 답으로 받지 않는다', () => {
  const previous = record(sentAt - 30_000, {}, 'prev');
  assert.equal(judgeServerAnswer(previous, 'COMPLETE', { askedBefore: 'prev', sentAt }).kind, 'unknown');
});

test('judgeServerAnswer: 중간 답·덜 끝난 답·조회 실패는 답으로 보지 않는다', () => {
  const seen = { askedBefore: 'prev' };
  // 도구 호출 앞의 중간 답·덜 끝난 답
  assert.equal(judgeServerAnswer(record(sentAt, { end_turn: false }), 'COMPLETE', seen).kind, 'unknown');
  assert.equal(judgeServerAnswer(record(sentAt, { status: 'in_progress' }), 'COMPLETE', seen).kind, 'unknown');
  assert.equal(judgeServerAnswer(record(sentAt, { end_turn: undefined, status: undefined }), 'COMPLETE', seen).kind, 'unknown');
  // 조회 실패
  assert.equal(judgeServerAnswer(null, null, seen).kind, 'unknown');
});

test('serverLastQuestion: 이어 쓰는 대화의 기록을 못 읽으면 보내지 않는다 — 새 대화는 기준이 null', async () => {
  const driver = new ChatGPTDriver(loadConfig('tests/__missing__.json')) as any;
  const tab = (url: string, conv: unknown) => ({ url: () => url, evaluate: async () => conv });
  const chat = 'https://chatgpt.com/g/g-p-1234/c/6acd33bf-39f0-83e8-add2-09d48b0af407';
  assert.equal(await driver.serverLastQuestion(tab('https://chatgpt.com/g/g-p-1234/project', null)), null);
  assert.equal(await driver.serverLastQuestion(tab(chat, record(sentAt))), 'q');
  await assert.rejects(driver.serverLastQuestion(tab(chat, null)), /보내지 않습니다/);
});
