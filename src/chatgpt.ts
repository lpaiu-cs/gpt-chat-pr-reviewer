/**
 * ChatGPT 웹 UI Playwright 자동화 드라이버.
 *
 * 영속 프로필(persistent context)로 Chrome 을 띄워
 * 최초 1회 수동 로그인 후 세션을 재사용한다.
 */

import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import chalk from 'chalk';
import { progress } from './progress.js';
import type { AppConfig } from './types.js';
import { chatgptProjectId, validateProjectUrl, requireProjectUrl } from './config.js';
import { enterProject, readProjectEntry } from './project-entry.js';

/** ChatGPT 사용량 한도 도달 — 상태 머신의 QUOTA_EXCEEDED 이벤트로 매핑된다. */
export class QuotaLimitError extends Error {
  constructor(message = 'ChatGPT 사용량 한도 도달') {
    super(message);
    this.name = 'QuotaLimitError';
  }
}

/**
 * 정해진 시간 안에 응답을 받지 못했다 — **내용 실패와 성격이 다르다.**
 *
 * 파싱 실패·리뷰 거부는 같은 답을 다시 써도 결과가 같지만, 타임아웃은 환경 사정이라
 * 다시 시도하면 대개 풀린다. 둘을 같은 "리뷰 실패" 로 표기하면 로그만 보고는
 * 무엇이 잘못됐는지 구분할 수 없고, 실제로 그래서 "오류가 왜 이렇게 잦은가" 를
 * 되묻게 됐다.
 */
export class ResponseTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResponseTimeoutError';
  }
}

/**
 * 생성이 답 없이 끝났다 — 새로고침해도 중지 버튼도 답도 없다 (ChatGPT 에서 중지·연결 끊김).
 *
 * 타임아웃과 따로 둔다. 타임아웃은 "아직 오는 중일 수 있다" 라 같은 대화를 1분마다
 * 무기한 다시 확인하는데(재전송 없음), 끝난 생성에는 그 회수가 영원히 끝나지 않는다.
 * 호출부는 전송 대상을 남겨 다음 재시도에서 늦은 답·사용자가 이어받은 답을 먼저 확인한다.
 * 회수할 답이 없으면 다시 묻는다. 무기한 회수로 예약하지는 않는다.
 */
export class GenerationEndedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GenerationEndedError';
  }
}

export interface PromptAttachment { name: string; buffer: Buffer }

/** 미전송 첨부만 찾는다. 대화에 이미 전송된 파일은 포함하지 않는다. 개편 화면은 "Remove <파일명>" 이다. */
const REMOVE_FILE_BUTTON = /^(Remove |파일 제거|파일 삭제)/;

/**
 * 업로드가 끝난 첨부 카드. 옛 화면은 처리 중 숨겨 둔 아이콘이 드러나고, 개편 화면은
 * "Uploading <파일명>" 진행 막대가 파일명 버튼으로 바뀐다 (실측 530KB 약 8초).
 */
function uploadedCard(composer: Locator, name: string): Locator {
  return composer.getByRole('group', { name, exact: true }).getByTestId('library-file-icon')
    .or(composer.getByRole('button', { name, exact: true })).first();
}

/** 대화에서 읽어온 메시지 하나 (역할 + 본문). */
export interface ConversationMessage {
  role: string;
  text: string;
}

/**
 * 화면의 대화 메시지를 순서대로 읽는다 — **브라우저 안에서 실행된다** (`page.evaluate`
 * 로 넘기므로 바깥 변수를 못 쓴다). `contentSel` 이 null 이면 본문은 읽지 않는다.
 *
 * 2026-09 개편 화면은 `data-message-author-role`·`data-message-id` 를 없앴다. 질문과
 * 답이 `data-chatgpt-search-unit-key`("…:user" / "…:assistant") 단위로 그려지고
 * 식별자는 `data-chatgpt-search-message-ids` 의 첫 값이다. 옛 속성만 보던 판정에는
 * 대화가 통째로 비어 보였다. 옛 화면도 계속 읽는다 — 개편은 계정마다 따로 온다.
 */
export function readMessagesInPage(contentSel: string | null): { role: string; id: string | null; text: string }[] {
  const legacy = [...document.querySelectorAll('[data-message-author-role]')];
  if (legacy.length > 0) {
    return legacy.map((el) => ({
      role: el.getAttribute('data-message-author-role') ?? '',
      id: el.getAttribute('data-message-id'),
      text: contentSel === null ? '' : (el.querySelector(contentSel)
        ? [...el.querySelectorAll(contentSel)].map(block => block.textContent ?? '').join('\n')
        : el.textContent ?? ''),
    }));
  }
  return [...document.querySelectorAll('[data-chatgpt-search-unit-key]')].flatMap((el) => {
    const key = el.getAttribute('data-chatgpt-search-unit-key') ?? '';
    const role = key.slice(key.lastIndexOf(':') + 1);
    if (role !== 'user' && role !== 'assistant') return [];
    return [{
      role,
      id: (el.getAttribute('data-chatgpt-search-message-ids') ?? '').trim().split(/\s+/)[0] || null,
      text: contentSel === null ? '' : (el.querySelector(contentSel)
        ? [...el.querySelectorAll(contentSel)].map(block => block.textContent ?? '').join('\n')
        : el.textContent ?? ''),
    }];
  });
}

/**
 * 입력창에 실제로 들어 있는 글 — **브라우저 안에서 실행된다.** innerText 를 쓰지 않는다.
 *
 * 개편 입력창은 URL 을 링크 위젯으로 바꾸며 아이콘(`contenteditable=false`·`aria-hidden`)을
 * 끼워 넣는데, innerText 는 그 아이콘 자리에 줄바꿈을 그린다. 줄 중간의 URL 이면 그 줄이
 * 둘로 보여 같은 글인데도 검증이 막혔다(platelog#3). 장식을 빼고 글자만 읽는다.
 */
export function readComposerInPage(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll('[contenteditable="false"], [aria-hidden="true"]').forEach((n) => n.remove());
  copy.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  // 블록 경계는 줄바꿈이다 — 맨글자와 블록이 섞여 있어도 앞 글자를 잃지 않는다.
  copy.querySelectorAll('p, div, pre, h1, h2, h3, h4, h5, h6, li, blockquote').forEach((b) => { if (b.previousSibling) b.before('\n'); });
  return copy.textContent ?? '';
}

/**
 * 입력창의 글을 보낸 글과 비교할 형태로 편다.
 *
 * **줄바꿈 개수는 보지 않는다.** 개편 입력창은 블록 앞뒤와 끝에 줄바꿈을 더 그린다 — 같은
 * 글인데 달라 보여 전송이 매번 막혔다. 글자는 전부 대조하므로 잘림과 칩 치환(URL 이
 * owner/repo#N 으로 바뀌던 사고)은 여전히 잡힌다.
 */
export function composerText(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\n+/g, '\n').replace(/^\n|\n$/g, '');
}

/** 고정 diff 첨부 이름 (reviewer.ts 가 만든다) — 이 모양이면 우리가 올린 파일이다. */
const OWN_ATTACHMENT = /^review-diff-[0-9a-f]{12}-[0-9a-f]{12}-[0-9a-f]{8}\.txt$/;

/**
 * 입력창에 남은 것이 **우리가 넣다 만 리뷰 프롬프트**인지 (순수 함수).
 *
 * 진입 가드는 사람의 초안을 지키려고 입력창이 비어 있지 않으면 멈춘다. 그런데 실패한 입력이
 * 남긴 잔해도 같은 모양이라, 한 번 남으면 프로필 저장소에 남아 탭을 새로 열어도 재시작해도
 * 모든 리뷰가 막혔다 (2026-10-10 · 붙여넣기 검증이 3초 제한에 걸린 뒤 약 3시간 · PR 41개).
 * 그래서 우리 것이 확실한 경우만 지운다: 첨부는 전부 `review-diff-…txt` 이고, 글은 비었거나
 * 보내려던 프롬프트의 앞부분이거나 템플릿 머리말(첫 `{{` 앞, 20자 이상)로 시작한다.
 * 그 밖에는 전부 사람의 것으로 보고 남긴다.
 */
export function isOwnDraft(text: string, files: string[], template: string, prompt?: string, ownFile?: string): boolean {
  if (!files.every((f) => f === ownFile || OWN_ATTACHMENT.test(f))) return false;
  const t = composerText(text).trim();
  if (!t) return true;
  if (prompt && composerText(prompt).startsWith(t)) return true;
  const head = composerText(template.split('{{')[0]).trim();
  return head.length >= 20 && t.startsWith(head);
}

/**
 * 마지막 질문이 그 라운드이거나, 그 뒤의 답이 검증을 통과하는지 확인한다.
 * 맞으면 마지막 질문 직전의 어시스턴트 메시지 수를 돌려준다 (없으면 null) — 회수는 "있다" 는
 * 판정으로만 쓴다. 답 자체는 서버 기록에서 받는다 (`collectResponse`).
 *
 * 후속 질문의 문구 대신 acceptFollowup으로 답의 리뷰 형식·대상을 검증한다.
 * requireResponse는 답 없이 끝난 전송의 재확인에 쓴다 — 같은 빈 자리를 기다리지 않는다.
 */
export function findRoundBaseline(
  msgs: ConversationMessage[], marker: string, requireResponse = false,
  acceptFollowup?: (raw: string) => boolean,
): number | null {
  let lastUser = -1;
  let reviewUser = -1;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== 'user') continue;
    lastUser = i;
    if (msgs[i].text.includes(marker)) reviewUser = i;
  }
  if (reviewUser < 0) return null;
  const answer = msgs.slice(lastUser + 1).find(m => m.role === 'assistant');
  if (lastUser !== reviewUser && !acceptFollowup?.(answer?.text ?? '')) return null;
  if (requireResponse && !answer?.text.trim()) return null;
  return msgs.slice(0, lastUser).filter((m) => m.role === 'assistant').length;
}

/** 화면의 메시지 하나 — 역할과 식별자만 (전송 확인에 쓴다). */
export interface MessageRef {
  role: string;
  id: string | null;
}

/**
 * 전송 직후 화면의 질문 목록으로 본 전송 여부 (`verifyPromptSent`).
 *
 *   sent     직전 질문 뒤에 새 질문이 있다 — 식별자가 없으면 질문 수가 늘었다
 *   detached 직전 질문이 화면에서 떼어졌다. 새 질문을 띄우며 화면 밖 턴을 떼어낸 모습인데,
 *            하나 늘고 하나 빠져 개수로는 안 갈린다 (osk-system#162·#165 — 대화에 질문이
 *            하나뿐인 2차 라운드). 이것만으로는 전송 근거가 아니다 — 호출부가 입력창으로 확정한다
 *   pending  아직 모른다
 */
export function judgePromptSent(
  users: MessageRef[], lastUserIdBefore: string | null, beforeCount: number,
): 'sent' | 'detached' | 'pending' {
  if (lastUserIdBefore) {
    const idx = users.findIndex((m) => m.id === lastUserIdBefore);
    if (idx !== -1) return idx + 1 < users.length ? 'sent' : 'pending';
  }
  if (users.length > beforeCount) return 'sent';
  return lastUserIdBefore && users.length > 0 ? 'detached' : 'pending';
}

/** 전송 후 대화 주소(/c/<uuid>)가 확정되기를 기다리는 최대 시간. */
const CONVERSATION_URL_TIMEOUT_MS = 15_000;

/**
 * 아무것도 오고 있지 않은 채 이만큼 지나면 생성이 답 없이 끝난 것으로 본다 (`GenerationEndedError`).
 * "아무것도" = 서버가 생성 중이 아니고, 기록에 이번 질문의 끝난 답이 없고, 생성 요청도 없다.
 *
 * ChatGPT 에서 생성을 중지하거나 연결이 끊긴 경우가 이 모습이다. 모르면 응답 예산을 통째로
 * 기다린다 — sky-fishing#2 는 본문 0자인 채로 25분 예산 끝까지 기다렸다. 회수 예산(150초) 안에
 * 끝나야 회수가 타임아웃으로 접혀 다시 돌지 않는다. 서버가 상태를 바꾸고 기록을 남기기까지의
 * 틈(몇 초)과 비교도 안 되게 잡는다.
 */
const ENDED_QUIET_MS = 60_000;

/**
 * 응답 예산이 다 됐는데 생성이 **확실히** 진행 중이면 같은 예산을 이 횟수까지 더 준다.
 *
 * 큰 diff 는 추론이 예산을 넘긴다 (실측: 1.8MB diff 가 39분 — sky-fishing#2). 예전에는 그때
 * 타임아웃으로 접고 1분마다 대화를 다시 열어 확인했다 — 그동안 라운드가 실패로 표시되고
 * 슬롯을 놓았다 다시 잡았으며, 다시 연 탭은 수신이 끊긴 관전자가 됐다. "확실히" 는 서버가
 * 생성 중이라고 하거나(`stream_status`) 생성 요청이 살아 있다는 것이다.
 * ponytail: 생성이 끝없이 살아 있는 고장에 대비한 상한이다. 더 긴 추론이 흔해지면 올린다.
 */
const MAX_RESPONSE_EXTENSIONS = 2;

/** 서버가 생성 중이 아닐 때 한도 배너를 다시 확인하는 주기. */
const QUOTA_RECHECK_MS = 30_000;

/** 전송 전, 진행 중인 생성이 끝나기를 기다리는 폴링 간격. */
const IDLE_POLL_MS = 3_000;

/**
 * 생성 네트워크가 이만큼 조용하면 (a) 스트림 사망 **후보**로 기록한다.
 *
 * 판정이 아니라 관측이다. 무트래픽 시간은 종료의 적극적 근거가 못 된다 —
 * 생성 POST 가 먼저 끝나고 결과가 비동기로 오는 구조라면, 서버가 오래 추론하는
 * 동안 조용한 게 정상이다. 여기서 종료로 승격하면 부분 응답을 완성본으로
 * 게시하게 되고, 그건 이슈 #1 이 애초에 경계한 조기 절단이다.
 */
const STREAM_QUIET_LIMIT_MS = 180_000;

/** 스트리밍 판정에 쓰는 신호들. */
export interface StreamSignals {
  /** 중지 버튼이 보이는가 */
  button: boolean;
  /** 생성 요청을 한 번이라도 관측했는가 (= 네트워크 추적이 동작하는가) */
  sawGeneration: boolean;
  /** 진행 중인 생성 요청 수 */
  inFlight: number;
  /** 마지막 생성 네트워크 움직임 이후 경과 (ms) */
  quietMs: number;
}

/**
 * 정체 구간의 성격을 분류한다 (순수 함수 — 이슈 #1 의 판별 근거).
 *
 * **판정이 아니라 관측이다.** 이 값으로 대기를 끊지 않는다. 이슈가 가려야 한다고
 * 적어둔 (a)스트림 사망 / (b)셀렉터 오탐 / (c)실제 생성 중을 사후에 구분할 수 있게
 * 근거를 남기는 것이 목적이다.
 *
 * 무트래픽 시간을 종료로 승격하지 않는 이유: 생성 POST 가 먼저 끝나고 결과가
 * 비동기로 전달되는 구조라면 서버가 오래 추론하는 동안 조용한 게 정상이고,
 * 그때 끊으면 안정돼 보이는 부분 응답을 완성본으로 게시한다. 정상 응답이 수 분
 * 걸리는 게 실제 운영 범위다.
 */
export type StallEvidence =
  | 'idle' // 중지 버튼이 없다 — 생성 중이 아니다
  | 'generating' // 생성 요청이 진행 중 — (c) 실제 생성으로 보인다
  | 'network-quiet' // 버튼은 남았는데 네트워크가 오래 조용 — (a) 후보
  | 'untracked'; // 생성 요청을 한 번도 못 봄 — 판별 불가

export function classifyStall(
  s: StreamSignals,
  quietLimitMs: number = STREAM_QUIET_LIMIT_MS,
): StallEvidence {
  if (!s.button) return 'idle';
  if (!s.sawGeneration) return 'untracked';
  if (s.inFlight > 0) return 'generating';
  return s.quietMs >= quietLimitMs ? 'network-quiet' : 'generating';
}

/**
 * 중지 버튼이 안 사라지는데 다른 근거가 전부 "끝났다" 일 때, 이만큼 화면이
 * 멎어 있으면 버튼을 고장으로 본다.
 *
 * 관측(#109, 1차 리뷰): 응답은 392초에 1,014자로 완성됐고 그 뒤 18분 동안
 * 한 글자도 변하지 않았는데, `data-testid="stop-button"` 이 visible·enabled
 * 로 DOM 에 남아 완료 조건(`!streaming`)이 영원히 성립하지 않았다. 25분
 * 예산을 전부 태우고 **완성된 리뷰를 버린 뒤** 라운드를 실패로 접었다.
 * 사람이 브라우저에서 본 답은 정상이었다.
 *
 * 정상 스트리밍의 토큰 간격과는 비교가 안 되는 길이로 잡는다.
 */
const STUCK_BUTTON_SETTLE_MS = 120_000;

/** 중지 버튼 고장 판정에 쓰는 신호들. */
export interface StuckButtonSignals {
  /** 이번 라운드의 생성 요청을 관측했는가 (전송 직전에 초기화된다) */
  sawGeneration: boolean;
  /** 지금 진행 중인 생성 요청 수 */
  inFlight: number;
  /** 생성 네트워크(POST · WebSocket 프레임)가 마지막으로 움직인 뒤 흘러간 시간 */
  quietMs: number;
  /** 버튼이 남은 채 기다린 시간 */
  idleMs: number;
}

/**
 * 중지 버튼이 **어떤 살아 있는 생성에도 받침되지 않는가** — 순수 함수 (`waitUntilIdle`).
 *
 * 버튼 하나를 유일한 권위로 삼으면, 버튼이 DOM 에 남는 순간 예산을 통째로 태운다.
 *
 * 네 조건을 모두 요구한다 — 하나라도 빼면 이슈 #1 이 경계한 조기 절단이 된다:
 *
 *  - `sawGeneration`: **이번 라운드의** 생성 요청을 봤는가. 드라이버 수명 동안
 *    유지되는 값이면 지난 라운드의 관측을 근거로 쓰게 되므로, 전송 직전에
 *    초기화해 이번 생성으로 스코프한다.
 *  - `inFlight === 0`: 생성 POST 가 열려 있으면 진짜 만드는 중이다.
 *  - `quietMs`: POST 가 닫힌 뒤에도 **WebSocket 으로 흘르는 구간**이 있다. 프레임이
 *    오면 lastNetAt 이 갱신되므로, 네트워크가 오래 조용해야만 끝난 것으로 본다.
 *  - `idleMs`: 토큰 간격으로는 설명되지 않는 정지.
 */
export function judgeStuckButton(
  s: StuckButtonSignals,
  quietLimitMs: number = STREAM_QUIET_LIMIT_MS,
  settleMs: number = STUCK_BUTTON_SETTLE_MS,
): boolean {
  if (!s.sawGeneration) return false;
  if (s.inFlight > 0) return false;
  if (s.quietMs < quietLimitMs) return false;
  return s.idleMs >= settleMs;
}

/**
 * 응답을 기다리는 동안 서버에 묻는 간격 (`stream_status` · 생성이 끝났으면 대화 기록).
 * 서버가 끝낸 답을 받기까지 최대 이만큼 늦다 — 응답 시간(2~15분)에 비하면 무시할 수준이다.
 */
const SERVER_POLL_MS = 10_000;
/** 서버 조회 한 번의 상한 — 넘으면 null 이다. */
const SERVER_STATUS_TIMEOUT_MS = 10_000;
/**
 * 서버 기록을 이만큼 계속 못 읽으면 라운드를 실패로 접는다 — 화면 글자로 대신하지 않는다.
 * 한두 번의 일시 실패는 넘긴다. 비공개 API 가 바뀌었으면 응답 예산(25분)을 다 기다리지 않고 바로 드러난다.
 */
const SERVER_UNREAD_LIMIT_MS = 120_000;
/**
 * 서버 기록의 질문 시각(서버 시계)을 전송 시각(이 컴퓨터 시계)과 비교할 때의 여유 — 기준 질문 id 가
 * 없는 구버전 기록의 회수에서만 쓴다. 실측 차이는 몇 초다 (질문 create_time 이 전송 직후 기록됨).
 */
const SERVER_CLOCK_SKEW_MS = 60_000;
/** 화면을 보조로 읽는 호출(한도 배너·진단 문구)의 상한 — 멎은 탭에서도 대기 루프가 멎지 않게. */
const SCREEN_PEEK_TIMEOUT_MS = 15_000;

/** 시간 안에 안 끝나면 TIMED_OUT — Playwright 의 페이지 호출에는 제한이 없어 멎은 탭에서 영영 기다린다. */
const TIMED_OUT = Symbol('timed-out');
async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
  try { return await Promise.race([work, late]); } finally { clearTimeout(timer); }
}

/** 탭과 무관하게 쉰다 — `page.waitForTimeout` 은 멎은 탭에서 돌아오지 않는다. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 페이지 안에서 로그인 토큰으로 비공개 API 를 부른다 — 토큰은 페이지 밖으로 나오지 않는다. 실패는 null. */
async function fetchServerInPage({ path, ms }: { path: string; ms: number }): Promise<unknown> {
  try {
    // 두 요청과 본문 읽기를 한 시간 제한으로 묶는다. 응답이 끝나지 않는 연결은 예외도 없이
    // 수집을 붙잡아, 답이 화면에 떠도 못 받고 슬롯을 점유한다 (#60 리뷰).
    const signal = AbortSignal.timeout(ms);
    const session = await (await fetch('/api/auth/session', { credentials: 'include', signal })).json();
    if (!session?.accessToken) return null;
    const r = await fetch(path, {
      headers: { Authorization: `Bearer ${session.accessToken}` }, credentials: 'include', signal,
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** 서버 기록의 메시지 하나에서 쓰는 모양만. */
interface ServerMessage {
  author?: { role?: string };
  recipient?: string;
  /** 끝난 메시지는 finished_successfully (2026-10-15 실측) */
  status?: string;
  /** 턴을 끝내는 최종 답만 true — 도구 호출·추론 노드는 false */
  end_turn?: boolean | null;
  /** 서버 시계 · 초 단위 */
  create_time?: number | null;
  content?: { content_type?: string; parts?: unknown[] };
}

/** 서버 대화 기록(`/backend-api/conversation/<id>`)에서 쓰는 모양만. */
export interface ServerConversation {
  current_node?: string;
  mapping?: Record<string, { parent?: string | null; message?: ServerMessage | null }>;
}

/**
 * 현재 가지의 마지막 질문과 그 뒤의 최종 답 (순수 함수).
 *
 * 현재 가지(`current_node` 에서 부모로)만 걷는다 — 다시 생성한 옛 가지의 답을 집으면 안 된다.
 * 추론 요약·도구 호출(content_type 이 text 가 아니거나 받는 쪽이 all 이 아닌 것)은 답이 아니다.
 * 마지막 질문을 만나면 멈춘다 — 그 앞의 답은 직전 라운드의 것이다.
 */
function lastExchange(conv: ServerConversation): {
  questionId: string | null; question: ServerMessage | null; answer: ServerMessage | null; text: string | null;
} {
  const nodes = conv.mapping ?? {};
  const seen = new Set<string>();
  let answer: ServerMessage | null = null;
  let text: string | null = null;
  for (let id = conv.current_node; id && nodes[id] && !seen.has(id); id = nodes[id].parent ?? undefined) {
    seen.add(id);
    const m = nodes[id].message;
    const role = m?.author?.role;
    if (role === 'user') return { questionId: id, question: m ?? null, answer, text };
    if (answer || role !== 'assistant' || (m?.recipient ?? 'all') !== 'all' || m?.content?.content_type !== 'text') continue;
    const body = (m.content.parts ?? []).filter((p): p is string => typeof p === 'string').join('');
    if (body.trim()) { answer = m; text = body; }
  }
  return { questionId: null, question: null, answer, text };
}

/**
 * 이번 질문을 가르는 기준. `askedBefore` 는 **보내기 전** 서버 기록의 마지막 질문 id 다 (null = 새 대화).
 * 구버전 기록에는 없어서 그때만 전송 시각(`sentAt`)으로 가른다.
 */
export interface AskedAfter {
  askedBefore?: string | null;
  sentAt?: number | null;
}

/** 서버 기록이 이번 질문에 대해 말해 주는 것. */
export type ServerVerdict =
  | { kind: 'answer'; text: string } // 이번 질문의 끝난 답 — 이걸 쓴다
  | { kind: 'pending' } // 서버가 아직 생성 중이다
  | { kind: 'unknown'; reason: string }; // 기록에 이번 답이 (아직) 없다 — 무엇이 없는지

/**
 * 서버 기록에 **이번 질문의 끝난 답**이 있는가 (순수 함수).
 *
 * 화면은 답의 출처가 아니다. 노드 교체로 남의 답을 읽고(9차가 7차의 답을 게시), 답 대신
 * "This response couldn’t load" 를 그리고, 서버가 마친 답을 수백 초 늦게 그렸다. 화면 쪽
 * 증상은 하나씩 막아 왔지만 같은 근원에서 계속 새로 나왔다 — 그래서 답은 서버 기록에서만 읽는다.
 *
 *  - **이번 질문인가.** 마지막 질문이 보내기 전의 마지막 질문(`askedBefore`)이 아니다. 시각이나 "생성 중을
 *    봤다" 로는 가르지 않는다 — 앞 라운드가 빨리 끝나 두 질문이 1분 안에 나가면 직전 질문도 시각 여유
 *    안에 들고, 전송 직후의 상태 API·기록은 아직 직전 턴의 COMPLETE·끝난 답을 보여준다 (#68 리뷰).
 *    질문 본문은 서버가 마크다운으로 이스케이프해 저장하므로(`\## 대상 PR`) 보낸 글과 비교하지 않는다.
 *    기준이 없는 구버전 기록만 전송 시각으로 가른다 (회수 경로라 이번 질문은 이미 기록에 있다).
 *  - **끝났는가.** 최종 답이 `finished_successfully` 이고 `end_turn` 이다 — 도구 호출 앞의 중간 답이 아니다.
 *
 * 서버가 생성 중이면 pending, 그 밖은 unknown 이다 (이유를 단다 — 끝내 답이 없을 때 오류에 실린다).
 */
export function judgeServerAnswer(conv: ServerConversation | null, status: string | null, seen: AskedAfter): ServerVerdict {
  if (status === 'IS_STREAMING') return { kind: 'pending' };
  if (!conv) return { kind: 'unknown', reason: '서버 기록 조회 실패' };
  const { questionId, question, answer, text } = lastExchange(conv);
  if (seen.askedBefore !== undefined) {
    if (!questionId || questionId === seen.askedBefore) return { kind: 'unknown', reason: '기록에 이번 질문이 아직 없음' };
  } else {
    const askedAt = typeof question?.create_time === 'number' ? question.create_time * 1000 : Number.NaN;
    if (!(seen.sentAt != null && askedAt >= seen.sentAt - SERVER_CLOCK_SKEW_MS)) {
      return { kind: 'unknown', reason: seen.sentAt == null ? '이번 질문을 가를 기준이 없음' : '기록의 마지막 질문이 이번 전송이 아님' };
    }
  }
  if (!text || answer?.status !== 'finished_successfully' || answer.end_turn !== true) {
    return { kind: 'unknown', reason: '기록에 끝난 답 없음' };
  }
  return { kind: 'answer', text };
}

/** 복구 판정에 쓰는 신호들. */
export interface BrowserLiveness {
  /** 컨텍스트(= 브라우저)가 살아 있는가 */
  ctxAlive: boolean;
  /** 이 드라이버의 탭이 살아 있는가 */
  pageAlive: boolean;
  /** 이 드라이버가 브라우저를 소유하는가 (fork 는 아니다) */
  owned: boolean;
}

/** 무엇을 되살려야 하는가. */
export type Revival =
  | 'ok' // 그대로 쓴다
  | 'reopen-tab' // 브라우저는 살아 있다 — 탭만 다시 열면 된다
  | 'relaunch' // 브라우저까지 죽었고 내가 소유자다
  | 'give-up'; // 빌려 쓴 브라우저가 죽었다 — 내가 다시 띄울 것이 아니다

/**
 * 지금 들고 있는 브라우저로 계속 일할 수 있는지 판정한다 (순수 함수).
 *
 * 복구는 **최소 범위**여야 한다. 동시 리뷰는 한 컨텍스트를 여러 탭이 나눠
 * 쓰므로(`fork`), 탭 하나 죽었다고 컨텍스트를 다시 띄우면 형제 라운드를
 * 모두 죽인다. 빌려 쓴 드라이버는 남의 브라우저를 다시 띄울 권한도 없다.
 */
export function judgeRevival(s: BrowserLiveness): Revival {
  if (s.ctxAlive && s.pageAlive) return 'ok';
  if (s.ctxAlive) return 'reopen-tab';
  return s.owned ? 'relaunch' : 'give-up';
}

/**
 * "안정됐다" 고 인정할 연속 동일 관측 횟수.
 *
 * countSettledMessages(기존 메시지 개수 확정)와 collectResponse 의 완료 판정이
 * 같은 값을 쓴다 — 두 판정은 관측 간격만 다를 뿐 "몇 번 같아야 믿는가" 는
 * 같은 질문이다. 값이 갈리면 한쪽만 민감도가 달라져 사고 재현이 어려워진다.
 */
const SETTLE_STABLE_READS = 3;
const SETTLE_POLL_MS = 500;
const SETTLE_MAX_MS = 15_000;

/** 대화를 열 수 없을 때 ChatGPT 가 본문에 표시하는 문구 (삭제·타 계정 등). */
const CONVERSATION_GONE_PATTERNS: RegExp[] = [
  /unable to load (?:the )?conversation/i,
  /conversation not found/i,
  /대화를 불러올 수 없/,
  /대화를 찾을 수 없/,
];

/**
 * 대화 URL 여부를 판별해 정규화한다 (아니면 null).
 *
 * ChatGPT 는 첫 메시지를 보낸 뒤에야 주소를 /c/<uuid> 로 바꾼다.
 * 프로젝트·GPTs 안에서 열린 대화는 /g/<id>/c/<uuid> 형태이므로 둘 다 받는다.
 */
export function parseConversationUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname;
  const onChatGPT = host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host.endsWith('.openai.com');
  if (!onChatGPT) return null;
  if (!/^(?:\/g\/[^/]+)?\/c\/[0-9a-zA-Z-]+$/.test(u.pathname)) return null;
  return `${u.origin}${u.pathname}`; // 쿼리·프래그먼트는 버린다
}

/** 프로젝트 이름(slug)이 바뀌어도 프로젝트 ID와 대화 ID가 같으면 같은 대화다. */
export function sameConversationUrl(a: string, b: string): boolean {
  const left = parseConversationUrl(a);
  const right = parseConversationUrl(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const project = chatgptProjectId(left);
  return project !== null && project === chatgptProjectId(right)
    && new URL(left).pathname.split('/c/')[1] === new URL(right).pathname.split('/c/')[1];
}

/**
 * 화면 텍스트에서 쿼터/한도 안내를 감지하기 위한 패턴.
 *
 * **정밀 쪽으로 기운다.** 이 판정은 계정 전체를 3시간 쿨다운에 넣으므로 오탐
 * 비용이 크다 — 일시적 서버 오류 토스트("Too many requests", "Try again
 * later")가 여기 걸리면 몇 분이면 풀릴 오류가 3시간 대기가 된다. 반대로 놓치면
 * 라운드 한 번이 타임아웃으로 실패하고 재시도되니 값싸다. 그래서 "한도"·"cap"
 * 같은 한도 어휘가 직접 나오는 문구만 남기고, 재시도 권유만 있는 문구는 버린다.
 */
const QUOTA_PATTERNS: RegExp[] = [
  /(?:hit|reached) (?:your|our|the)[^.]{0,60}(?:cap|limit)/i,
  /\b(?:message|usage) cap\b/i,
  /\bmaximum number of messages\b/i,
  /\bmessages? per \d+\s*(?:hours?|시간)/i,
  /try again (?:in|at) [^.]{0,40}(?:hour|시간)/i,
  /한도에 도달/,
  /사용량 한도/,
  /메시지 한도/,
];

export class ChatGPTDriver {
  private ctx: BrowserContext | null = null;
  private page: Page | null = null;
  private readonly cfg: AppConfig;
  /**
   * 이 드라이버가 브라우저를 **소유**하는가 (= close 가 브라우저를 닫아도 되는가).
   *
   * `fork` 로 만든 드라이버는 탭만 자기 것이다. 그걸 닫으면서 컨텍스트까지 닫으면
   * 같은 브라우저를 쓰는 다른 라운드가 통째로 죽는다.
   */
  private owned = true;

  /**
   * 화면을 조작할 차례 — **같은 브라우저의 탭들이 한 줄로 선다** (fork 가 같은 줄을 물려받는다).
   *
   * 동시 리뷰에서 겹쳐도 되는 구간은 응답 대기뿐이다. 같은 프로필의 ChatGPT 탭은 서로
   * 독립이 아니다 — 한 탭이 입력하는 동안 옆 탭이 전송하자 입력하던 탭의 전송 버튼과
   * 입력창이 사라졌고(Artificial-Consciousness#40 두 번), 입력 구간이 겹친 배치에서는
   * 전송 클릭이 평소 1초 미만에서 4초로 늘었다.
   */
  private turn: { tail: Promise<void> } = { tail: Promise.resolve() };
  /** 쥐고 있는 차례를 놓는다 (안 쥐었으면 null). */
  private leaveTurn: (() => void) | null = null;

  // ── 생성 네트워크 관측 (이슈 #1) ──
  /** 생성 요청을 한 번이라도 봤는가 = 추적이 동작하는가 */
  private sawGeneration = false;
  /** 진행 중인 생성 요청 수 */
  private netInFlight = 0;
  /** 마지막으로 생성 네트워크가 움직인 시각 */
  private lastNetAt = 0;
  /** 이 탭을 더 쓰지 않는다 — 다음 라운드 전에 `ensureAlive` 가 새 탭으로 갈아 끼운다 (`retirePage`). */
  private pageRetired = false;
  /** 서버 조회 사이에 쉰다 — 탭과 무관한 타이머라 탭이 멎어도 돈다. */
  private nap = sleep;

  constructor(config: AppConfig) {
    validateProjectUrl(config.chatgptProjectUrl);
    this.cfg = config;
  }

  // ── 라이프사이클 ──────────────────────────────────────────

  async launch(headless = this.cfg.headless): Promise<void> {
    this.ctx = await chromium.launchPersistentContext(this.cfg.browserProfileDir, {
      channel: this.cfg.browserChannel as any,
      headless,
      viewport: { width: 1280, height: 900 },
      // 셀렉터는 영어 화면을 전제한다 ('Select ChatGPT model' · "N of M" · "New chat in …").
      // 고정하지 않으면 화면 언어가 프로필 설정을 따르는데, 그 값은 Chrome 동기화가 바꾼다 —
      // 2026-10-09 프로필을 일반 Chrome 으로 한 번 열자 계정의 ko-KR 이 account_values.intl 로
      // 내려와 다음 기동부터 화면이 한국어가 됐고, 프로젝트 진입과 추론 강도 설정이 모두 막혔다.
      locale: 'en-US',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
    this.page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
    this.pageRetired = false;
    await this.preparePage(this.page);
  }

  /**
   * 이 드라이버로 계속 일할 수 있게 만든다. 필요하면 탭만, 최소한으로 되살린다.
   *
   * 관측(#109): 사람이 Chrome 창을 닫자 `page.goto` 가 "Target page, context
   * or browser has been closed" 로 실패했고, launch() 는 데몬 기동 때 한 번
   * 뿐이라 그 뒤 **모든 라운드가 같은 오류로** 죽었다. 한 번의 실패는 어쩌
   * 수 없지만 그 영속성은 회복 경로가 없어서 생긴 별개의 결함이다.
   *
   * **복구 범위를 최소로 잡는다.** 동시 리뷰는 한 컨텍스트를 여러 탭이
   * 나눠 쓰므로(`fork`), 탭 하나 죽었다고 컨텍스트를 다시 띄우면 **형제
   * 라운드를 모두 죽인다** — close() 가 빌려 쓴 탭만 닫는 것과 같은 이유다.
   *
   *  - 탭만 죽었고 브라우저는 살아 있다 → 같은 컨텍스트에 탭만 다시 열는다.
   *  - 브라우저까지 죽었고 이 드라이버가 소유자다 → 다시 띄운다.
   *  - 브라우저까지 죽었는데 빌려 쓴 드라이버다 → 남의 브라우저를 다시
   *    띄울 권한이 없다. 소유자가 처리할 일이므로 분명히 실패시킨다.
   *
   * 로그인은 persistent profile 에 남으므로 다시 띄워도 그대로 이어진다.
   *
   * 버리기로 한 탭(`retirePage`)도 여기서 갈아 끼운다 — 라운드 시작 때만이다 (`replaceRetired`).
   *
   * @returns 되살렸으면 true (살아 있었으면 false)
   */
  async ensureAlive(replaceRetired = true): Promise<boolean> {
    const ctxAlive = this.ctx !== null && (this.ctx.browser()?.isConnected() ?? true);
    const pageAlive = this.page !== null && !this.page.isClosed() && !(replaceRetired && this.pageRetired);
    const plan = judgeRevival({ ctxAlive, pageAlive, owned: this.owned });
    if (plan === 'ok') return false;

    // 새 페이지는 아직 아무 트래픽도 보지 못했다. 관측을 물려주면 다음
    // 라운드가 근거 없이 "생성 요청 없음" 을 믿게 된다 (judgeStuckButton 의 전제).
    const resetTraffic = (): void => {
      this.sawGeneration = false;
      this.netInFlight = 0;
      this.lastNetAt = 0;
    };

    if (plan === 'reopen-tab' && this.ctx) {
      const old = this.page;
      console.log(chalk.yellow(this.pageRetired
        ? '  ⚠ 직전 라운드의 탭을 버리고 새 탭을 엽니다.'
        : '  ⚠ 탭이 닫혔 있습니다 — 같은 브라우저에 탭만 다시 엽니다.'));
      // 새 탭을 먼저 연다 — 탭이 하나도 없는 순간을 만들지 않는다.
      this.page = await this.ctx.newPage();
      this.pageRetired = false;
      await old?.close().catch(() => {});
      await this.preparePage(this.page);
      resetTraffic();
      await this.navigateToChatGPT();
      return true;
    }

    if (plan === 'give-up') {
      throw new Error(
        '빌려 쓴 브라우저가 닫혔습니다 — 소유자가 아니므로 다시 띄우지 않습니다.',
      );
    }

    console.log(
      chalk.yellow('  ⚠ 브라우저가 닫혔 있습니다 — 다시 띄우니다 (로그인은 프로필에 남아 있습니다).'),
    );
    // 죽은 컨텍스트는 닫기도 실패할 수 있다 — 실패해도 새로 띄우는 걸 막지 않는다.
    try {
      await this.ctx?.close();
    } catch {
      /* 이미 죽었다 */
    }
    this.ctx = null;
    this.page = null;
    resetTraffic();

    await this.launch();
    await this.navigateToChatGPT();
    return true;
  }

  /**
   * 생성 요청의 생사를 추적한다 (이슈 #1 판별 근거).
   *
   * 중지 버튼만 보고는 "정말 만드는 중" 인지 "버튼이 안 사라진 것" 인지 가릴 수
   * 없다. 실제로 12분간 같은 글자 수로 "생성 중" 이 유지되어 15분 예산을 통째로
   * 태운 적이 있다. 네트워크가 조용한지 보면 그 둘이 갈린다.
   *
   * 패턴에 안 걸려 한 번도 관측하지 못하면 `sawGeneration` 이 false 로 남고,
   * 그때는 판정을 바꾸지 않는다 — 근거 없는 조기 절단이 더 나쁘다.
   */
  private async preparePage(page: Page): Promise<void> {
    if (this.cfg.headless) {
      // 설치된 Chrome 버전을 그대로 사용한다. headless 식별자에서는 같은 프로필도
      // ChatGPT 홈/로그인이 로드되지 않아 일반 모드와 같은 UA로 맞춘다.
      const session = await page.context().newCDPSession(page);
      const { userAgent } = await session.send('Browser.getVersion');
      // acceptLanguage 를 빼면 이 호출이 위의 locale 고정을 프로필 언어로 되돌린다.
      await session.send('Network.setUserAgentOverride', {
        userAgent: userAgent.replace('HeadlessChrome/', 'Chrome/'), acceptLanguage: 'en-US,en',
      });
    }
    this.trackGenerationTraffic(page);
  }

  private trackGenerationTraffic(page: Page): void {
    page.on('crash', () => console.error(chalk.red('  ✗ Chrome 리뷰 탭 crash 감지')));
    const isGeneration = (url: string, method: string): boolean =>
      method === 'POST' && /\/backend-api\/[^?]*conversation/.test(url);

    page.on('request', (r) => {
      if (!isGeneration(r.url(), r.method())) return;
      this.sawGeneration = true;
      this.netInFlight++;
      this.lastNetAt = Date.now();
    });
    const settle = (r: { url: () => string; method: () => string }): void => {
      if (!isGeneration(r.url(), r.method())) return;
      this.netInFlight = Math.max(0, this.netInFlight - 1);
      this.lastNetAt = Date.now();
    };
    page.on('requestfinished', settle);
    page.on('requestfailed', settle);

    // 일부 구간은 웹소켓으로 흐른다 — 프레임이 오면 살아 있는 것이다.
    page.on('websocket', (ws) => {
      ws.on('framereceived', () => {
        this.lastNetAt = Date.now();
      });
    });
  }

  /**
   * 같은 브라우저(= 같은 로그인 프로필)에 **탭을 하나 더 열어** 드라이버를 만든다.
   *
   * 동시 리뷰는 라운드마다 탭이 따로 있어야 한다. 한 탭을 나눠 쓰면 한쪽이 넣은
   * 프롬프트가 다른 쪽의 입력창에 들어가고, 전송 버튼 자리의 중지 버튼을 눌러
   * 남의 생성을 끊는다 (`waitUntilIdle` 이 막는 사고가 정확히 그것이다).
   *
   * 로그인 세션은 컨텍스트가 가지므로 탭마다 다시 로그인할 필요는 없다.
   */
  async fork(): Promise<ChatGPTDriver> {
    // 복구를 **탭 임대보다 먼저** 한다. watch 루프는 runRound 들을 부르기 전에
    // 배치의 탭을 전부 임대하므로, 브라우저가 닫힌 뒤에는 여기서 죽은 ctx 의
    // newPage() 가 먼저 터진다. 그러면 소유 드라이버가 runRound 에서 복구할 기회를
    // 얻기 전에 배치 전체가 시작도 못 하고, 다음 사이클도 같은 ctx 에서 다시
    // fork 하여 데몬 재시작 전까지 반복 실패한다 — 이 PR 이 없애려는 바로 그
    // 영속 고착이다. 여기서 먼저 되살리면 탭을 빌리는 모든 경로가 보호된다.
    // 부모 탭은 라운드 중일 수 있다 — 버릴 탭이어도 여기서 갈아 끼우면 그 라운드의 화면이 닫힌다.
    await this.ensureAlive(false);
    const ctx = this.ctx;
    if (!ctx) throw new Error('Browser not launched — call launch() first');
    const child = new ChatGPTDriver(this.cfg);
    child.ctx = ctx;
    child.owned = false;
    child.turn = this.turn; // 차례는 탭이 아니라 브라우저 단위다
    child.page = await ctx.newPage();
    try {
      await child.preparePage(child.page);
      // 첫 로딩은 **라운드를 시작하기 전에** 끝낸다 (지금은 옆 탭이 쉬고 있다).
      // 실측: 디스크 부족으로 프로필의 쿠키 DB 가 비워진 뒤, 메모리 상태로 버티던 기존
      // 탭은 멀쩡했고 새 탭은 전부 입력창을 못 띄웠다(osk-system#114·#115 · platelog#3 ·
      // pelican-music#51). 라운드 안에서 실패하면 탭 사정인데도 PR 이 오류·재시도
      // 횟수·5분 대기를 떠안는다. 여기서 실패하면 탭 임대만 실패하고 PR 은 다음 배치로 간다.
      //
      //
      // 로딩은 **차례를 기다리지 않는다.** 옆 탭이 입력하는 도중에 뜬 탭은 공유 초안의 사본을
      // 갖게 되지만(2026-10-10 · platelog-site#1 과 동시에 뜬 탭 둘에서 9회), 그 사본은 우리
      // 리뷰 프롬프트라 진입할 때 `clearOwnDraft` 가 지운다. 한때 여기서 차례를 기다렸더니,
      // 임대가 앞선 라운드들의 진입·입력이 다 끝날 때까지 막히고 그동안 사이클 전체(스캔·나머지
      // 슬롯)가 멈췄다 — 동시 리뷰 수를 5로 올려도 6분 넘게 2건만 돌았다 (2026-10-12).
      await child.navigateToChatGPT();
      await child.requirePage().locator(this.cfg.selectors.textInput).first().waitFor({ state: 'visible', timeout: 15_000 });
    } catch (error) {
      const seen = await child.describePage();
      await child.close();
      const reason = (error instanceof Error ? error.message : String(error)).split('\n')[0];
      throw new Error(`새 탭이 ChatGPT 입력창까지 가지 못했습니다: ${reason} — 화면: ${seen}`, { cause: error });
    }
    return child;
  }

  /** 지금 화면을 한 줄로 — 주소 · 제목 · 보이는 글자 앞부분 (진단용, 실패해도 원래 오류가 먼저다). */
  private async describePage(): Promise<string> {
    const p = this.page;
    if (!p) return '(탭 없음)';
    let title = '';
    let text = '';
    try {
      title = await p.title();
      text = await p.locator('body').innerText({ timeout: 3_000 });
    } catch { /* 읽은 데까지만 */ }
    return `${p.url()} · 제목 "${title}" · "${text.replace(/\s+/g, ' ').trim().slice(0, 120)}"`;
  }

  /**
   * 진입부터 전송까지를 **차례를 쥔 채** 실행한다 (필드 `turn` 참고).
   *
   * 응답 대기에 들어서면 `collectResponse` 가 그 자리에서 차례를 넘긴다 — 그래서
   * 2~15분짜리 대기는 그대로 겹치고 입력 구간만 한 줄로 선다. 실패해도 넘긴다.
   * 안 넘기면 옆 탭이 영영 못 들어온다.
   *
   * ponytail: 전송 전 `waitUntilIdle` 은 차례를 쥔 채 기다린다 — 복귀한 대화가 아직
   * 생성 중인 드문 경로라 옆 탭이 늦어질 뿐이다. 잦아지면 그 대기 동안 차례를 넘긴다.
   */
  async withTurn<T>(fn: () => Promise<T>): Promise<T> {
    const before = this.turn.tail;
    let leave!: () => void;
    this.turn.tail = new Promise<void>((resolve) => { leave = resolve; });
    await before;
    this.leaveTurn = leave;
    try {
      return await fn();
    } finally {
      this.endTurn();
    }
  }

  private endTurn(): void {
    const leave = this.leaveTurn;
    this.leaveTurn = null;
    leave?.();
  }

  /**
   * 이 탭을 더 쓰지 않는다 — 다음 라운드 전에 `ensureAlive` 가 새 탭으로 갈아 끼운다.
   *
   * 슬롯 0 은 브라우저 자체라 실패해도 버리지 않았는데(추가 탭은 `dropTab`), 그 탭이 망가지면
   * 다음 라운드들이 전부 같은 탭에서 실패했다: 2026-10-13 lolchess_base#137 의 응답 대기에서
   * 수십 분씩 멎은 탭으로 #137·#139 가 6번 연속 "사이드바에서 프로젝트를 찾지 못했습니다"
   * 로 재시도 예산을 다 썼다 (같은 시각 다른 탭의 #138 은 진입·게시까지 정상).
   */
  retirePage(): void {
    this.pageRetired = true;
  }

  async close(): Promise<void> {
    // 빌려 쓴 탭은 탭만 닫는다 — 브라우저는 소유자의 것이다.
    if (!this.owned) {
      await this.page?.close().catch(() => {});
      this.page = null;
      this.ctx = null;
      return;
    }
    if (this.ctx) {
      await this.ctx.close();
      this.ctx = null;
      this.page = null;
    }
  }

  // ── 로그인 ────────────────────────────────────────────────

  /** 라운드가 모두 끝난 뒤에만 호출한다. 로그인은 사용자가 직접 수행한다. */
  async openAccountBrowser(): Promise<void> {
    await this.close();
    await this.launch(false);
    await this.navigateToChatGPT();
    await this.requirePage().bringToFront();
  }

  async navigateToChatGPT(): Promise<void> {
    const p = this.requirePage();
    await p.goto(this.cfg.chatgptUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  }

  /** 현재 페이지가 ChatGPT 오리진에 있는지. */
  private isOnChatGPT(page: Page): boolean {
    try {
      const h = new URL(page.url()).hostname;
      return h === 'chatgpt.com' || h.endsWith('.chatgpt.com') || h.endsWith('.openai.com');
    } catch {
      return false; // about:blank 등
    }
  }

  /** ChatGPT 세션 쿠키 보유 여부 — 페이지 위치와 무관하게 판별 가능. */
  private async hasSessionCookie(): Promise<boolean> {
    try {
      const cookies = (await this.ctx?.cookies()) ?? [];
      return cookies.some(
        (c) =>
          c.name.includes('next-auth.session-token') &&
          c.domain.includes('chatgpt.com') &&
          !!c.value,
      );
    } catch {
      return false;
    }
  }

  /**
   * 로그인된 계정 정보를 반환한다 (로그아웃이면 null).
   * ChatGPT 오리진에 있을 때만 조회 가능하다.
   */
  async getSessionUser(): Promise<{ id?: string; email?: string; name?: string } | null> {
    const p = this.requirePage();
    if (!this.isOnChatGPT(p)) return null;
    try {
      return await p.evaluate(async () => {
        const r = await fetch('/api/auth/session', { credentials: 'include' });
        if (!r.ok) return null;
        const j = (await r.json().catch(() => null)) as any;
        if (!j?.user) return null;
        return { id: j.user.id, email: j.user.email, name: j.user.name };
      });
    } catch {
      return null; // 네비게이션 중 등
    }
  }

  /**
   * 실제 인증 여부를 판별한다.
   *
   * 주의 1: 로그아웃 상태의 chatgpt.com 도 입력창(#prompt-textarea)을 그대로 노출하므로
   *         DOM 요소 존재만으로는 판별할 수 없다.
   * 주의 2: OAuth 진행 중에는 accounts.google.com 등 외부 오리진에 있게 된다.
   *         "ChatGPT 로그인 버튼이 안 보인다" 는 인증의 근거가 될 수 없다.
   *         (이 휴리스틱 때문에 구글 로그인 화면에서 인증됨으로 오판한 적이 있다)
   */
  async isLoggedIn(): Promise<boolean> {
    const p = this.requirePage();

    // ChatGPT 오리진에 있으면 세션 엔드포인트가 가장 정확하다.
    if (this.isOnChatGPT(p)) {
      const user = await this.getSessionUser();
      if (user) return true;
      // 엔드포인트가 응답했는데 user 가 없으면 로그아웃.
      // 단, 차단·오류로 조회 자체가 실패했을 수 있어 쿠키로 한 번 더 확인한다.
      return this.hasSessionCookie();
    }

    // 외부 오리진(OAuth 진행 중 등) — 쿠키로만 판단한다.
    return this.hasSessionCookie();
  }

  /** 사용자가 직접 로그인할 때까지 (최대 10분) 대기. */
  async waitForManualLogin(): Promise<void> {
    console.log(chalk.yellow('\n  ⏳ ChatGPT에 로그인해주세요 (브라우저 창 확인).'));
    console.log(chalk.yellow('     로그인이 완료되면 자동으로 계속됩니다.\n'));

    const deadline = Date.now() + 600_000;
    let notified = false;

    while (Date.now() < deadline) {
      const p = this.requirePage();

      // OAuth 등 외부 오리진에 있는 동안은 완료로 보지 않는다.
      if (!this.isOnChatGPT(p)) {
        if (!notified) {
          console.log(chalk.dim(`     (${new URL(p.url()).hostname} 에서 인증 진행 중…)`));
          notified = true;
        }
        await p.waitForTimeout(3_000);
        continue;
      }
      notified = false;

      const user = await this.getSessionUser();
      if (user) {
        const who = user.email ?? user.name ?? '계정 확인됨';
        console.log(chalk.green(`  ✓ 로그인 확인 — ${who}`));
        return;
      }

      await p.waitForTimeout(3_000);
    }
    throw new Error('로그인 대기 시간 초과 (10분)');
  }

  // ── 대화 ──────────────────────────────────────────────────

  async registerProject(): Promise<void> {
    const entry = await readProjectEntry(this.requirePage(), this.cfg.selectors.textInput);
    this.cfg.chatgptProjectUrl = entry.url;
    this.cfg.chatgptProjectName = entry.name;
    // 수동 진입만 성공한 상태를 등록 완료로 오인하지 않는다.
    await this.navigateToChatGPT();
    await this.startNewChat();
  }

  /** 지금 탭이 ChatGPT 프로젝트 홈이면 그 주소 (네트워크 없이 주소만 본다). */
  projectHomeUrl(): string | null {
    try {
      const url = this.requirePage().url();
      return chatgptProjectId(url) !== null && /\/project\/?$/.test(new URL(url).pathname) ? url : null;
    } catch {
      return null;
    }
  }

  async projectEntry() {
    this.assertProjectPage(this.requirePage());
    return readProjectEntry(this.requirePage(), this.cfg.selectors.textInput);
  }

  /** 새 대화는 설정한 리뷰 전용 프로젝트 안에서만 생성한다. */
  async startNewChat(): Promise<void> {
    const p = this.requirePage();
    const project = requireProjectUrl(this.cfg.chatgptProjectUrl);
    try {
      await enterProject(p, { url: project, name: this.cfg.chatgptProjectName ?? '' }, this.cfg.selectors.textInput,
        () => this.clearOwnDraft(p.locator(this.cfg.selectors.textInput).first()));
    } catch (cause) {
      // 원인과 주소를 **첫 줄에** 둔다 — 로그·상태는 첫 줄만, 그것도 앞에서 자른다.
      // Playwright 오류는 호출 기록이 여러 줄로 붙어, 뒤에 붙인 주소가 통째로 잘렸었다.
      const reason = (cause instanceof Error ? cause.message : String(cause)).split('\n')[0];
      throw new Error(`ChatGPT 프로젝트에 진입하지 못했습니다: ${reason}`
        + ` (현재 주소: ${p.url()}) 데몬 종료 후 npm run dev -- setup 으로 프로젝트를 열어 다시 등록하고,`
        + ' 사이드바에 프로젝트가 보이도록 고정해 주세요.', { cause });
    }
    // 새 대화 진입 시 뜨는 안내 모달을 닫고, 하이드레이션이 끝날 여유를 준다
    await p.keyboard.press('Escape').catch(() => {});
    await p.waitForTimeout(1_000);
    this.assertProjectPage(p);
  }

  /** 프로젝트 접근 실패·일반 대화로의 리다이렉트 시 밖에 전송하지 않는다. */
  private assertProjectPage(page: Page): void {
    const project = requireProjectUrl(this.cfg.chatgptProjectUrl);
    if (chatgptProjectId(page.url()) !== chatgptProjectId(project)) {
      throw new Error('지정한 ChatGPT 프로젝트에 진입하지 못했습니다 — 프로젝트 접근 권한과 URL을 확인하세요.');
    }
  }

  /**
   * 기존 대화로 복귀한다. 열지 못하면 false 를 반환한다 (호출부가 새 대화로 폴백).
   *
   * 대화가 삭제됐거나 다른 계정의 것이면 ChatGPT 는 오류 문구를 띄우거나
   * 루트로 되돌린다. 둘 다 "복귀 실패" 로 취급해야 이전 대화에 이어 쓴 것처럼
   * 착각한 채 엉뚱한 화면에 프롬프트를 넣는 일을 막을 수 있다.
   */
  async resumeChat(url: string, opts: { requireAssistant?: boolean } = {}): Promise<boolean> {
    const p = this.requirePage();
    const want = parseConversationUrl(url);
    if (!want) return false;

    try {
      if (!sameConversationUrl(p.url(), want)) {
        if (chatgptProjectId(want)) {
          if (chatgptProjectId(want) !== chatgptProjectId(this.cfg.chatgptProjectUrl ?? '')) return false;
          await this.startNewChat();
          const id = new URL(want).pathname.split('/c/')[1];
          // 개편 사이드바는 프로젝트 아래에도 같은 대화 링크를 둔다 — 접혀 숨은 쪽을 집지 않는다.
          const link = p.locator(`a[href$="/c/${id}"]:visible`).first();
          // ponytail: 최근 200개까지 탐색. 더 오래된 대화는 새 대화로 회전한다.
          for (let i = 0; i < 10 && !(await link.isVisible()); i++) {
            // 개편 화면은 프로젝트 홈 목록의 "Show more" 다. 사이드바·긴 질문에도 같은 이름이 있어 본문 것만 쓴다.
            const more = p.getByRole('button', { name: /^(Load more conversations|더 많은 대화 불러오기)$/i })
              .or(p.locator('main').getByRole('button', { name: /^Show more$/i })).first();
            if (!(await more.isVisible())) break;
            const before = await p.locator('a[href*="/c/"]').count();
            await more.press('Enter');
            await p.waitForFunction(n => document.querySelectorAll('a[href*="/c/"]').length > n, before, { timeout: 10_000 });
          }
          if (!(await link.isVisible())) return false;
          await link.press('Enter');
          await p.waitForURL(u => sameConversationUrl(u.href, want), { timeout: 15_000 });
        } else {
          await p.goto(want, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        }
      }
      await p.waitForSelector(this.cfg.selectors.textInput, { timeout: 15_000 });
    } catch {
      return false;
    }
    await p.keyboard.press('Escape').catch(() => {});
    await p.waitForTimeout(1_000);

    // 접근 불가 시 루트나 다른 대화로 튕긴다
    if (!sameConversationUrl(p.url(), want)) return false;
    if (this.cfg.chatgptProjectUrl && chatgptProjectId(p.url()) !== chatgptProjectId(this.cfg.chatgptProjectUrl)) return false;

    const body = await p
      .locator('body')
      .innerText()
      .catch(() => '');
    if (CONVERSATION_GONE_PATTERNS.some((re) => re.test(body))) return false;

    // 이전 라운드의 응답이 하나도 안 보이면 본문 로드에 실패한 것이다.
    // 그대로 진행하면 sendAndCollect 가 기존 메시지를 새 응답으로 오인한다.
    //
    // 다만 **응답이 오기 전에 죽은 대화**는 어시스턴트 메시지가 하나도 없는 게
    // 정상이다. 그걸 실패로 보면 대화를 놓아버리고 같은 질문을 새 창에 다시 보내게
    // 된다 — 이 검사가 막으려던 것보다 나쁜 결과다. 재전송하지 않는 경로
    // (findRound 로 확인만 하는 복구)에서는 이 검사를 건너뛴다.
    if (opts.requireAssistant === false) return true;
    try {
      await p
        .locator(this.cfg.selectors.assistantMessage)
        .first()
        .waitFor({ state: 'attached', timeout: 15_000 });
    } catch {
      return false;
    }
    return true;
  }

  /** 현재 페이지가 대화 화면이면 그 URL, 아니면 null. */
  currentConversationUrl(): string | null {
    return parseConversationUrl(this.requirePage().url());
  }

  /**
   * 프롬프트를 전송하고 응답 전문을 반환한다.
   *
   * 1. 붙여넣기로 입력하고 전체 내용을 검증
   * 2. 전송 버튼 클릭
   * 3. 서버 기록에서 이번 질문의 끝난 답을 받는다
   *
   * `onSent` 의 `askedBefore` 는 보내기 전 서버 기록의 마지막 질문 id 다 — 회수(`collectFrom`)에 그대로 넘긴다.
   */
  async sendAndCollect(
    prompt: string,
    onSent?: (conversationUrl: string | null, reasoning: string, askedBefore: string | null) => void,
    attachment?: PromptAttachment,
  ): Promise<string> {
    const p = this.requirePage();

    // ── 진행 중인 생성이 끝나기를 기다린다 ──
    // 생성 중에 프롬프트를 넣으면 전송 버튼 자리가 **중지 버튼**이라 진행 중인
    // 응답을 끊는다 (ChatGPT 가 중단 여부를 되묻는다). 우리 쪽에서 라운드를 실패로
    // 접었어도 브라우저는 아직 답을 만들고 있을 수 있으므로 — 실제로 그렇게
    // 사고가 났다 — 보내기 전에 반드시 확인한다.
    await this.waitUntilIdle(p);

    // ── 직전 질문의 식별자 기록 (전송 확인의 기준) ──
    // 이어가는 대화에서는 지난 턴들이 순차적으로 렌더링되므로, 화면이 멎기 전에 세면
    // 실제보다 작게 잡혀 아직 보내지 않은 질문을 "보냈다" 로 볼 수 있다. 멎을 때까지 기다린다.
    await this.countSettledMessages(p);
    const lastUserBefore = await this.lastUserMessageId(p);
    const beforeUserCount = await this.countUserMessages(p);
    const askedBefore = await this.serverLastQuestion(p);

    // ── 프롬프트 입력 ──
    this.assertProjectPage(p);
    const input = p.locator(this.cfg.selectors.textInput).first();
    const composer = input.locator('xpath=ancestor::form[1]');
    if (((await input.innerText()).trim() || await composer.getByRole('button', { name: REMOVE_FILE_BUTTON }).count())
      && !(await this.clearOwnDraft(input))) {
      throw new Error('입력창에 작성 중인 내용 또는 첨부가 있습니다 — 기존 초안을 보존합니다.');
    }
    const reasoning = await this.inputStep('추론 강도 최대', () => this.maximizeReasoning(p, composer).catch((cause) => {
      throw new Error(`추론 강도를 최대로 맞추지 못했습니다 — 전송하지 않습니다: ${String(cause?.message ?? cause).split('\n')[0]}`, { cause });
    }), false);
    console.log(chalk.dim(`  추론: ${reasoning}`));
    try {
      if (attachment) {
        await this.inputStep(`고정 diff 첨부 (${attachment.buffer.length}바이트)`, async () => {
          // 메뉴를 거치지 않고 현재 composer 의 일반 파일 입력(accept 없음)에 직접 넣는다.
          // 첨부 메뉴는 개편 때 이름과 구조가 바뀌었고(#composer-plus-btn → "Add files and more"),
          // 옆에는 이미지 전용 입력도 있다.
          await composer.locator('input[type="file"]:not([accept])').first()
            .setInputFiles({ ...attachment, mimeType: 'text/plain' });
          // 파일 이름이 나타나는 것만으로 업로드 성공은 아니다 — 완료된 카드와 진행 막대가 사라진 것까지 본다.
          try {
            await uploadedCard(composer, attachment.name).waitFor({ state: 'visible', timeout: 120_000 });
            await composer.getByRole('progressbar', { name: `Uploading ${attachment.name}`, exact: true })
              .waitFor({ state: 'detached', timeout: 30_000 });
          } catch (cause) {
            const files = await composer.locator('[role="group"], [role="progressbar"], button[aria-label^="Remove "]')
              .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') || e.textContent || '')).catch(() => []);
            throw new Error(`고정 diff 첨부 완료를 확인하지 못했습니다: ${files.join(' / ').slice(0, 160) || '첨부 카드 없음'}`, { cause });
          }
        });
      }
      await this.inputStep(`프롬프트 입력 (${prompt.length}자, ${prompt.split('\n').length}줄)`, () => this.fillPrompt(p, prompt), false);
      if (attachment) await uploadedCard(composer, attachment.name).waitFor({ state: 'visible', timeout: 3_000 });

      // 이번 라운드의 생성만 근거로 쓴다.
      this.sawGeneration = false;
      this.assertProjectPage(p);
      await this.inputStep('전송 버튼', () => this.clickSend(p));
      if (!(await this.inputStep('전송 확인', () => this.verifyPromptSent(p, input, lastUserBefore, beforeUserCount)))) {
        throw new Error('프롬프트가 전송되지 않았습니다 — 입력창·전송 버튼 상태를 확인하세요');
      }
    } catch (error) {
      // 입력 검증뿐 아니라 업로드·클릭·전송 확인 실패도 정리한다. 프로젝트 초안은
      // 탭 사이에 공유되므로 남기면 다른 PR까지 막힌다. 전송/사용자 편집 흔적이 있으면 보존한다.
      try {
        if (!(await this.isStreaming(p)) && await this.lastUserMessageId(p) === lastUserBefore
          && await this.countUserMessages(p) === beforeUserCount) {
          // 붙이다 만 앞부분도 우리 것이다 — 예전엔 전체와 같을 때만 지워 잔해가 남았다.
          await this.clearOwnDraft(input, prompt, attachment?.name);
        }
      } catch { console.log(chalk.yellow('  ⚠ 미전송 초안을 정리하지 못했습니다 — 프로젝트 입력창을 확인하세요.')); }
      throw error;
    }
    progress.stream('질문 전송 확인됨', 0);

    // ── 대화 주소 확보 ──
    // **응답을 기다리기 전에** 알린다. 대기 구간이 2~15분이라 그 사이에 프로세스가
    // 죽으면, 여기서 안 남겨둔 URL 은 영영 잃는다. 그러면 다음 라운드가 대화가 없는
    // 줄 알고 새 창을 열어 **같은 질문을 다시 보낸다** (대화 한도를 그냥 버린다).
    if (onSent) onSent(await this.waitForConversationUrl(p), reasoning, askedBefore);

    // ── 응답 수집 (서버 기록) ──
    return this.collectResponse(p, this.cfg.responseTimeoutMs, { askedBefore });
  }

  /** 화면에 그려져 있는 질문들 (역할·식별자만 — 본문은 크므로 읽지 않는다). */
  private async userMessages(page: Page): Promise<MessageRef[]> {
    const msgs = await page.evaluate(readMessagesInPage, null);
    return msgs.filter((m) => m.role === 'user');
  }

  /** 화면에 그려져 있는 마지막 질문의 식별자 (없으면 null). */
  private async lastUserMessageId(page: Page): Promise<string | null> {
    try {
      return (await this.userMessages(page)).at(-1)?.id ?? null;
    } catch {
      return null;
    }
  }

  private async countUserMessages(page: Page): Promise<number> {
    try {
      return (await this.userMessages(page)).length;
    } catch {
      return 0;
    }
  }

  /**
   * 프롬프트가 실제로 전송됐는지 — 우리 질문 노드가 화면에 새로 그려졌는지 본다.
   *
   * `data-message-id`가 있는 user 노드면 ID 뒤에 새 노드가 붙었는지로 판정하고,
   * ID가 없는 노드(ID 없는 대화 상태)나 ID를 찾지 못한 경우엔 전송 전 user
   * 메시지 개수보다 늘어났는지로 판정한다. ID만 보고 "새 대화"로 오인하면
   * 기존 user 노드가 그대로 존재해도 전송 성공으로 착각해 직전 라운드 응답을
   * 현재 라운드 응답으로 고정할 수 있다.
   *
   * 질문 노드로 못 가르면 **입력창이 비었고** 직전 질문이 떼어졌거나 생성이 시작됐는지로
   * 본다 (`judgePromptSent`). "안 보냈다" 로 틀리면 전송 기록(`onSent`)이 없어 재시도가
   * 같은 질문을 또 보낸다 — osk-system#162 는 같은 2차 질문이 4번 들어갔다.
   */
  private async verifyPromptSent(
    page: Page,
    input: Locator,
    lastUserIdBefore: string | null,
    beforeCount: number,
  ): Promise<boolean> {
    const cleared = () => input.evaluate(readComposerInPage, undefined, { timeout: 3_000 })
      .then((text) => !composerText(text).trim(), () => false);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const seen = await this.userMessages(page)
        .then((users) => judgePromptSent(users, lastUserIdBefore, beforeCount))
        .catch(() => 'pending' as const);
      if (seen === 'sent') return true;
      if ((seen === 'detached' || await this.isStreaming(page)) && await cleared()) return true;
      await page.waitForTimeout(500);
    }
    return false;
  }

  /**
   * 이 대화에 그 라운드 질문이 이미 있는지 본다.
   *
   * 있으면 응답 수집의 기준점(그 질문 직전까지의 어시스턴트 메시지 수)을 돌려준다.
   * 판별 실패는 전부 null 로 떨어뜨린다 — 잘못 "있다" 고 보면 엉뚱한 응답을
   * 게시하게 되고, 그건 다시 묻는 것보다 훨씬 나쁘다.
   */
  async findRound(
    marker: string, requireResponse = false, acceptFollowup?: (raw: string) => boolean,
  ): Promise<number | null> {
    const p = this.requirePage();
    await this.countSettledMessages(p); // 렌더가 멎을 때까지 기다린다

    // selectors.assistantMessage 를 일반화한 형태다 — 역할별로 나눠 읽어야
    // "그 질문이 마지막인가" 를 판정할 수 있다.
    try {
      const msgs = await p.evaluate(readMessagesInPage, this.cfg.selectors.messageContent);
      // 생성 중이면 완성될 때까지 수집한다. 완성본의 형식·SHA 검증은 게시 경로에도 있다.
      const generating = await this.isStreaming(p) && this.stallEvidence(true) === 'generating';
      return findRoundBaseline(msgs, marker, requireResponse && !generating,
        acceptFollowup ? raw => generating || acceptFollowup(raw) : undefined);
    } catch {
      return null;
    }
  }

  /**
   * 이미 보낸 프롬프트의 응답을 받는다 (재전송 없이 · 서버 기록). 이미 와 있으면 첫 조회에서,
   * 생성 중이면 끝까지 기다린다. `asked` 는 그 전송의 기준이다 (`pendingSend.askedBefore` · 구버전은 `at`).
   */
  async collectFrom(timeoutMs = this.cfg.responseTimeoutMs, asked: AskedAfter = {}): Promise<string> {
    return this.collectResponse(this.requirePage(), timeoutMs, asked);
  }

  /**
   * 보내기 전 서버 기록의 마지막 질문 id — 답을 받을 때 이번 질문을 가르는 기준이다 (`judgeServerAnswer`).
   * 새 대화(프로젝트 화면)면 null 이다. 이어 쓰는 대화의 기록을 못 읽으면 **보내지 않는다** — 기준 없이
   * 보내면 직전 답을 이번 답으로 받을 수 있고, 어차피 답도 서버 기록에서만 받으므로 한도만 쓴다.
   */
  private async serverLastQuestion(page: Page): Promise<string | null> {
    if (!parseConversationUrl(page.url())) return null;
    const conv = await this.serverConversation(page);
    if (!conv) throw new Error(`서버 기록을 읽지 못해 보내지 않습니다 — 이번 답을 직전 답과 가를 기준이 없습니다 (대화 ${page.url()})`);
    return lastExchange(conv).questionId;
  }

  /**
   * 전송 직후 대화 주소가 확정될 때까지 짧게 기다린다.
   *
   * 새 대화는 첫 메시지를 보낸 뒤에야 /c/<uuid> 로 바뀐다. 이어가는 대화면 이미
   * 그 주소이므로 즉시 돌아온다.
   */
  private async waitForConversationUrl(page: Page): Promise<string | null> {
    const deadline = Date.now() + CONVERSATION_URL_TIMEOUT_MS;
    for (;;) {
      const url = parseConversationUrl(page.url());
      if (url) return url;
      if (Date.now() >= deadline) return null;
      await page.waitForTimeout(500);
    }
  }

  // ── 내부 헬퍼 ─────────────────────────────────────────────

  private requirePage(): Page {
    if (!this.page) throw new Error('Browser not launched — call launch() first');
    return this.page;
  }

  /**
   * 어시스턴트 메시지 개수가 더 늘지 않을 때까지 기다렸다가 그 값을 반환한다.
   *
   * 한 번 같았다고 끝내면 안 된다. 복귀가 느린 대화에서는 과거 응답 1건만 뜬 채로
   * 잠시 멎었다가 나머지가 뒤늦게 붙는데, 그 사이에 개수를 확정하면 늦게 도착한
   * **과거 응답을 새 응답의 시작으로 오인**한다. 연속으로 여러 번 같아야 확정한다.
   * 새 대화(0건)에서도 판정은 거치지만 몇 초짜리라 라운드 시간에 비해 무시할 수준.
   */
  private async countSettledMessages(page: Page): Promise<number> {
    const loc = page.locator(this.cfg.selectors.assistantMessage);
    const deadline = Date.now() + SETTLE_MAX_MS;
    let last = -1;
    let stable = 0;

    while (Date.now() < deadline) {
      const cur = await loc.count().catch(() => last);
      stable = cur === last ? stable + 1 : 0;
      last = cur;
      if (stable >= SETTLE_STABLE_READS) return cur;
      await page.waitForTimeout(SETTLE_POLL_MS);
    }

    // 계속 늘어나는 중 — 마지막 관측값으로 진행하되 조용히 넘어가지는 않는다
    console.log(
      chalk.yellow(`  ⚠ 기존 메시지 수가 안정되지 않았습니다 — ${last}건 기준으로 진행합니다.`),
    );
    return last;
  }

  /**
   * **화면 크롬 텍스트** 끝부분 — 대화 메시지를 뺀, 지금 보이는 UI 글자만.
   *
   * 화면 안내(쿼터 한도·연결 중단)를 찾는 모든 판정이 이걸 쓴다. `body.innerText`
   * 를 그대로 쓰면 안 된다 — 거기에는 **어시스턴트가 쓴 리뷰 본문과 우리가 보낸
   * PR diff** 가 같이 들어 있어서, 안내 문구와 대화 내용을 구분할 수단이 없다.
   * 대화 내용은 새로고침해도 남으므로 한 번 오탐이 나면 영구 고착이 된다.
   *
   * 쿼터 감지가 먼저 이 방식으로 고쳐졌는데 연결 중단 감지에는 반영되지 않아
   * 같은 사고가 그쪽에서 재발했다. 그래서 수집을 하나로 합친다 — 갈라져 있으면
   * 다음 판정이 또 `body.innerText` 로 시작한다.
   */
  private async uiTextTail(page: Page): Promise<string> {
    return page
      .evaluate(() => {
        try {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let out = '';
          let node: Text | null;
          while ((node = walker.nextNode() as Text | null)) {
            const raw = node.nodeValue;
            if (!raw || !raw.trim()) continue;
            const el = node.parentElement as HTMLElement | null;
            if (!el) continue;
            // 옛 화면의 메시지 노드와 개편 화면의 질문·답 단위·본문 — 빠뜨리면 리뷰 본문이 안내로 읽힌다.
            if (el.closest('[data-message-author-role], [data-chatgpt-search-unit-key], [data-user-message-bubble], [data-chatgpt-selection-message-id]')) continue;
            if (el.closest('script, style, noscript, template')) continue;
            // 조상까지 포함해 실제 표시 여부를 판정한다 — 직접 부모는 보여도
            // 상위 패널이 display:none/visibility:hidden/opacity:0이면 숨김이고,
            // getComputedStyle(el)만 보면 이 경우를 놓쳐 숨김 한도 문구를 수집한다.
            let hidden = false;
            for (let cur: HTMLElement | null = el; cur && cur !== document.body; cur = cur.parentElement) {
              if (cur.hasAttribute('hidden')) { hidden = true; break; }
              try {
                const cs = window.getComputedStyle(cur);
                if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') {
                  hidden = true;
                  break;
                }
              } catch {
                /* getComputedStyle 실패 시 보이는 것으로 간주 */
              }
            }
            if (hidden) continue;
            out += raw + ' ';
            if (out.length > 5000) break;
          }
          return out.slice(-4000);
        } catch {
          return (document.body.innerText ?? '').slice(-4000);
        }
      })
      .catch(() => '');
  }

  /** 화면 크롬 텍스트에서 쿼터 한도 안내를 탐지한다 (없으면 null). */
  private async detectQuotaLimit(page: Page): Promise<string | null> {
    const tail = await this.uiTextTail(page);
    for (const re of QUOTA_PATTERNS) {
      const m = tail.match(re);
      if (m) return m[0];
    }
    return null;
  }

  /** 타임아웃으로 입력을 겹쳐 실행하지 않는다. 느린 호출은 경고만 남긴다. */
  /**
   * 추론 강도를 최대로 올리고 표기용 이름을 돌려준다 (예: "Latest · Pro (5/5)").
   *
   * 개편 화면의 기본값은 추론 없는 Instant 였다 — 개편 뒤 51,012자 diff 가 20초 만에
   * approve 로 게시됐다 (개편 전 150~1,084초). 모델은 대화마다 기억돼 이어 쓰는 대화는
   * 만든 때의 설정으로 돌아가므로 **전송마다** 맞춘다. 못 맞추면 호출부가 보내지 않는다.
   */
  private async maximizeReasoning(p: Page, composer: Locator): Promise<string> {
    await composer.getByRole('button', { name: 'Select ChatGPT model', exact: true }).click({ timeout: 10_000 });
    const menu = p.locator('[role="menu"][data-state="open"]').filter({ has: p.locator('[data-reasoning-slider]') });
    try {
      const power = menu.locator('[data-reasoning-slider]');
      const slider = menu.locator('[role="slider"]');
      await power.focus({ timeout: 5_000 });
      const value = async (attr: string) => Number(await slider.getAttribute(attr, { timeout: 5_000 }));
      const max = await value('aria-valuemax');
      for (let step = 0; step <= max; step++) {
        const now = await value('aria-valuenow');
        if (now >= max) break;
        await p.keyboard.press('ArrowRight');
        for (let t = 0; t < 20 && await value('aria-valuenow') === now; t++) await p.waitForTimeout(100);
      }
      const now = await value('aria-valuenow');
      if (!(max > 0) || now !== max) throw new Error(`슬라이더 ${now}/${max}`);
      const [desc] = await power.evaluate((el) => (el.getAttribute('aria-describedby') ?? '').split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? ''));
      const level = /^(.+?), (\d+) of (\d+)/.exec(desc ?? '');
      const checked = menu.locator('[role="menuitemradio"][aria-checked="true"]');
      const model = (await checked.count()) ? (await checked.first().textContent())?.trim() : '';
      const label = level ? `${level[1]} (${level[2]}/${level[3]})` : `${now + 1}/${max + 1}`;
      return model ? `${model} · ${label}` : label;
    } finally {
      if (await menu.count()) await p.keyboard.press('Escape');
    }
  }

  /**
   * 입력창의 잔해가 우리 것이면(`isOwnDraft`) 글과 첨부를 지우고 true. 아니면 건드리지 않고 false.
   * 다 지웠는지 다시 읽어 확인한다 — 못 지웠으면 false 라 호출부의 가드가 그대로 멈춘다.
   */
  async clearOwnDraft(input: Locator, prompt?: string, ownFile?: string): Promise<boolean> {
    const composer = input.locator('xpath=ancestor::form[1]');
    const removes = composer.getByRole('button', { name: REMOVE_FILE_BUTTON });
    const read = async () => ({
      text: composerText(await input.evaluate(readComposerInPage, undefined, { timeout: 10_000 })).trim(),
      files: await removes.evaluateAll((els) => els.map((b) =>
        b.closest('[role="group"]')?.getAttribute('aria-label') || (b.getAttribute('aria-label') ?? '').replace(/^Remove /, ''))),
    });
    const before = await read();
    if (!isOwnDraft(before.text, before.files, this.cfg.promptTemplate, prompt, ownFile)) return false;
    if (!before.text && before.files.length === 0) return true;
    console.log(chalk.yellow(`  ⚠ 실패한 입력이 남긴 리뷰 프롬프트를 지웁니다 (${before.text.length}자 · 첨부 ${before.files.length}개)`));
    for (let i = 0; i < 10 && await removes.count(); i++) {
      const remove = removes.first();
      await remove.locator('xpath=ancestor::*[@role="group"][1]').hover({ timeout: 2_000 }).catch(() => {});
      await remove.click({ timeout: 5_000 });
    }
    await input.fill('');
    const after = await read();
    return !after.text && after.files.length === 0;
  }

  private async inputStep<T>(label: string, action: () => Promise<T>, reportCompletion = true): Promise<T> {
    const since = Date.now();
    const timer = setTimeout(() => console.log(chalk.yellow(`  ⚠ ${label} 10초째 진행 중`)), 10_000);
    try {
      const result = await action();
      if (reportCompletion) console.log(chalk.dim(`  입력 단계 완료: ${label} (${Date.now() - since}ms)`));
      return result;
    } catch (e) {
      console.log(chalk.yellow(`  입력 단계 실패: ${label} (${Date.now() - since}ms)`));
      throw e;
    } finally { clearTimeout(timer); }
  }

  /**
   * 입력창에 포커스를 준다.
   *
   * 모달·오버레이·하이드레이션 지연으로 실제 클릭이 actionable 하지 않을 수 있으므로
   * (관측: locator.click 30초 타임아웃) 클릭이 실패하면 JS 포커스로 대체한다.
   */
  private async focusInput(page: Page): Promise<void> {
    const sel = this.cfg.selectors;
    const input = page.locator(sel.textInput).first();
    await input.waitFor({ state: 'visible', timeout: 20_000 });

    try {
      await input.click({ timeout: 10_000 });
      return;
    } catch {
      console.log(chalk.dim('  입력창 클릭 실패 — 모달 해제 후 JS 포커스로 대체'));
    }

    // 떠 있는 모달·팝오버를 닫아본다
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);

    try {
      await input.click({ timeout: 5_000 });
      return;
    } catch {
      /* JS 포커스로 진행 */
    }

    const focused = await input.evaluate((el) => {
      (el as HTMLElement).focus();
      return document.activeElement === el || el.contains(document.activeElement);
    });

    if (!focused) {
      throw new Error('프롬프트 입력창에 포커스할 수 없습니다 — 브라우저 화면 상태를 확인하세요');
    }
  }

  /** ProseMirror contenteditable 에 텍스트를 삽입한다. */
  private async fillPrompt(page: Page, text: string): Promise<void> {
    const since = Date.now();
    await this.inputStep('입력창 포커스', () => this.focusInput(page), false);
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');

    // ProseMirror의 paste 트랜잭션을 사용한다. 다중 줄 CDP insertText는
    // Chromium에서 줄마다 레이아웃을 재계산해 renderer를 수분간 붙잡을 수 있다.
    const input = page.locator(this.cfg.selectors.textInput).first();
    // ChatGPT는 한 번에 10,000자를 넘게 붙이면 첨부로 전환한다.
    // 코드 포인트 단위로 나누어 surrogate pair도 보존한다.
    const chars = Array.from(text.replace(/\r\n/g, '\n'));
    const grew: number[] = [];
    for (let at = 0; at < chars.length; at += 4000) {
      await this.inputStep(`붙여넣기 ${grew.length + 1}/${Math.ceil(chars.length / 4000)}조각`, () => input.evaluate(
      (el, t: string) => {
        (el as HTMLElement).focus();
        const dt = new DataTransfer();
        // **text/plain 을 넣지 않는다.** ChatGPT 는 붙여넣은 평문에서 GitHub URL 을
        // 찾아 참조 칩(위젯)으로 바꾼다 — 본문의 URL 이 사라져 검증이 늘 실패했다.
        // 칩 전환은 text/plain 만 읽고, PM 은 text/html 이 있으면 그쪽을 쓴다.
        // PM의 plain-text paste는 연속 개행을 문단 하나로 합친다. 자체 clipboard
        // 형식으로 공백 보존을 요청하고, 개행은 hard break로 전달한다.
        const escaped = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        // 옛 입력창(PM)은 마지막 BR을 표시용으로 버리므로 실제 마지막 개행과 구분한다.
        // 개편 입력창은 그 BR을 줄바꿈으로 남긴다 — 붙이면 4000자 조각 경계마다 줄
        // 한가운데가 끊겨 diff 줄이 쪼개진다(실측). 그쪽에서는 붙이지 않는다.
        const tail = (el as HTMLElement).closest?.('form[data-chatgpt-composer]') ? '' : '<br>';
        dt.setData('text/html', `<p data-pm-slice="1 1 []">${escaped.replace(/\r?\n/g, '<br>')}${tail}</p>`);
        el.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
        );
      },
      chars.slice(at, at + 4000).join(''),
    ), false);
      // 조각마다 입력창이 실제로 얼마나 자랐는지 남긴다. 실패했을 때 원인을
      // 가르는 유일한 증거다 — 누적이 멈추면 재마운트·첨부 전환, 조각 길이보다
      // 조금씩 크면 경계마다 줄바꿈이 끼는 것이다.
      grew.push(await input.evaluate((el) => (el as HTMLElement).innerText.length));
    }
    // 처리된 paste는 preventDefault로 false를 반환할 수 있다. 이벤트 반환값이
    // 아니라 전체 본문을 비교한다. 부분 입력 위에 다른 입력 방법을 덧붙이지 않는다.
    const normalize = composerText;
    const matches = async () => normalize(await input.evaluate(readComposerInPage, undefined, { timeout: 3_000 })) === normalize(text);
    let matched = await this.inputStep('붙여넣기 검증', matches, false);
    if (!matched && (await input.innerText({ timeout: 3_000 })).length === 0 && text.length <= 4000 && text.split('\n').length <= 80) {
      await this.inputStep('짧은 입력 폴백', () => page.keyboard.insertText(text));
      matched = await matches();
    }
    if (matched) {
      console.log(chalk.dim(`  입력 완료: ${text.length}자 · ${text.split('\n').length}줄 · ${grew.length}조각 · 검증 통과 (${Date.now() - since}ms)`));
      return;
    }
    // 비우기 전에 무엇이 들어갔는지부터 읽는다 — 이게 원인을 가르는 증거다.
    const actual = normalize(await input.evaluate(readComposerInPage, undefined, { timeout: 3_000 }));
    const want = normalize(text);
    let diffAt = 0;
    while (diffAt < actual.length && diffAt < want.length && actual[diffAt] === want[diffAt]) diffAt++;
    // 실패한 입력의 잔해를 남기지 않는다. 남기면 다음 라운드의 프로젝트 진입
    // 가드가 그걸 사람이 쓰던 초안으로 보고 같은 PR 이 영원히 막힌다.
    try {
      await this.focusInput(page);
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
    } catch { /* 비우지 못해도 아래 오류가 먼저다 */ }
    const detail = `기대 ${want.length}자 · 실제 ${actual.length}자 · 첫 불일치 ${diffAt}`
      + ` (기대 ${JSON.stringify(want.slice(diffAt, diffAt + 40))} ↔ 실제 ${JSON.stringify(actual.slice(diffAt, diffAt + 40))})`
      + ` · 조각별 누적 ${grew.join('/')}`;
    throw new Error(`프롬프트 전체 내용이 일치하지 않습니다 — 재입력하거나 전송하지 않습니다. ${detail}`);
  }

  private async clickSend(page: Page): Promise<void> {
    // 후보 전체를 하나의 대기 예산으로 확인한다.
    const candidates = [...new Set([
      this.cfg.selectors.sendButton,
      '#composer-submit-button',
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="보내기"]',
    ])];
    // 동일 버튼을 셀렉터마다 다시 기다리지 않는다. 중지 버튼은 명시적으로 제외한다.
    const buttons = candidates.map(c => page.locator(c)).reduce((all, next) => all.or(next));
    const enabledSend = page.locator(':visible:not(:disabled):not([data-testid="stop-button"]):not([aria-label*="Stop"])');
    try {
      await buttons.and(enabledSend).first().click({ timeout: 10_000 });
    } catch (cause) {
      const button = buttons.and(page.locator(':visible')).first();
      const disabled = await button.isDisabled().catch(() => false);
      throw new Error(`전송 버튼 클릭 실패${disabled ? ' — ChatGPT가 전송을 비활성화했습니다 (입력 크기·첨부 처리 상태 확인)' : ''}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
  }

  /**
   * 응답을 받는다 — **서버 기록에서만** (`judgeServerAnswer`). 화면은 답의 출처가 아니다.
   *
   * 화면 수집은 증상이 매번 다른 사고를 냈다: 남의 노드를 읽어 7차의 답을 9차로 게시했고, 답 대신
   * "This response couldn’t load" 를 그렸고, 서버가 375~555초에 끝낸 답을 약 600초까지 그리지 않았고
   * (300초 넘는 라운드의 약 40%), 탭의 Playwright 호출이 멎어 루프 한 바퀴가 51분 걸렸다
   * (lolchess_base#137). 서버 기록에는 그 모든 경우에 답이 있었다.
   *
   * 그래서 탭과 무관한 타이머로 서버에 묻는다: 생성 중이면 기다리고, 이번 질문의 끝난 답이 기록에
   * 있으면 받는다. 탭이 멎어도 `serverJson` 이 잠깐 연 다른 탭으로 묻는다.
   *
   *  - 아무것도 오고 있지 않으면(서버 생성 중 아님 · 기록에 이번 답 없음 · 생성 요청 없음)
   *    `ENDED_QUIET_MS` 뒤에 `GenerationEndedError` — 한도 배너가 보이면 `QuotaLimitError`.
   *  - 서버 기록을 계속 못 읽으면 `SERVER_UNREAD_LIMIT_MS` 뒤에 실패한다 — 화면 글자로 대신하지 않는다.
   *  - 예산이 다 됐는데 서버가 생성 중이면 같은 예산을 더 준다 (`MAX_RESPONSE_EXTENSIONS`). 끝내 못 받으면
   *    `ResponseTimeoutError` — 기록에 끝난 답이 없으니 게시할 것도 없다 (잘린 답을 게시하지 않는다).
   *
   * @param asked 이번 질문을 가르는 기준 — 보내기 전 마지막 질문 id (`AskedAfter`).
   */
  private async collectResponse(page: Page, timeout: number, asked: AskedAfter): Promise<string> {
    // 여기서부터는 기다리기만 한다 — 차례를 넘겨 옆 탭이 진입·입력을 시작하게 한다.
    this.endTurn();
    progress.phase('waiting');
    console.log(chalk.dim('  응답 대기 중... (서버 기록)'));

    const t0 = Date.now();
    let deadline = t0 + timeout;
    let extensions = 0;
    let sawStreaming = false;
    let quietSince: number | null = null;
    let unreadSince: number | null = null;
    let lastQuotaCheckAt = t0;
    let lastLogAt = t0;
    let lastPhase = '';
    const span = (ms: number): string => ms < 60_000 ? `${Math.ceil(ms / 1000)}초` : `${Math.round(ms / 60_000)}분`;
    // 한도는 화면 배너로만 알 수 있다 — 답이 아니라 실패 신호라 화면을 본다 (멎은 탭에서도 제한 시간 안에).
    const quota = async (): Promise<void> => {
      const hit = await within(this.detectQuotaLimit(page).catch(() => null), SCREEN_PEEK_TIMEOUT_MS);
      if (hit && hit !== TIMED_OUT) throw new QuotaLimitError(`한도 감지: "${hit}"`);
    };

    // 첫 조회는 바로 한다 — 회수 경로에서는 답이 이미 와 있을 수 있다.
    for (let first = true; ; first = false) {
      if (!first) await this.nap(SERVER_POLL_MS);
      const status = await this.serverStreamStatus(page);
      const streaming = status === 'IS_STREAMING';
      if (streaming && !sawStreaming) console.log(chalk.dim('  서버: 생성 중 (stream_status) — 끝나면 기록에서 답을 읽습니다.'));
      sawStreaming ||= streaming;
      const conv = streaming ? null : await this.serverConversation(page);
      const verdict = judgeServerAnswer(conv, status, asked);
      if (verdict.kind === 'answer') {
        console.log(chalk.green(`  ✓ 응답 수신 완료 (서버 기록 · ${verdict.text.length.toLocaleString()}자 · ${span(Date.now() - t0)})`));
        return verdict.text;
      }
      const reason = verdict.kind === 'unknown' ? verdict.reason : '생성 중';

      // 기록을 못 읽는다 — 화면 글자로 대신하지 않는다. 한두 번의 일시 실패는 넘긴다.
      const unread = !streaming && conv === null;
      unreadSince = unread ? (unreadSince ?? Date.now()) : null;
      if (unreadSince !== null && Date.now() - unreadSince >= SERVER_UNREAD_LIMIT_MS) {
        throw new Error(`서버 기록을 ${span(Date.now() - unreadSince)}째 읽지 못합니다 — 화면의 답은 쓰지 않습니다 `
          + `(대화 ${page.url()}). 로그인·네트워크를 확인하세요.`);
      }

      // 아무것도 오고 있지 않다 — 서버가 생성 중이 아니고, 기록에 이번 답이 없고, 생성 요청도 없다.
      // ChatGPT 에서 중지·연결 끊김·한도가 이 모습이다.
      const quiet = !streaming && !unread && this.netInFlight === 0;
      quietSince = quiet ? (quietSince ?? Date.now()) : null;
      if (!streaming && Date.now() - lastQuotaCheckAt >= QUOTA_RECHECK_MS) {
        lastQuotaCheckAt = Date.now();
        await quota();
      }
      if (quietSince !== null && Date.now() - quietSince >= ENDED_QUIET_MS) {
        await quota();
        throw new GenerationEndedError(
          `생성이 답 없이 끝났습니다 — 서버가 생성 중이 아니고 기록에 이번 답이 없습니다 `
            + `(${reason} · 화면 "${await this.screenHint(page)}"). 다음 재시도에 응답을 다시 확인합니다.`,
        );
      }

      // 대시보드는 폴링마다, 터미널은 상태 전환 또는 2분마다 한 줄 — 2~15분 대기가 멈춘 건지 도는 건지 보인다.
      const phase = streaming ? '생성 중' : unread ? '서버 기록 조회 실패' : '답 확인 중';
      progress.stream(phase, 0);
      if (phase !== lastPhase || Date.now() - lastLogAt > 120_000) {
        lastLogAt = Date.now();
        lastPhase = phase;
        console.log(chalk.dim(`    …${Math.round((Date.now() - t0) / 1000)}초 경과 · ${phase}`));
      }

      if (Date.now() < deadline) continue;
      // 예산이 다 됐다 — 서버가 생성 중이라고 하면(또는 생성 요청이 살아 있으면) 같은 예산을 더 준다.
      if (extensions < MAX_RESPONSE_EXTENSIONS && (streaming || this.netInFlight > 0)) {
        extensions++;
        deadline += timeout;
        console.log(chalk.yellow(
          `  ⏳ ${span(Date.now() - t0)} 지났지만 생성이 아직 진행 중입니다 — ` +
            `${span(timeout)} 더 기다립니다 (연장 ${extensions}/${MAX_RESPONSE_EXTENSIONS}).`,
        ));
        continue;
      }
      await quota();
      console.log(chalk.dim(`  응답 타임아웃 진단 · 서버=${status ?? '조회 실패'} · 기록=${reason} · 생성 요청 ${this.netInFlight}건 · 화면 "${await this.screenHint(page)}"`));
      throw new ResponseTimeoutError(streaming
        ? `${span(deadline - t0)} 안에 응답이 끝나지 않았습니다 (서버가 아직 생성 중). 끝나지 않은 답은 게시하지 않습니다 — `
          + 'responseTimeoutMs 를 늘리거나 다음 라운드에서 다시 시도합니다.'
        : `${span(deadline - t0)} 동안 응답을 받지 못했습니다 (${reason}). `
          + '브라우저 창에서 ChatGPT 상태를 확인하거나 responseTimeoutMs 를 늘려보세요.');
    }
  }

  /**
   * 진행 중인 생성이 끝날 때까지 기다린다 (전송 직전 가드).
   *
   * 우리 라운드가 실패로 끝나도 브라우저의 생성은 계속된다. 그 위에 새 프롬프트를
   * 넣으면 **남의 답을 끊는다** — 대화 한도를 쓰고 만든 답을 버리는 셈이라, 기다려서
   * 라운드가 느려지는 것보다 훨씬 비싸다. 예산은 응답 대기와 같은 값을 쓴다.
   */
  private async waitUntilIdle(page: Page): Promise<void> {
    if (!(await this.isStreaming(page))) return;

    console.log(chalk.yellow('  ⚠ 이전 응답이 아직 생성 중입니다 — 끊지 않도록 기다립니다.'));
    progress.phase('waiting');
    const deadline = Date.now() + this.cfg.responseTimeoutMs;
    const since = Date.now();
    while (await this.isStreaming(page)) {
      // 여기도 버튼이 유일한 탈출 조건이라, 버튼이 DOM 에 남으면 예산을 통째로
      // 태우고 **다음 라운드까지** 못 보낸다 (#109 는 이 경로로 재발했다).
      // 남의 생성을 끊지 않는다는 목적은 그대로 두고, 생성 요청이 하나도 없는
      // 채로 오래 버티는 경우에만 고장으로 인정한다 — 진짜 생성 중이면
      // inFlight 가 1 이상이라 여기에 걸리지 않는다.
      if (
        judgeStuckButton({
          sawGeneration: this.sawGeneration,
          inFlight: this.netInFlight,
          quietMs: this.lastNetAt ? Date.now() - this.lastNetAt : Number.POSITIVE_INFINITY,
          idleMs: Date.now() - since,
        })
      ) {
        console.log(
          chalk.yellow('  ⚠ 중지 버튼만 남고 생성 요청이 없습니다 — 버튼 고장으로 보고 전송을 계속합니다.'),
        );
        return;
      }
      if (Date.now() > deadline) {
        throw new ResponseTimeoutError(
          '이전 응답이 계속 생성 중이라 전송을 보류했습니다 — 끊지 않기 위해 라운드를 넘깁니다.',
        );
      }
      await page.waitForTimeout(IDLE_POLL_MS);
    }
    console.log(chalk.dim('  이전 생성이 끝났습니다 — 전송을 계속합니다.'));
  }

  /** 정체 구간의 성격 (관측용 — 대기 판정에는 쓰지 않는다). */
  private stallEvidence(button: boolean): StallEvidence {
    return classifyStall({
      button,
      sawGeneration: this.sawGeneration,
      inFlight: this.netInFlight,
      quietMs: this.lastNetAt ? Date.now() - this.lastNetAt : Number.POSITIVE_INFINITY,
    });
  }

  /** 생성 중지 버튼이 있으면 아직 스트리밍 중. */
  private async isStreaming(page: Page): Promise<boolean> {
    try {
      return (await page.locator(this.cfg.selectors.stopButton).count()) > 0;
    } catch {
      return false;
    }
  }

  /**
   * 서버가 아는 이 대화의 응답 상태 — `IS_STREAMING` · `COMPLETE` (모르면 null).
   *
   * 비공개 엔드포인트라 셀렉터처럼 깨질 수 있다. 실패는 전부 null 이다 — 수집이 그 시간을 세어
   * `SERVER_UNREAD_LIMIT_MS` 에서 접는다. 토큰은 이 페이지 안에서만 쓴다.
   * 전송 직후의 임시 주소(/c/WEB:…)는 조회되지 않으므로 실제 id 일 때만 묻는다 (그동안은 null).
   */
  private async serverStreamStatus(page: Page): Promise<string | null> {
    const status = (await this.serverJson(page, '/stream_status', SERVER_STATUS_TIMEOUT_MS) as { status?: unknown } | null)?.status;
    return typeof status === 'string' ? status : null;
  }

  /** 서버가 아는 이 대화의 기록 (모르면 null). */
  private async serverConversation(page: Page): Promise<ServerConversation | null> {
    return await this.serverJson(page, '', SERVER_STATUS_TIMEOUT_MS * 3) as ServerConversation | null;
  }

  /**
   * 이 탭의 대화에 대한 비공개 API 응답 (`/backend-api/conversation/<id><suffix>` · 실패는 null).
   *
   * 탭이 시간 안에 답하지 않으면 **같은 로그인으로 가벼운 탭을 잠깐 열어** 묻는다 — 멎은 탭에서는
   * 페이지 안의 fetch 도 돌지 않는다. 그 탭은 더 쓰지 않는다 (`retirePage`).
   */
  private async serverJson(page: Page, suffix: string, ms: number): Promise<unknown> {
    let id: string | undefined;
    try { id = parseConversationUrl(page.url())?.split('/c/')[1]; } catch { return null; }
    if (!id) return null;
    const ask = (p: Page) => p.evaluate(fetchServerInPage, { path: `/backend-api/conversation/${id}${suffix}`, ms }).catch(() => null);
    // 늦게 깨어난 지난 라운드의 호출이 새 탭을 버리지 않게 — 판정은 이 드라이버의 **지금** 탭에만 한다.
    const current = page === this.page;
    if (!(current && this.pageRetired)) {
      const quick = await within(ask(page), ms + 5_000);
      if (quick !== TIMED_OUT) return quick;
      if (current) this.retirePage();
      console.log(chalk.yellow('  ⚠ 리뷰 탭이 응답하지 않습니다 — 서버 확인은 잠깐 연 다른 탭으로 하고, 이 탭은 라운드가 끝나면 버립니다.'));
    }
    // 임시 탭의 모든 단계도 시간 안에 끝낸다 — 브라우저 쪽 호출이 멎으면 서버 감시(와 그 안의 예산
    // 백스톱)가 같이 멎어 원래 장애로 돌아간다. 닫기는 기다리지 않는다 (그것도 멎을 수 있다).
    const probe: { page?: Page; done?: boolean } = {};
    const viaProbe = async (): Promise<unknown> => {
      const p = await page.context().newPage();
      if (probe.done) { void p.close().catch(() => {}); return null; }
      probe.page = p;
      await this.preparePage(p); // 헤드리스 UA 맞추기 — 안 하면 같은 프로필도 막힌다
      await p.goto(`${new URL(page.url()).origin}/api/auth/session`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      return ask(p);
    };
    try {
      const slow = await within(viaProbe().catch(() => null), ms + 45_000);
      return slow === TIMED_OUT ? null : slow;
    } finally {
      probe.done = true;
      void probe.page?.close().catch(() => {});
    }
  }

  /**
   * 화면 크롬(메시지 제외)의 끝부분 — 실패할 때 무엇이 떠 있었는지 남긴다.
   * 진단이 깨져도 오류 분류(타임아웃 등)가 바뀌면 안 되므로 던지지 않는다. 멎은 탭에서도 제한 시간 안에 돌아온다.
   */
  private async screenHint(page: Page): Promise<string> {
    const tail = await within(this.uiTextTail(page).catch(() => null), SCREEN_PEEK_TIMEOUT_MS);
    return typeof tail === 'string' ? tail.replace(/\s+/g, ' ').trim().slice(-200) : '(수집 실패)';
  }
}
