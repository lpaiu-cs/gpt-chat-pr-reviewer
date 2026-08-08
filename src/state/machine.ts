/**
 * PR 리뷰 상태 머신.
 *
 * 상태 전이는 TRANSITIONS 선언 테이블 하나로만 정의된다.
 * 실행(fire) · 검증(canFire) · 시각화(toMermaid) 가 전부 이 테이블에서
 * 파생되므로, 상태/이벤트를 추가·수정할 때 이 파일만 바꾸면 된다.
 *
 *                    ┌──────────── COOLDOWN_ELAPSED ────────────┐
 *                    │                                          │
 *   [*] ─▶ REVIEW_DUE ─ START_REVIEW ─▶ REVIEWING ─ QUOTA ─▶ QUOTA_BLOCKED
 *              ▲  ▲                       │    │
 *              │  │                POSTED_COMMENTS  POSTED_CLEAN
 *              │  │                       ▼    ▼
 *              │  └─ AUTHOR_RESPONDED ─ AWAITING_AUTHOR   CONVERGED
 *              └──────── NEW_COMMITS ─────────────────────────┘
 *
 *   모든 상태 ─ PR_CLOSED ─▶ CLOSED (terminal)
 */

import type { PRState, PREvent, PRContext, EventRecord } from '../types.js';

// ── 전이 테이블 (단일 소스) ─────────────────────────────────

export const TRANSITIONS: Record<PRState, Partial<Record<PREvent, PRState>>> = {
  REVIEW_DUE: {
    START_REVIEW: 'REVIEWING',
    PR_CLOSED: 'CLOSED',
  },
  REVIEWING: {
    POSTED_COMMENTS: 'AWAITING_AUTHOR',
    POSTED_CLEAN: 'CONVERGED',
    QUOTA_EXCEEDED: 'QUOTA_BLOCKED',
    REVIEW_FAILED: 'ERROR',
    PR_CLOSED: 'CLOSED',
  },
  AWAITING_AUTHOR: {
    AUTHOR_RESPONDED: 'REVIEW_DUE',
    PR_CLOSED: 'CLOSED',
  },
  CONVERGED: {
    NEW_COMMITS: 'REVIEW_DUE',
    PR_CLOSED: 'CLOSED',
  },
  QUOTA_BLOCKED: {
    COOLDOWN_ELAPSED: 'REVIEW_DUE',
    PR_CLOSED: 'CLOSED',
  },
  ERROR: {
    RETRY: 'REVIEW_DUE',
    PR_CLOSED: 'CLOSED',
  },
  CLOSED: {},
};

export const STATE_LABELS: Record<PRState, string> = {
  REVIEW_DUE: '리뷰 대기',
  REVIEWING: '리뷰 진행 중',
  AWAITING_AUTHOR: '작성자 응답 대기',
  CONVERGED: '리뷰 수렴',
  QUOTA_BLOCKED: '쿼터 제한',
  ERROR: '오류',
  CLOSED: '종료',
};

/** 상태별 다음 액션 힌트 (status 명령 표시용). */
export const NEXT_ACTION_HINTS: Record<PRState, string> = {
  REVIEW_DUE: '다음 리뷰 라운드 실행 대기 (watch 가 자동 처리)',
  REVIEWING: '리뷰 진행 중 — 완료 대기',
  AWAITING_AUTHOR: '작성자의 커밋 push 또는 스레드 resolve 대기',
  CONVERGED: '수렴 완료 — 새 커밋 발생 시 자동 재개',
  QUOTA_BLOCKED: '쿼터 쿨다운 대기 후 자동 재시도',
  ERROR: '자동 재시도 대기 (또는 review --force)',
  CLOSED: '종료됨 — 추가 액션 없음',
};

// ── 실행 ────────────────────────────────────────────────────

export class IllegalTransitionError extends Error {
  constructor(state: PRState, event: PREvent) {
    super(`잘못된 전이: ${state} 상태에서 ${event} 이벤트는 허용되지 않습니다`);
    this.name = 'IllegalTransitionError';
  }
}

export function canFire(state: PRState, event: PREvent): boolean {
  return TRANSITIONS[state]?.[event] !== undefined;
}

/**
 * 이벤트를 발화하여 상태를 전이한다.
 * patch 는 전이 직후 컨텍스트에 병합된다 (round 증가 등).
 * 모든 전이는 history 에 기록된다.
 */
export function fire(
  ctx: PRContext,
  event: PREvent,
  opts?: { note?: string; patch?: Partial<PRContext> },
): PRContext {
  const to = TRANSITIONS[ctx.state]?.[event];
  if (!to) throw new IllegalTransitionError(ctx.state, event);

  const rec: EventRecord = {
    at: new Date().toISOString(),
    event,
    from: ctx.state,
    to,
    note: opts?.note,
  };
  ctx.state = to;
  if (opts?.patch) Object.assign(ctx, opts.patch);
  ctx.history.push(rec);
  ctx.updatedAt = rec.at;
  return ctx;
}

// ── 시각화 ──────────────────────────────────────────────────

/** 전이 테이블을 mermaid stateDiagram 으로 렌더링 (현재 상태 강조 옵션). */
export function toMermaid(current?: PRState): string {
  const lines = ['stateDiagram-v2', '  [*] --> REVIEW_DUE'];
  for (const [from, events] of Object.entries(TRANSITIONS)) {
    for (const [ev, to] of Object.entries(events as Record<string, PRState>)) {
      lines.push(`  ${from} --> ${to}: ${ev}`);
    }
  }
  lines.push('  CLOSED --> [*]');
  if (current) {
    lines.push('  classDef current fill:#4a90d9,color:#fff,stroke:#2b6cb0');
    lines.push(`  class ${current} current`);
  }
  return lines.join('\n');
}
