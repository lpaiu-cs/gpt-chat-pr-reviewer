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

/** 대화에서 읽어온 메시지 하나 (역할 + 본문). */
export interface ConversationMessage {
  role: string;
  text: string;
}

/**
 * 이 대화에서 그 라운드 질문이 **마지막 질문**인지 보고, 맞으면 그 질문 직전까지의
 * 어시스턴트 메시지 수를 돌려준다 (없으면 null).
 *
 * 이 숫자가 응답 수집의 기준점이다. 다시 세면 안 된다 — 대상 응답의 노드가 이미
 * 만들어져 스트리밍 중이면 그것까지 기준에 포함돼, 오지 않을 **그 다음** 메시지를
 * 60초 기다리다 실패한다.
 *
 * **마지막 질문일 때만** 인정한다. 뒤에 다른 질문이 이어져 있으면 "우리가 묻고
 * 기다리는 중" 이 아니라 이미 진행된 대화이므로, 어느 응답이 그 라운드 것인지
 * 단정할 수 없다. 그때는 null 을 돌려 평소 경로(다시 묻기)로 보낸다.
 */
export function findRoundBaseline(msgs: ConversationMessage[], marker: string): number | null {
  let lastUser = -1;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === 'user') lastUser = i;
  }
  if (lastUser < 0 || !msgs[lastUser].text.includes(marker)) return null;
  return msgs.slice(0, lastUser).filter((m) => m.role === 'assistant').length;
}

/**
 * **이번 질문의 답이 지금 화면 어디에 있는가** (순수 함수).
 *
 * 마지막 사용자 메시지 뒤에 오는 첫 어시스턴트 메시지가 그 질문의 답이다.
 * 전송 직전에 센 개수로 위치를 고정하면 안 된다 — 대화가 길어지면 ChatGPT 가
 * 화면 밖 메시지를 떼었다 붙였다 하므로, 전송 후 어시스턴트 노드 수가 줄면
 * 고정한 위치는 **아무 노드도 가리키지 않는다.** 실제로 그 상태로 15분을
 * "0자" 로 기다리다 타임아웃했고(#75 6차), 같은 대화를 다시 열어 위치를 다시
 * 계산한 복구 경로는 즉시 3,421자를 읽었다.
 *
 *   ready   답 노드가 있다 — id 로 고정하고, id 가 없으면 nth 로 읽는다
 *   pending 질문은 찾았고 답 노드가 아직 없다 — 기다린다 (여기서 위치로
 *           물러서면 직전 라운드의 답을 새 응답으로 오인한다)
 *   unknown 사용자 메시지를 못 찾았다 (셀렉터 커스터마이즈·조회 실패) —
 *           호출부가 종전의 전송 시점 기준으로 물러선다
 *
 * `nth` 는 **어시스턴트 메시지 중** 몇 번째인가다 (= 그 질문 직전까지의
 * 어시스턴트 수). 그래서 `findRoundBaseline` 과 같은 값이고, 그대로
 * `locator(assistantMessage).nth(...)` 에 넣을 수 있다.
 */
export interface MessageRef {
  role: string;
  id: string | null;
}

export type AnswerAnchor =
  | { status: 'ready'; id: string | null; userId: string | null; nth: number }
  | { status: 'pending'; userId: string | null; nth: number }
  | { status: 'unknown' };

/**
 * `afterUserId` 는 **전송 직전의 마지막 질문**이다. 앵커가 아직 그 질문을 가리키면
 * 우리 질문이 화면에 그려지기 전이라는 뜻이므로 `pending` 으로 돌린다.
 *
 * 이 가드가 없으면 전송 후 몇 초 동안 앵커가 **직전 라운드의 답**을 가리킨다.
 * 그 노드를 고정하면 (1) 그대로 남아 있을 때 낡은 응답을 새 응답으로 게시하고
 * (2) 화면이 갱신되며 떨어져 나갈 때 "노드가 사라졌다" 로 라운드를 버린다.
 * 실제 관측이 후자다 — 실패가 전부 전송 경로에서만 났고 회수 경로에서는 없었다.
 */
export function anchorAnswer(msgs: MessageRef[], afterUserId?: string | null): AnswerAnchor {
  let lastUser = -1;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === 'user') lastUser = i;
  }
  if (lastUser < 0) return { status: 'unknown' };

  const userId = msgs[lastUser].id;
  const nth = msgs.slice(0, lastUser).filter((m) => m.role === 'assistant').length;

  if (afterUserId && userId === afterUserId) return { status: 'pending', userId, nth };

  for (let i = lastUser + 1; i < msgs.length; i++) {
    if (msgs[i].role === 'assistant') return { status: 'ready', id: msgs[i].id, userId, nth };
  }
  return { status: 'pending', userId, nth };
}

/** 고정한 대상 — 답 노드의 식별자와, 그 답을 부른 질문. */
export interface BoundTarget {
  id: string;
  /** 그 답을 부른 질문의 식별자 (없으면 위치로 대조한다). */
  userId: string | null;
  /** 고정 당시의 앵커 위치. */
  nth: number;
}

export type RebindDecision =
  | { action: 'keep' }
  | { action: 'rebind'; id: string }
  /** 같은 질문의 답이 아직 화면에 없다 — 기다린다 (실패가 아니다). */
  | { action: 'wait' }
  | { action: 'hold'; reason: 'anchor-unknown' | 'turn-moved' };

/**
 * 고정한 노드가 안 보일 때 **같은 질문의 답으로 다시 고정할 수 있는지** 판정한다.
 *
 * ChatGPT 는 전송 직후 임시 식별자로 답 노드를 그린 뒤 서버 식별자가 오면 그
 * 노드를 갈아 끼운다. 고정을 소실로만 처리하면 정상 응답이 오는 중에 라운드를
 * 버린다 — 최근 여덟 라운드 중 넷이 그렇게 실패했다.
 *
 * 갈아타는 조건은 **질문이 같을 때뿐**이다. 답이 길어져 우리 질문이 화면 밖으로
 * 밀려나면 앵커가 직전 턴으로 물러설 수 있고, 그때 따라가면 낡은 응답을 새
 * 응답으로 게시한다 — 이 도구에서 가장 비싼 실패다. 판별이 안 서면 hold 로
 * 두고, 호출부가 유예 횟수만큼 기다렸다가 라운드를 접는다.
 */
export function judgeRebind(msgs: MessageRef[], bound: BoundTarget): RebindDecision {
  if (msgs.some((m) => m.id === bound.id)) return { action: 'keep' };

  const anchor = anchorAnswer(msgs);
  if (anchor.status === 'unknown') return { action: 'hold', reason: 'anchor-unknown' };

  // 질문 식별자가 있으면 그것이 가장 확실하다. 없을 때만 위치로 대조한다 —
  // 뒤로 물러선 앵커는 언제나 더 작은 nth 를 내므로 오탐 방향이 안전하다.
  const sameTurn = bound.userId ? anchor.userId === bound.userId : anchor.nth === bound.nth;
  if (!sameTurn) return { action: 'hold', reason: 'turn-moved' };

  // **우리 질문이 여전히 마지막인데 답만 없다 — 기다리는 상태다.**
  // 추론 중에는 답 노드가 그려졌다 지워졌다 한다. 고정 전에는 이것을 정상
  // 대기로 보면서 고정 후에만 소실로 보면, 같은 화면을 두고 판정이 갈린다.
  // 실제로 그래서 18차가 실패했다 — 재시도(회수 경로)는 같은 화면에서 그냥
  // 기다려 성공했다. 답이 끝내 안 나오면 응답 예산이 정확한 실패를 낸다.
  if (anchor.status === 'pending' || !anchor.id) return { action: 'wait' };

  return { action: 'rebind', id: anchor.id };
}

/** 전송 후 대화 주소(/c/<uuid>)가 확정되기를 기다리는 최대 시간. */
const CONVERSATION_URL_TIMEOUT_MS = 15_000;

/** 스트림이 끊겼을 때 ChatGPT 가 표시하는 안내 문구. */
const INTERRUPT_PATTERNS: RegExp[] = [
  /connection interrupted/i,
  /waiting for the complete answer/i,
  /연결이 (중단|끊)/,
  /완전한 (답변|응답)을 기다/,
];

/** 연결 중단 시 새로고침으로 복구를 시도할 최대 횟수. */
const MAX_RELOAD_RECOVERIES = 3;

/** 응답이 시작도 안 한 채 조용할 때 한도를 다시 확인하는 주기. */
const QUOTA_RECHECK_MS = 30_000;

/** 전송 전, 진행 중인 생성이 끝나기를 기다리는 폴링 간격. */
const IDLE_POLL_MS = 3_000;

/**
 * 어시스턴트 메시지의 **안정적 식별자**.
 *
 * 위치(`nth`)로 붙잡으면 DOM 재렌더·가상화 때 다른 메시지를 가리킬 수 있다 —
 * 9차 라운드가 7차 응답을 게시한 경로가 그것이다. 노드가 뜨는 즉시 이 값으로
 * 고정해 이후 읽기가 항상 같은 메시지를 향하게 한다.
 */
const MESSAGE_ID_ATTR = 'data-message-id';

/** 식별자를 못 잡았을 때, 축소 관측을 이만큼 연속으로 보면 수집 실패로 본다. */
const SHRINK_TOLERANCE = 3;

/** 고정한 노드가 이만큼 연속으로 안 보이면 화면이 갈린 것으로 본다 (가상화 유예). */
const MISS_TOLERANCE = 3;

/** 앵커를 이만큼 연속으로 못 잡으면 전송 시점 위치로 물러선다. */
const UNKNOWN_TOLERANCE = 3;

/**
 * 생성 네트워크가 이만큼 조용하면 (a) 스트림 사망 **후보**로 기록한다.
 *
 * 판정이 아니라 관측이다. 무트래픽 시간은 종료의 적극적 근거가 못 된다 —
 * 생성 POST 가 먼저 끝나고 결과가 비동기로 오는 구조라면, 서버가 오래 추론하는
 * 동안 조용한 게 정상이다. 여기서 종료로 승격하면 부분 응답을 완성본으로
 * 게시하게 되고, 그건 이슈 #1 이 애초에 경계한 조기 절단이다.
 */
const STREAM_QUIET_LIMIT_MS = 180_000;

/** 화면이 멎었을 때 진단 덤프를 남기는 주기 (같은 라운드 안에서). */
const STALL_DUMP_EVERY_MS = 120_000;

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
  /** 화면이 멈춰 있는 시간 (수집: 텍스트 불변 · 대기: 기다린 시간) */
  idleMs: number;
}

/**
 * 중지 버튼이 **어떤 살아 있는 생성에도 받침되지 않는가** — 순수 함수.
 *
 * `collectResponse` 와 `waitUntilIdle` 이 **같은 조건**을 쓴다. 둘 다 버튼 하나를
 * 유일한 권위로 삼다가, 버튼이 DOM 에 남는 순간 예산을 통째로 태운다.
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

/** 기존 메시지 렌더링이 끝났다고 인정할 연속 동일 관측 횟수·간격·최대 대기. */
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

/** 화면 텍스트에서 쿼터/한도 안내를 감지하기 위한 패턴. */
const QUOTA_PATTERNS: RegExp[] = [
  /reached (?:your|the)[^.]{0,40}limit/i,
  /message (?:cap|limit)/i,
  /usage cap/i,
  /too many (?:requests|messages)/i,
  /try again (?:later|in|after)/i,
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

  // ── 생성 네트워크 관측 (이슈 #1) ──
  /** 생성 요청을 한 번이라도 봤는가 = 추적이 동작하는가 */
  private sawGeneration = false;
  /** 진행 중인 생성 요청 수 */
  private netInFlight = 0;
  /** 마지막으로 생성 네트워크가 움직인 시각 */
  private lastNetAt = 0;

  constructor(config: AppConfig) {
    this.cfg = config;
  }

  // ── 라이프사이클 ──────────────────────────────────────────

  async launch(): Promise<void> {
    this.ctx = await chromium.launchPersistentContext(this.cfg.browserProfileDir, {
      channel: this.cfg.browserChannel as any,
      headless: this.cfg.headless,
      viewport: { width: 1280, height: 900 },
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
    this.page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
    this.trackGenerationTraffic(this.page);
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
   * @returns 되살렸으면 true (살아 있었으면 false)
   */
  async ensureAlive(): Promise<boolean> {
    const ctxAlive = this.ctx !== null && (this.ctx.browser()?.isConnected() ?? true);
    const pageAlive = this.page !== null && !this.page.isClosed();
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
      console.log(chalk.yellow('  ⚠ 탭이 닫혔 있습니다 — 같은 브라우저에 탭만 다시 엽니다.'));
      this.page = await this.ctx.newPage();
      this.trackGenerationTraffic(this.page);
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
  private trackGenerationTraffic(page: Page): void {
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
    await this.ensureAlive();
    const ctx = this.ctx;
    if (!ctx) throw new Error('Browser not launched — call launch() first');
    const child = new ChatGPTDriver(this.cfg);
    child.ctx = ctx;
    child.owned = false;
    child.page = await ctx.newPage();
    child.trackGenerationTraffic(child.page);
    return child;
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
  async getSessionUser(): Promise<{ email?: string; name?: string } | null> {
    const p = this.requirePage();
    if (!this.isOnChatGPT(p)) return null;
    try {
      return await p.evaluate(async () => {
        const r = await fetch('/api/auth/session', { credentials: 'include' });
        if (!r.ok) return null;
        const j = (await r.json().catch(() => null)) as any;
        if (!j?.user) return null;
        return { email: j.user.email, name: j.user.name };
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

  /** 새 대화 시작 (chatgpt.com 루트로 이동). */
  async startNewChat(): Promise<void> {
    const p = this.requirePage();
    await p.goto(this.cfg.chatgptUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await p.waitForSelector(this.cfg.selectors.textInput, { timeout: 15_000 });
    // 새 대화 진입 시 뜨는 안내 모달을 닫고, 하이드레이션이 끝날 여유를 준다
    await p.keyboard.press('Escape').catch(() => {});
    await p.waitForTimeout(1_000);
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
      await p.goto(want, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await p.waitForSelector(this.cfg.selectors.textInput, { timeout: 15_000 });
    } catch {
      return false;
    }
    await p.keyboard.press('Escape').catch(() => {});
    await p.waitForTimeout(1_000);

    // 접근 불가 시 루트나 다른 대화로 튕긴다
    if (parseConversationUrl(p.url()) !== want) return false;

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
   * 1. 텍스트를 입력 (클립보드 paste → 실패 시 keyboard.type fallback)
   * 2. 전송 버튼 클릭
   * 3. 어시스턴트 메시지가 안정될 때까지 폴링
   */
  async sendAndCollect(
    prompt: string,
    onSent?: (conversationUrl: string | null) => void,
  ): Promise<string> {
    const p = this.requirePage();

    // ── 진행 중인 생성이 끝나기를 기다린다 ──
    // 생성 중에 프롬프트를 넣으면 전송 버튼 자리가 **중지 버튼**이라 진행 중인
    // 응답을 끊는다 (ChatGPT 가 중단 여부를 되묻는다). 우리 쪽에서 라운드를 실패로
    // 접었어도 브라우저는 아직 답을 만들고 있을 수 있으므로 — 실제로 그렇게
    // 사고가 났다 — 보내기 전에 반드시 확인한다.
    await this.waitUntilIdle(p);

    // ── 기존 어시스턴트 메시지 수 기록 ──
    // 이어가는 대화에서는 지난 응답들이 순차적으로 렌더링되므로, 개수가 멎기 전에
    // 세면 실제보다 작게 잡힌다. 그러면 collectResponse 가 "새 응답이 이미 도착했다"
    // 고 오인해 직전 라운드의 응답을 그대로 반환한다.
    const before = await this.countSettledMessages(p);

    // ── 직전 질문의 식별자 기록 ──
    // 전송 후 우리 질문이 화면에 그려지기까지 몇 초가 걸린다. 그 사이 "마지막
    // 질문 뒤의 답" 은 **직전 라운드의 답**이므로, 그것을 이번 응답으로 고정하지
    // 않도록 지금의 마지막 질문을 기억해 둔다.
    const lastUserBefore = await this.lastUserMessageId(p);

    // ── 프롬프트 입력 ──
    await this.fillPrompt(p, prompt);

    // ── 전송 ──
    // 이번 라운드의 생성만 근거로 쓴다. 이 값이 드라이버 수명 동안 남아 있으면
    // 지난 라운드에서 본 요청을 "지금 관측되는 생성" 의 근거로 삼게 된다.
    this.sawGeneration = false;
    await this.clickSend(p);

    // ── 대화 주소 확보 ──
    // **응답을 기다리기 전에** 알린다. 대기 구간이 2~15분이라 그 사이에 프로세스가
    // 죽으면, 여기서 안 남겨둔 URL 은 영영 잃는다. 그러면 다음 라운드가 대화가 없는
    // 줄 알고 새 창을 열어 **같은 질문을 다시 보낸다** (대화 한도를 그냥 버린다).
    if (onSent) onSent(await this.waitForConversationUrl(p));

    // ── 응답 수집 ──
    return this.collectResponse(p, before, lastUserBefore);
  }

  /** 화면에 그려져 있는 마지막 질문의 식별자 (없으면 null). */
  private async lastUserMessageId(page: Page): Promise<string | null> {
    try {
      return await page.evaluate(() => {
        const els = [...document.querySelectorAll('[data-message-author-role="user"]')];
        return els.length > 0 ? els[els.length - 1].getAttribute('data-message-id') : null;
      });
    } catch {
      return null;
    }
  }

  /**
   * 이미 보낸 프롬프트의 응답을 기다린다 (재전송 없이).
   *
   * 복귀했더니 그 라운드 질문은 이미 가 있고 답만 없는 경우에 쓴다.
   */
  async collectPending(): Promise<string> {
    const p = this.requirePage();
    return this.collectResponse(p, await this.countSettledMessages(p));
  }

  /**
   * 이 대화에 그 라운드 질문이 이미 있는지, 답까지 나왔는지 본다.
   *
   *   answered — 답이 있다. 다시 묻지 말고 그대로 쓴다.
   *   pending  — 질문만 있고 답이 없다. 다시 묻지 말고 기다린다.
   *   absent   — 그 라운드 질문이 없다. 새로 보내야 한다.
   *
   * 판별 실패는 전부 absent 로 떨어뜨린다 — 잘못 answered 로 보면 낡은 응답을
   * 게시하게 되고, 그건 다시 묻는 것보다 훨씬 나쁘다.
   */
  /**
   * 이 대화에 그 라운드 질문이 이미 있는지 본다.
   *
   * 있으면 응답 수집의 기준점(그 질문 직전까지의 어시스턴트 메시지 수)을 돌려준다.
   * 판별 실패는 전부 null 로 떨어뜨린다 — 잘못 "있다" 고 보면 엉뚱한 응답을
   * 게시하게 되고, 그건 다시 묻는 것보다 훨씬 나쁘다.
   */
  async findRound(marker: string): Promise<number | null> {
    const p = this.requirePage();
    await this.countSettledMessages(p); // 렌더가 멎을 때까지 기다린다

    // selectors.assistantMessage 를 일반화한 형태다 — 역할별로 나눠 읽어야
    // "그 질문이 마지막인가" 를 판정할 수 있다.
    try {
      const msgs = await p.evaluate((contentSel) => {
        return [...document.querySelectorAll('[data-message-author-role]')].map((el) => ({
          role: el.getAttribute('data-message-author-role') ?? '',
          text: (el.querySelector(contentSel) ?? el).textContent ?? '',
        }));
      }, this.cfg.selectors.messageContent);
      return findRoundBaseline(msgs, marker);
    } catch {
      return null;
    }
  }

  /**
   * 이미 보낸 프롬프트의 응답을 기준점부터 수집한다 (재전송 없이).
   *
   * 기준점을 findRound 가 준 값으로 쓰는 것이 핵심이다. 여기서 다시 세면 스트리밍
   * 중인 대상 노드가 기준에 포함돼 영영 오지 않을 다음 메시지를 기다리게 된다.
   * 완료 판정(스트리밍 종료 + 내용 안정)은 collectResponse 가 그대로 맡는다 —
   * 그래서 스트리밍 중인 부분 응답을 완성본으로 오인하지 않는다.
   */
  async collectFrom(assistantBefore: number): Promise<string> {
    return this.collectResponse(this.requirePage(), assistantBefore);
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

  /** 화면 하단 텍스트에서 쿼터 한도 안내를 탐지한다 (없으면 null). */
  private async detectQuotaLimit(page: Page): Promise<string | null> {
    const body = await page
      .locator('body')
      .innerText()
      .catch(() => '');
    const tail = body.slice(-4_000); // 최근 화면 영역만 검사
    for (const re of QUOTA_PATTERNS) {
      const m = tail.match(re);
      if (m) return m[0];
    }
    return null;
  }

  /** 입력창에 실제 텍스트가 들어갔는지 확인. */
  private async inputHasText(page: Page): Promise<boolean> {
    const t = await page
      .locator(this.cfg.selectors.textInput)
      .first()
      .innerText()
      .catch(() => '');
    return t.trim().length > 0;
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

    const focused = await page.evaluate((selector: string) => {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el) return false;
      el.focus();
      return document.activeElement === el || el.contains(document.activeElement);
    }, sel.textInput);

    if (!focused) {
      throw new Error('프롬프트 입력창에 포커스할 수 없습니다 — 브라우저 화면 상태를 확인하세요');
    }
  }

  /** ProseMirror contenteditable 에 텍스트를 삽입한다. */
  private async fillPrompt(page: Page, text: string): Promise<void> {
    await this.focusInput(page);
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');

    // 방법 1: CDP insertText — contenteditable 에 가장 안정적이고 빠르다
    await page.keyboard.insertText(text);
    await page.waitForTimeout(200);
    if (await this.inputHasText(page)) return;

    // 방법 2: 합성 paste 이벤트
    const pasted = await page.evaluate(
      ({ selector, t }: { selector: string; t: string }) => {
        const el = document.querySelector(selector) as HTMLElement | null;
        if (!el) return false;
        el.focus();
        const dt = new DataTransfer();
        dt.setData('text/plain', t);
        return el.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
        );
      },
      { selector: this.cfg.selectors.textInput, t: text },
    );
    if (pasted) {
      await page.waitForTimeout(300);
      if (await this.inputHasText(page)) return;
    }

    // 방법 3: keyboard.type
    console.log(chalk.dim('  insertText·paste 실패 — keyboard.type 로 재시도'));
    await this.focusInput(page);
    await page.keyboard.type(text, { delay: 1 });
    if (!(await this.inputHasText(page))) {
      throw new Error('프롬프트 입력 실패 — textInput 셀렉터를 확인하세요');
    }
  }

  private async clickSend(page: Page): Promise<void> {
    // 전송 버튼이 활성화될 때까지 잠시 대기
    await page.waitForTimeout(600);

    // 설정된 셀렉터를 먼저, 그다음 알려진 후보들을 순서대로 시도
    const candidates = [
      this.cfg.selectors.sendButton,
      '#composer-submit-button',
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="보내기"]',
    ];

    for (const c of candidates) {
      const btn = page.locator(c).first();
      try {
        if (await btn.isVisible({ timeout: 1_500 })) {
          await btn.click();
          return;
        }
      } catch {
        /* 다음 후보 */
      }
    }

    console.log(chalk.dim('  send 버튼 미발견 — Enter 로 전송'));
    await page.keyboard.press('Enter');
  }

  /**
   * 어시스턴트 응답이 완전히 스트리밍 될 때까지 폴링한다.
   * 3회 연속 동일 텍스트이면 완료로 간주.
   */
  private async collectResponse(
    page: Page,
    messageCountBefore: number,
    afterUserId: string | null = null,
  ): Promise<string> {
    const sel = this.cfg.selectors;
    const timeout = this.cfg.responseTimeoutMs;

    // 응답 시작을 **따로 기다리지 않는다.** 예전에는 여기서 60초 안에 어시스턴트
    // 노드가 안 뜨면 실패로 던졌는데, 추론 모드는 첫 노드가 뜨기까지 몇 분이 걸린다
    // ("Worked for 8m30s"). 정상 응답을 절단하고 라운드를 버린 뒤 같은 질문을 다시
    // 보내게 되므로, 이 프로젝트에서 가장 비싼 실패 방향이다.
    //
    // 예산은 responseTimeoutMs 하나로 통일한다. 아래 루프가 노드가 없는 동안에도
    // 빈 문자열을 읽으며 돌고, 완료 조건이 "내용이 있고 안정" 이라 조기 종료하지
    // 않는다. 한도 감지는 루프 안에서 주기적으로 한다 (예전엔 60초 catch 에만
    // 있어서, 그 시점을 넘기면 한도를 영영 못 봤다).
    progress.phase('waiting');
    console.log(chalk.dim('  응답 대기 중...'));

    // **기다린 그 노드를 읽는다.** `.last()` 로 읽으면 안 된다 — 기다리는 대상과
    // 읽는 대상이 갈리면 **엉뚱한 메시지를 응답으로 저장해 게시한다.** 실제로 9차
    // 라운드가 7차의 응답을 그대로 게시했다 (관측 길이가 845자로 272초 고정되다가
    // 341자로 급감 — 스트리밍이면 있을 수 없는 변화다).
    //
    // 위치는 **매 폴링마다 화면에서 다시 판정한다** (anchorAnswer). 전송 시점의
    // 개수(messageCountBefore)를 그대로 위치로 쓰면, 그 뒤 ChatGPT 가 화면 밖
    // 메시지를 떼어내는 순간 그 위치는 아무것도 가리키지 않게 되고 응답이 화면에
    // 다 나와 있는데도 "0자" 로 예산을 전부 태운다 (#75 6차 · 15분 타임아웃).
    //
    // 판정된 노드는 즉시 **식별자로 고정**해 DOM 이 흔들려도 같은 메시지만 읽는다.
    // 고정 후 노드가 계속 사라져 있으면 수집을 실패시킨다 — 다른 메시지를 대신
    // 읽어 게시하는 것보다 낫다.
    let bound: BoundTarget | null = null;
    /** 앵커는 답 노드를 찾았는데 식별자가 없을 때 쓰는 위치. */
    let readyNth: number | null = null;
    /** 앵커 판별이 계속 안 돼 전송 시점 위치로 물러섰는가. */
    let fellBack = false;
    let anchorNoted = false;
    let redrawNoted = false;
    /** 앵커를 연속으로 못 잡은 횟수 — 위치 기반으로 물러설지 판단한다. */
    let unknowns = 0;

    /**
     * 지금 읽어야 할 노드. **모르면 null 이다** — 그때는 아무것도 읽지 않는다.
     *
     * 대상이 정해지기 전에 위치로 아무 메시지나 읽으면, 그 값이 3회 안정 관측을
     * 통과해 직전 라운드의 답이 이번 응답으로 저장된다.
     */
    const targetLocator = (): Locator | null => {
      if (bound) return page.locator(`[${MESSAGE_ID_ATTR}="${bound.id}"]`);
      if (readyNth !== null) return page.locator(sel.assistantMessage).nth(readyNth);
      if (fellBack) return page.locator(sel.assistantMessage).nth(messageCountBefore);
      return null;
    };

    // 셀렉터를 일반화한 형태다 (findRound 와 같은 이유) — 역할을 나눠 읽어야
    // "마지막 질문 뒤" 를 판정할 수 있다.
    const readMessages = async (): Promise<MessageRef[] | null> => {
      try {
        return await page.evaluate(() =>
          [...document.querySelectorAll('[data-message-author-role]')].map((el) => ({
            role: el.getAttribute('data-message-author-role') ?? '',
            id: el.getAttribute('data-message-id'),
          })),
        );
      } catch {
        return null; // 네비게이션 중 등
      }
    };

    /**
     * 아직 고정 전이면 대상을 찾아 고정한다.
     *
     * 한 번 고정한 뒤에는 `judgeRebind` 만이 대상을 바꾼다 — 같은 질문의 답으로
     * 갈아 끼우는 경우뿐이다.
     */
    const bindTarget = (msgs: MessageRef[] | null): BoundTarget | null => {
      const anchor: AnswerAnchor = msgs
        ? anchorAnswer(msgs, afterUserId)
        : { status: 'unknown' };

      unknowns = anchor.status === 'unknown' ? unknowns + 1 : 0;

      // 답 노드가 아직 없다 — 여기서 위치로 물러서면 직전 라운드의 답을 읽는다.
      if (anchor.status === 'pending') return null;

      if (anchor.status === 'ready') {
        if (!anchorNoted && anchor.nth !== messageCountBefore) {
          anchorNoted = true;
          console.log(
            chalk.dim(
              `  응답 위치가 전송 시점과 다릅니다 (${messageCountBefore} → ${anchor.nth}) — 화면 기준으로 따라갑니다.`,
            ),
          );
        }
        // 따옴표가 섞이면 셀렉터가 깨진다 — 그때는 위치로 읽고 축소 방어가 맡는다.
        if (anchor.id && !/["\\]/.test(anchor.id)) {
          readyNth = null;
          return { id: anchor.id, userId: anchor.userId, nth: anchor.nth };
        }
        readyNth = anchor.nth;
        return null;
      }

      // 앵커 판별 불가 (셀렉터 커스터마이즈 등) — 종전대로 전송 시점 기준 위치.
      // 전송 직후 우리 질문이 아직 안 그려진 한순간도 여기로 떨어지는데, 그때
      // 물러서면 직전 라운드의 답을 고정한다. 계속 못 잡을 때만 물러선다.
      if (unknowns >= UNKNOWN_TOLERANCE) fellBack = true;
      return null;
    };

    // 메시지 컨테이너 전체를 읽으면 "Edit"·복사 버튼 같은 UI 텍스트가 섞인다.
    // 본문(.markdown)이 있으면 그쪽을 읽는다. 한 메시지 안에 본문 블록이 여러 개면
    // (산문 + 코드블록 + 산문) **전부 이어 붙인다** — 마지막 하나만 집으면 JSON 이
    // 앞에 있을 때 통째로 잃는다.
    const readTarget = async (): Promise<string> => {
      const target = targetLocator();
      if (!target) return ''; // 어느 노드가 이번 답인지 아직 모른다
      const bodies = target.locator(sel.messageContent);
      if ((await bodies.count().catch(() => 0)) > 0) {
        const parts = await bodies.allInnerTexts().catch(() => [] as string[]);
        return parts.join('\n').trim();
      }
      return target.innerText().catch(() => '');
    };

    let lastText = '';
    let stable = 0;
    let shrinks = 0;
    let misses = 0;
    let recoveries = 0;
    let lastLogAt = Date.now();
    let lastQuotaCheckAt = Date.now();
    let lastChangeAt = Date.now();
    let lastDumpAt = Date.now();
    const t0 = Date.now();

    while (Date.now() - t0 < timeout) {
      await page.waitForTimeout(3_000);

      const msgs = await readMessages();

      if (bound) {
        // 고정한 노드가 안 보인다. ChatGPT 가 임시 식별자로 그린 답 노드를 서버
        // 식별자로 갈아 끼우는 구간이 여기다 — **같은 질문의 답이면 따라간다.**
        // 확인이 안 될 때만 유예를 쓰고, 유예를 다 쓰면 라운드를 접는다. 위치로
        // 물러서서 아무 메시지나 읽으면 그게 바로 낡은 응답 게시다.
        const decision = judgeRebind(msgs ?? [], bound);
        if (decision.action === 'rebind') {
          bound = { id: decision.id, userId: bound.userId, nth: bound.nth };
          console.log(chalk.dim('  응답 노드가 교체됐습니다 — 같은 질문의 답으로 다시 고정합니다.'));
        } else if (decision.action === 'wait') {
          // 답 노드가 잠시 사라졌다 (추론 중 다시 그리는 구간). 고정은 그대로 두고
          // 기다린다 — 아래로 흘려보내야 생성 중 판정·정체 진단·경과 표시가 산다.
          // 죽은 노드를 읽으면 빈 문자열이라 완료로 오인될 일도 없다.
          if (!redrawNoted) {
            redrawNoted = true;
            console.log(chalk.dim('  답 노드가 다시 그려지는 중입니다 — 같은 질문이므로 기다립니다.'));
          }
        } else if (decision.action === 'hold') {
          if (++misses >= MISS_TOLERANCE) {
            throw new Error(
              `수집 중이던 응답 노드가 사라졌습니다 (대화 화면이 바뀐 것으로 보입니다 · ${decision.reason}).`,
            );
          }
          console.log(
            chalk.dim(`  응답 노드가 안 보입니다 (${misses}/${MISS_TOLERANCE} · ${decision.reason})`),
          );
          continue;
        }
        misses = 0;
      } else {
        bound = bindTarget(msgs);
      }

      const cur = await readTarget();

      // 식별자를 못 잡아 위치로 읽는 중이라면, **짧아진 값을 채택하지 않는다.**
      // 생성 중인 응답은 길어지기만 하므로 축소는 다른 노드를 읽었다는 신호다.
      // (경고만 하고 덮어쓰면 그 값이 3회 안정 관측을 통과해 그대로 게시된다.)
      if (!bound && lastText.length > 0 && cur.length < lastText.length) {
        shrinks++;
        console.log(
          chalk.yellow(
            `  ⚠ 읽은 응답이 짧아졌습니다 (${lastText.length.toLocaleString()} → ` +
              `${cur.length.toLocaleString()}자) — 다른 노드로 보고 채택하지 않습니다 ` +
              `(${shrinks}/${SHRINK_TOLERANCE}).`,
          ),
        );
        stable = 0;
        if (shrinks >= SHRINK_TOLERANCE) {
          throw new Error('읽는 응답 노드가 계속 바뀝니다 — 낡은 응답을 게시하지 않기 위해 중단합니다.');
        }
        continue;
      }
      shrinks = 0;

      // **덮어쓰기 전에** 변경 여부를 잡는다. 아래에서 lastText = cur 을 해버리면
      // 그 뒤에는 언제나 같아 보여서, 정상 스트리밍도 "변화 없음" 으로 기록된다.
      const changed = cur !== lastText;
      if (changed) lastChangeAt = Date.now();

      if (cur.length > 0 && !changed) {
        stable++;
      } else {
        stable = 0;
        lastText = cur;
      }

      // 대기 판정은 **종전 그대로** 중지 버튼만 본다. 네트워크 관측은 근거를
      // 남기는 용도이고, 무트래픽 시간으로 대기를 끊으면 오래 걸리는 추론의
      // 부분 응답을 완성본으로 게시하게 된다 (이슈 #1 이 경계한 조기 절단).
      const streaming = await this.isStreaming(page);
      const phase = streaming ? '생성 중' : lastText ? '대기' : '추론 중';

      // ── 정체 진단 (이슈 #1) ──
      // 화면이 멎었는데 계속 "생성 중" 이면, 그 순간의 근거를 남긴다. 재현될 때
      // 사람이 붙어 있지 않아도 (a) 스트림 사망 / (b) 셀렉터 오탐 / (c) 실제 생성
      // 중을 사후에 가릴 수 있어야 한다.
      const stalledMs = Date.now() - lastChangeAt;
      if (
        streaming &&
        stalledMs > STALL_DUMP_EVERY_MS &&
        Date.now() - lastDumpAt > STALL_DUMP_EVERY_MS
      ) {
        lastDumpAt = Date.now();
        const quiet = this.lastNetAt ? Math.round((Date.now() - this.lastNetAt) / 1000) : -1;
        console.log(
          chalk.yellow(
            `  ⚠ ${Math.round(stalledMs / 1000)}초째 화면 변화 없음 · 근거=${this.stallEvidence(true)} · ` +
              `생성요청 ${this.netInFlight}건 진행 · 네트워크 ${quiet}초째 조용 · ` +
              `중지버튼 ${await this.dumpStopButtons(page)}`,
          ),
        );
      }

      // 아직 아무것도 안 나왔고 생성 중도 아니면 한도에 막힌 것일 수 있다.
      // 예전에는 이 검사가 "60초 시작 타임아웃" catch 에만 있어서, 그 시점을
      // 넘기면 한도를 영영 못 보고 15분을 기다렸다.
      if (!streaming && !lastText && Date.now() - lastQuotaCheckAt > QUOTA_RECHECK_MS) {
        lastQuotaCheckAt = Date.now();
        const quota = await this.detectQuotaLimit(page);
        if (quota) throw new QuotaLimitError(`한도 감지: "${quota}"`);
      }

      // 터미널은 30초마다 한 줄이지만 UI 는 폴링마다 갱신한다 — 이 구간이 2~15분
      // 이라 "멈춘 건지 도는 건지" 를 실시간으로 보여주는 게 관측의 핵심이다.
      // (이슈 #1 의 원인 미상 타임아웃도 여기 기록이 남아야 나중에 짚을 수 있다.)
      progress.stream(phase, lastText.length);

      // 완료 조건: 생성이 끝났고, 내용이 있고, 여러 번 동일
      if (!streaming && lastText.trim().length > 0 && stable >= 3) {
        console.log(chalk.green(`  ✓ 응답 수신 완료 (${lastText.length.toLocaleString()}자)`));
        return lastText;
      }

      // 중지 버튼이 끝내 안 사라지는 경우의 완료 (#109).
      //
      // 버튼은 종전대로 1차 권위다 — 위 조건이 성립하면 여기까지 오지 않는다.
      // 다만 버튼 하나가 유일한 권위이면, 그것이 DOM 에 남는 순간 완료가 영원히
      // 성립하지 않아 완성된 응답을 통째로 버린다. 다른 근거가 모두 "끝났다" 를
      // 가리킬 때만 버튼을 고장으로 인정한다 (판정 근거는 judgeStuckButton).
      if (
        streaming &&
        lastText.trim().length > 0 &&
        judgeStuckButton({
          sawGeneration: this.sawGeneration,
          inFlight: this.netInFlight,
          quietMs: this.lastNetAt ? Date.now() - this.lastNetAt : Number.POSITIVE_INFINITY,
          idleMs: Date.now() - lastChangeAt,
        })
      ) {
        console.log(
          chalk.yellow(
            `  ⚠ 중지 버튼이 ${Math.round((Date.now() - lastChangeAt) / 1000)}초째 남아 있는데 ` +
              '생성 요청은 없고 화면도 멎었습니다 — 버튼 고장으로 보고 완료 처리합니다.',
          ),
        );
        console.log(chalk.green(`  ✓ 응답 수신 완료 (${lastText.length.toLocaleString()}자)`));
        return lastText;
      }

      // "Connection interrupted" — 스트림이 끊긴 상태. 서버에는 응답이 완성돼 있으므로
      // 대화를 새로고침하면 완성본을 가져올 수 있다.
      if (!streaming && (await this.hasInterruptedBanner(page))) {
        if (recoveries >= MAX_RELOAD_RECOVERIES) {
          throw new Error(
            `연결 중단이 반복됩니다 (${recoveries}회 복구 시도). 브라우저 창에서 상태를 확인하세요.`,
          );
        }
        recoveries++;
        console.log(
          chalk.yellow(
            `  ⚠ 연결 중단 감지 — 대화를 새로고침해 완성된 응답을 가져옵니다 (${recoveries}/${MAX_RELOAD_RECOVERIES})`,
          ),
        );
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
        await page.waitForTimeout(6_000);
        stable = 0;
        lastText = '';
        // 화면을 통째로 다시 그렸다 — 고정을 풀고 새 DOM 에서 다시 앵커를 잡는다.
        // (그대로 두면 새 노드의 id 가 달라졌을 때 "사라졌다" 로 라운드를 버린다.)
        bound = null;
        readyNth = null;
        fellBack = false;
        unknowns = 0;
        misses = 0;
        continue;
      }

      // 진행 상황 — 멈춘 것처럼 보이지 않게 30초마다 출력
      if (Date.now() - lastLogAt > 30_000) {
        lastLogAt = Date.now();
        const sec = Math.round((Date.now() - t0) / 1000);
        console.log(
          chalk.dim(`    …${sec}초 경과 · ${phase} · ${lastText.length.toLocaleString()}자`),
        );
      }
    }

    // ── 예산 소진 ──
    // **아직 생성 중인지**로 가른다. 글자가 좀 쌓였다는 것만으로 "받았다" 고 보면,
    // 15분 직전에 JSON 을 쓰기 시작한 응답이 잘린 채 파서로 넘어가 ReviewRejected
    // 로 둔갑한다. 원인은 타임아웃인데 표기는 붉은 "리뷰 실패" 가 되어, 이 구분이
    // 느린 생성에서 통째로 우회된다.
    const stillGenerating = await this.isStreaming(page);
    const minutes = Math.round(timeout / 60_000);

    if (!stillGenerating && lastText.trim().length > 0) {
      // 생성은 끝났는데 안정 판정만 못 받은 경우다 (내용이 계속 흔들렸다).
      // 완성본일 가능성이 높으므로 복구용으로 쓴다 — 종전 동작.
      console.log(chalk.yellow('  ⚠ 예산 소진 — 생성은 끝나 있어 현재 텍스트를 사용합니다.'));
      return lastText;
    }

    const quota = await this.detectQuotaLimit(page);
    if (quota) throw new QuotaLimitError(`한도 감지: "${quota}"`);
    throw new ResponseTimeoutError(
      lastText.trim().length > 0
        ? `${minutes}분 안에 응답이 끝나지 않았습니다 (${lastText.length.toLocaleString()}자까지 생성). ` +
          '잘린 응답은 게시하지 않습니다 — responseTimeoutMs 를 늘리거나 다음 라운드에서 다시 시도합니다.'
        : `${minutes}분 동안 응답을 받지 못했습니다. ` +
          '브라우저 창에서 ChatGPT 상태를 확인하거나 responseTimeoutMs 를 늘려보세요.',
    );
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

  /**
   * 중지 버튼 셀렉터에 **무엇이 걸렸는지** 덤프한다 (이슈 #1 다음 단계 1).
   *
   * 오탐(받아쓰기 중지 등 다른 버튼)인지 진짜 생성 중지 버튼인지는 이걸 봐야 갈린다.
   * 재현될 때 자동으로 남게 해 두지 않으면 사람이 그 순간에 붙어 있어야 한다.
   */
  private async dumpStopButtons(page: Page): Promise<string> {
    try {
      const info = await page.evaluate((selector) => {
        return [...document.querySelectorAll(selector)].map((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return {
            tag: el.tagName.toLowerCase(),
            testid: el.getAttribute('data-testid'),
            aria: el.getAttribute('aria-label'),
            disabled: (el as HTMLButtonElement).disabled ?? null,
            visible: r.width > 0 && r.height > 0,
          };
        });
      }, this.cfg.selectors.stopButton);
      return info.length === 0 ? '(매칭 없음)' : JSON.stringify(info);
    } catch {
      return '(덤프 실패)';
    }
  }

  /** 생성 중지 버튼이 있으면 아직 스트리밍 중. */
  private async isStreaming(page: Page): Promise<boolean> {
    try {
      return (await page.locator(this.cfg.selectors.stopButton).count()) > 0;
    } catch {
      return false;
    }
  }

  /** "Connection interrupted" 배너 감지. */
  private async hasInterruptedBanner(page: Page): Promise<boolean> {
    const body = await page
      .locator('body')
      .innerText()
      .catch(() => '');
    return INTERRUPT_PATTERNS.some((re) => re.test(body.slice(-4_000)));
  }
}
