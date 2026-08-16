/**
 * 리뷰 큐.
 *
 * 큐는 **저장하지 않는다.** `REVIEW_DUE` 인 컨텍스트들에서 매번 다시 계산한다.
 * store.ts 에는 잠금이 없어서 별도 큐 파일을 두면 watch 루프와 queue 명령이
 * 같은 파일을 다투게 된다. 상태 자체가 이미 단일 소스이므로 파생만으로 충분하고,
 * 프로세스가 죽어도 큐가 어긋나지 않는다.
 *
 * 큐 대기는 **실행기 사정**이지 GitHub 에서 관측된 PR 상태가 아니다. 따라서
 * QUEUED 같은 상태를 상태 머신(TRANSITIONS)에 추가하지 않는다. 리뷰를 기다리는
 * PR 은 그냥 REVIEW_DUE 이고, 그중 무엇을 먼저 돌릴지만 여기서 정한다.
 */

import type { PRContext, PREvent } from './types.js';

/** 큐에 오른 사유 — 우선순위 판정과 표시에 쓰인다. */
export type QueueReason =
  | 'first-round' // 아직 한 라운드도 돌지 않음
  | 'author-responded' // 작성자가 커밋 push 또는 스레드 resolve 로 응답
  | 'new-commits' // 수렴 후 새 커밋
  | 'cooldown' // 쿼터 쿨다운 종료
  | 'retry'; // 실패 후 자동 재시도

export const QUEUE_REASON_LABELS: Record<QueueReason, string> = {
  'first-round': '1차 리뷰',
  'author-responded': '작성자 응답',
  'new-commits': '새 커밋',
  cooldown: '쿼터 해제',
  retry: '재시도',
};

/**
 * 우선순위 티어 (작을수록 먼저).
 *
 * 이슈 #3 의 우선순위 정의를 그대로 옮긴 것:
 *   라운드 미진행 > 작성자 응답 완료 > 오래 대기한 순
 * 앞의 둘이 티어이고, "오래 대기한 순" 은 같은 티어 안의 정렬 기준이다.
 */
export const TIER_FIRST_ROUND = 0;
export const TIER_AUTHOR_RESPONDED = 1;
export const TIER_OTHER = 2;

export interface QueueEntry {
  ctx: PRContext;
  tier: number;
  reason: QueueReason;
  /** REVIEW_DUE 로 들어온 시각 (ISO) — 대기 시간의 기준 */
  waitingSince: string;
  waitingMs: number;
}

/** REVIEW_DUE 로 들어오게 한 마지막 이벤트. 신규 컨텍스트면 null. */
function lastEntryEvent(ctx: PRContext): { event: PREvent; at: string } | null {
  for (let i = ctx.history.length - 1; i >= 0; i--) {
    const h = ctx.history[i];
    if (h.to === 'REVIEW_DUE') return { event: h.event, at: h.at };
  }
  return null;
}

function reasonOf(event: PREvent | null): QueueReason {
  switch (event) {
    case 'AUTHOR_RESPONDED':
      return 'author-responded';
    case 'NEW_COMMITS':
      return 'new-commits';
    case 'COOLDOWN_ELAPSED':
      return 'cooldown';
    case 'RETRY':
      return 'retry';
    default:
      return 'first-round'; // 진입 이벤트가 없다 = 방금 만들어진 컨텍스트
  }
}

/** 컨텍스트 1건을 큐 엔트리로 환산한다 (REVIEW_DUE 여부는 보지 않는다). */
export function toQueueEntry(ctx: PRContext, now = Date.now()): QueueEntry {
  const last = lastEntryEvent(ctx);
  const reason = reasonOf(last?.event ?? null);
  const waitingSince = last?.at ?? ctx.createdAt;

  // 아직 한 번도 리뷰하지 않은 PR 이 최우선이다. 재시도로 REVIEW_DUE 가 됐어도
  // 성공한 라운드가 없으면 여전히 "라운드 미진행" 이다.
  const tier =
    ctx.round === 0
      ? TIER_FIRST_ROUND
      : reason === 'author-responded'
        ? TIER_AUTHOR_RESPONDED
        : TIER_OTHER;

  return {
    ctx,
    tier,
    reason,
    waitingSince,
    waitingMs: Math.max(0, now - Date.parse(waitingSince)),
  };
}

/** 큐에 오를 자격 — REVIEW_DUE 이면서 감시 필터에 걸리지 않은 것. */
export function isQueueable(ctx: PRContext): boolean {
  return ctx.state === 'REVIEW_DUE' && !ctx.excludedReason;
}

/**
 * 리뷰 대기열을 만든다 — REVIEW_DUE 인 것만, 우선순위 순으로.
 *
 * 큐가 정하는 것은 **무엇을 먼저** 다. 한 번에 몇 개를 돌릴지는 실행기가
 * `maxConcurrentReviews` 로 정한다 (`reviewBatchSize`).
 *
 * 필터에 걸린 컨텍스트(excludedReason)는 제외한다. watch 는 애초에 넘기지 않지만,
 * `queue` 명령은 저장소를 통째로 읽으므로 여기서 한 번 더 걸러야 둘이 같은 답을 준다.
 */
export function buildQueue(contexts: PRContext[], now = Date.now()): QueueEntry[] {
  return contexts
    .filter(isQueueable)
    .map((c) => toQueueEntry(c, now))
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        Date.parse(a.waitingSince) - Date.parse(b.waitingSince) || // 오래 기다린 것 먼저
        a.ctx.prNumber - b.ctx.prNumber, // 완전한 결정성 확보
    );
}

/**
 * 이번에 **한꺼번에** 돌릴 라운드 수 — 설정값과 대기열 길이 중 작은 쪽.
 *
 * `limit` 가 0 이하면 제한 없음(대기열 전체)이다. 소수·NaN 같은 값은 1 로
 * 접는다 — 설정 파일은 사람이 손으로 고치는 곳이고, 여기서 이상한 값이 그대로
 * 흘러가면 탭이 몇 개 열릴지 아무도 모르게 된다.
 */
export function reviewBatchSize(limit: number, queued: number): number {
  if (queued <= 0) return 0;
  if (!Number.isFinite(limit)) return 1;
  const n = Math.floor(limit);
  if (n <= 0) return queued; // 제한 없음
  return Math.min(n, queued);
}

// ── 쿼터 게이트 ─────────────────────────────────────────────

/**
 * 쿼터 쿨다운이 남아 있으면 그 해제 시각(ms)을, 아니면 null 을 돌려준다.
 *
 * ChatGPT 한도는 계정 단위라 PR 하나가 막히면 나머지도 막힌다. 그래도 큐를
 * 버리지는 않는다 — 대상들은 REVIEW_DUE 로 남고, 이 시각이 지나면 우선순위
 * 그대로 재개된다. watch 를 껐다 켜도 컨텍스트에서 다시 복원된다.
 */
export function quotaGateUntil(contexts: PRContext[], now = Date.now()): number | null {
  let until = 0;
  for (const c of contexts) {
    if (c.state !== 'QUOTA_BLOCKED' || !c.quotaRetryAt) continue;
    const at = Date.parse(c.quotaRetryAt);
    if (Number.isFinite(at) && at > now) until = Math.max(until, at);
  }
  return until > 0 ? until : null;
}

/** ms 를 '3분 12초' 같은 대기 시간 표기로. */
export function formatWaiting(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}초`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}시간 ${min % 60}분`;
  return `${Math.floor(hour / 24)}일 ${hour % 24}시간`;
}
