/**
 * 진행 상황 버스 — 실행 중인 watch 루프의 "지금 모습" 을 한곳에 모은다.
 *
 * UI 는 오직 이 버스만 본다. **data/state/*.json 을 읽지 않는다.**
 * store.ts 의 saveContext 는 잠금 없는 writeFileSync 이고, 리뷰 라운드 하나는
 * 2~15분 동안 read-modify-write 를 붙잡고 있다. UI 가 별도 프로세스든 별도 읽기
 * 경로든 파일을 직접 건드리면 그 사이에 끼어들어 라운드 결과를 덮어쓰거나
 * 찢어진 JSON 을 읽는다. queue.ts 가 큐 파일을 만들지 않기로 한 것과 같은 이유다.
 *
 * 이 모듈은 **리프**다 — http 도 config 도 상태 머신도 모른다. reviewer/chatgpt 는
 * console 에 찍듯 여기에 찍기만 하고, 실제 전송은 ui/server.ts 가 구독해서 맡는다.
 * 그래서 의존 방향이 reviewer → progress ← ui 로만 흐르고 순환하지 않는다.
 */

import { randomUUID } from 'node:crypto';
import type { PRState } from './types.js';

// ── 데이터 모델 ─────────────────────────────────────────────

/**
 * 라운드 1회의 진행 단계.
 *
 * `waiting` 이 압도적으로 길다 (실측 2~15분). 터미널에서는 이 구간에 30초마다
 * 한 줄씩만 찍혀서 살아있는지 알기 어려웠는데, UI 의 존재 이유 절반이 여기다.
 */
export type ReviewPhase =
  | 'conversation' // 대화 진입 · 복귀
  | 'prompt' // 프롬프트 조립 · 전송
  | 'waiting' // ChatGPT 응답 대기 (가장 긴 구간)
  | 'parsing' // 응답 파싱 · 검증
  | 'posting' // GitHub 인라인 리뷰 게시
  | 'syncing'; // 게시 후 스레드 동기화

export const PHASE_LABELS: Record<ReviewPhase, string> = {
  conversation: '대화 준비',
  prompt: '프롬프트 전송',
  waiting: '응답 대기',
  parsing: '응답 파싱',
  posting: '리뷰 게시',
  syncing: '스레드 동기화',
};

/** collectResponse 가 3초마다 관측하는 스트리밍 상태 — 이슈 #1 진단용 기록. */
export interface StreamProbe {
  /** '생성 중' | '대기' | '추론 중' — chatgpt.ts 의 판정을 그대로 옮긴다 */
  state: string;
  /** 지금까지 수신한 응답 길이 */
  chars: number;
  /** 관측 시각 */
  at: number;
}

export interface ActiveReview {
  key: string;
  title: string;
  url: string;
  /** 진행 중인 라운드 번호 (1-based) */
  round: number;
  reasonLabel: string;
  dryRun: boolean;
  startedAt: number;
  phase: ReviewPhase;
  /** 현재 단계로 진입한 시각 — 경과 시간은 클라이언트가 여기서 계산한다 */
  phaseSince: number;
  stream?: StreamProbe;
}

export interface QueueItem {
  key: string;
  title: string;
  url: string;
  round: number;
  tier: number;
  reasonLabel: string;
  waitingSince: string;
}

export interface ContextCard {
  key: string;
  title: string;
  url: string;
  state: PRState;
  stateLabel: string;
  nextAction: string;
  round: number;
  requestedCount: number;
  threadsTotal: number;
  threadsResolved: number;
  excludedReason?: string;
  quotaRetryAt?: string;
  lastError?: string;
  conversationUrl?: string;
  conversationTurns?: number;
  updatedAt: string;
  /**
   * 지금까지 일어난 **상태 전이 횟수** (이벤트 히스토리 길이).
   *
   * "내 요청 이후에 무슨 일이 있었나" 를 판정하는 단조 증가 토큰이다.
   * `round` 로는 안 된다 — 실패·쿼터 한도·PR 닫힘은 라운드를 올리지 않고
   * 전이만 하므로, 라운드로 재면 그 결과들을 "예전 것" 으로 버린다.
   * `updatedAt` 도 안 된다 — 스캔마다 갱신돼서 아무 일이 없어도 계속 움직인다.
   */
  seq: number;
}

export interface CycleInfo {
  /** 스캔이 도는 중인지 (짧다 — 보통 1초 미만) */
  scanning: boolean;
  /** 마지막 스캔이 실제로 폴링한 레포 수 */
  watchedRepos: number;
  /** 마지막 스캔이 관측한 열린 PR 수 */
  openCount: number;
  /** 직전 사이클이 쓴 GraphQL point */
  lastCost: number;
  /** GraphQL 잔여 한도 (-1 = 미관측) */
  remaining: number;
  lastScanAt: number | null;
  /** 다음 스캔 예정 시각 — 카운트다운은 클라이언트가 계산한다 */
  nextScanAt: number | null;
}

/**
 * UI 가 편집할 수 있는 현재 설정. 스냅샷에 실어야 화면이 "지금 무엇이 걸려 있는지"
 * 를 보여줄 수 있다 — 특히 `only` 는 하나 걸어두면 나머지가 전부 멈추므로
 * 눈에 띄게 표시하고 한 번에 풀 수 있어야 한다.
 */
export interface ControlState {
  /** 감시 모드 — 어떤 include 패턴이 허용되는지가 모드마다 다르다 */
  mode: string;
  paused: boolean;
  /** 아직 적용되지 않은 의도 건수 (라운드 중이면 끝난 뒤 반영된다) */
  pendingIntents: number;
  include: string[];
  exclude: string[];
  skip: string[];
  only: string[];
  /** '지금 리뷰' 로 큐 앞으로 당겨둔 PR 참조 */
  prioritized: string[];
}

export interface Snapshot {
  /**
   * 이 프로세스의 고유 id. 로그 seq 는 프로세스마다 1부터 다시 시작하므로,
   * 이게 없으면 watch 를 재시작했을 때 클라이언트의 seq 중복 제거가 새 로그를
   * 전부 "이미 본 것" 으로 버린다 (재연결 자체는 EventSource 가 알아서 한다).
   */
  session: string;
  /**
   * 이 데몬이 **어느 설치본**인지 (dataDir 기준). 세션 id 와 다르다 — 저건
   * 프로세스마다 새로 만들고, 이건 재시작해도 같다.
   *
   * 잠금은 dataDir 단위인데 UI 포트는 머신 전체에서 공유된다. 그래서 체크아웃이
   * 둘이면 4478·4479 에 서로 다른 설치본의 데몬이 동시에 존재할 수 있고, 붙는
   * 쪽이 포트만 보고 고르면 **남의 설정·계정으로** 리뷰를 요청하거나 남의
   * 데몬을 종료하게 된다. 클라이언트는 자기 dataDir 로 같은 값을 계산해 대조한다.
   */
  instance: string | null;
  /** 'observe' 면 리뷰를 실행하지 않는다 — 리뷰를 요청해도 큐에만 쌓인다. */
  mode: 'review' | 'observe';
  control: ControlState;
  startedAt: number;
  scope: string;
  account: string | null;
  dryRun: boolean;
  cycle: CycleInfo;
  /** 쿼터 쿨다운 해제 시각 (epoch ms) */
  quotaUntil: number | null;
  active: ActiveReview | null;
  queue: QueueItem[];
  contexts: ContextCard[];
}

export type LogLevel = 'error' | 'warn' | 'ok' | 'dim' | 'info';

export interface LogLine {
  seq: number;
  at: number;
  level: LogLevel;
  text: string;
}

export type BusEvent =
  | { type: 'snapshot'; data: Snapshot }
  | { type: 'log'; data: LogLine };

type Listener = (e: BusEvent) => void;

// ── 로그 정규화 ─────────────────────────────────────────────

const ANSI = /\[[0-9;]*m/g;

/**
 * 로그 심각도를 추론한다.
 *
 * 새 로깅 API 를 만들어 60여 개 호출부를 고치는 대신, 이미 있는 두 신호를 읽는다:
 * chalk 가 넣은 첫 SGR 코드와, 출력문에 쓰이는 마커 문자(✓ ⚠ ✗).
 * 색이 꺼진 환경(파이프 등)에서는 앞의 신호가 사라지므로 마커가 폴백이 된다.
 */
export function inferLevel(raw: string): LogLevel {
  const sgr = raw.match(/\[(\d+)m/)?.[1];
  if (sgr === '31') return 'error';
  if (sgr === '33') return 'warn';
  if (sgr === '32') return 'ok';
  if (sgr === '2') return 'dim';
  if (raw.includes('✗')) return 'error';
  if (raw.includes('⚠')) return 'warn';
  if (raw.includes('✓')) return 'ok';
  return 'info';
}

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

// ── 버스 ────────────────────────────────────────────────────

/** 로그 링 버퍼 상한. 새로 붙는 클라이언트가 받는 최근 기록의 양이기도 하다. */
const LOG_CAP = 600;

function emptySnapshot(session: string): Snapshot {
  return {
    session,
    instance: null,
    mode: 'review',
    control: {
      mode: '',
      paused: false,
      pendingIntents: 0,
      include: [],
      exclude: [],
      skip: [],
      only: [],
      prioritized: [],
    },
    startedAt: Date.now(),
    scope: '',
    account: null,
    dryRun: false,
    cycle: {
      scanning: false,
      watchedRepos: 0,
      openCount: 0,
      lastCost: 0,
      remaining: -1,
      lastScanAt: null,
      nextScanAt: null,
    },
    quotaUntil: null,
    active: null,
    queue: [],
    contexts: [],
  };
}

class ProgressBus {
  /**
   * `watch --ui` 일 때만 켜진다. 꺼져 있으면 모든 기록 호출이 즉시 반환한다 —
   * UI 없이 돌 때 스냅샷 조립 비용을 내지 않기 위해서다.
   */
  enabled = false;

  private readonly sessionId = randomUUID();
  private snap: Snapshot = emptySnapshot(this.sessionId);
  private logs: LogLine[] = [];
  private seq = 0;
  private listeners = new Set<Listener>();

  // ── 구독 ──

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 새로 붙은 클라이언트에게 줄 현재 전체 상태. */
  state(): { snapshot: Snapshot; logs: LogLine[] } {
    return { snapshot: this.snap, logs: this.logs };
  }

  private emit(e: BusEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        /* 구독자 하나가 죽어도 루프는 계속 간다 */
      }
    }
  }

  private push(): void {
    this.emit({ type: 'snapshot', data: this.snap });
  }

  // ── 기록 ──

  patch(p: Partial<Snapshot>): void {
    if (!this.enabled) return;
    // session 은 호출자가 덮어쓸 수 없다 — 클라이언트의 로그 판정 기준이다.
    this.snap = { ...this.snap, ...p, session: this.sessionId };
    this.push();
  }

  cycle(p: Partial<CycleInfo>): void {
    if (!this.enabled) return;
    this.snap = { ...this.snap, cycle: { ...this.snap.cycle, ...p } };
    this.push();
  }

  control(p: Partial<ControlState>): void {
    if (!this.enabled) return;
    this.snap = { ...this.snap, control: { ...this.snap.control, ...p } };
    this.push();
  }

  log(raw: string): void {
    if (!this.enabled) return;
    const text = stripAnsi(raw).replace(/\s+$/, '');
    if (text.trim().length === 0) return; // 터미널 여백용 빈 줄은 UI 에서 소음이다
    const line: LogLine = { seq: ++this.seq, at: Date.now(), level: inferLevel(raw), text };
    this.logs.push(line);
    if (this.logs.length > LOG_CAP) this.logs.splice(0, this.logs.length - LOG_CAP);
    this.emit({ type: 'log', data: line });
  }

  // ── 라운드 진행 ──

  beginReview(a: Omit<ActiveReview, 'phase' | 'phaseSince' | 'startedAt'>): void {
    if (!this.enabled) return;
    const now = Date.now();
    this.snap = {
      ...this.snap,
      active: { ...a, startedAt: now, phase: 'conversation', phaseSince: now },
    };
    this.push();
  }

  phase(phase: ReviewPhase): void {
    if (!this.enabled || !this.snap.active) return;
    if (this.snap.active.phase === phase) return;
    this.snap = {
      ...this.snap,
      // 단계가 바뀌면 이전 단계의 스트리밍 관측값은 의미를 잃는다
      active: { ...this.snap.active, phase, phaseSince: Date.now(), stream: undefined },
    };
    this.push();
  }

  /** 응답 대기 중 스트리밍 관측값 갱신 (chatgpt.ts 의 폴링 주기마다). */
  stream(state: string, chars: number): void {
    if (!this.enabled || !this.snap.active) return;
    this.snap = {
      ...this.snap,
      active: { ...this.snap.active, stream: { state, chars, at: Date.now() } },
    };
    this.push();
  }

  endReview(): void {
    if (!this.enabled) return;
    this.snap = { ...this.snap, active: null };
    this.push();
  }
}

export const progress = new ProgressBus();
