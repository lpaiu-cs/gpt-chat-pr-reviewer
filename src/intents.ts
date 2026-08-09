/**
 * 제어 의도 큐 — UI 의 POST 와 watch 루프 사이의 완충 지대.
 *
 * 대시보드를 읽기 전용으로 만들 때 정해둔 규칙이다: **POST 는 상태를 직접
 * 건드리지 않는다.** 라운드 하나가 2~15분 동안 PRContext 와 감시 범위를 붙잡고
 * 도는데, HTTP 핸들러가 그 사이에 끼어들어 필터를 바꾸면 스캔이 반쯤 낡은 기준으로
 * 판정하거나 저장 중인 컨텍스트를 덮어쓴다. 그래서 요청은 여기 쌓아두기만 하고,
 * 루프가 **사이클 시작점**(스캔 직전 · 라운드가 돌지 않는 시점)에서 한 번에 꺼내
 * 적용한다.
 *
 * 이 모듈은 progress.ts 와 짝을 이루는 리프다 — 관측은 밖으로, 의도는 안으로
 * 흐르고 둘 다 http·config·상태 머신을 모른다.
 */

/** `'owner/repo#12'` 형식의 PR 참조. 검증은 소비하는 쪽(watch-scope)이 한다. */
export type Intent =
  | { kind: 'skip-add'; ref: string }
  | { kind: 'skip-remove'; ref: string }
  /** 빈 배열이면 한정 해제 */
  | { kind: 'only-set'; refs: string[] }
  | { kind: 'scope-set'; include: string[]; exclude: string[] }
  /** 큐 맨 앞으로. REVIEW_DUE 가 아니면 강제 전이시킨다 (review --force 와 같은 경로) */
  | { kind: 'review-now'; ref: string }
  | { kind: 'pause' }
  | { kind: 'resume' };

export const INTENT_KINDS: Intent['kind'][] = [
  'skip-add',
  'skip-remove',
  'only-set',
  'scope-set',
  'review-now',
  'pause',
  'resume',
];

class IntentQueue {
  private q: Intent[] = [];

  /** 큐에 넣고 대기 건수를 돌려준다. */
  push(intent: Intent): number {
    this.q.push(intent);
    return this.q.length;
  }

  /** 쌓인 의도를 모두 꺼내 비운다. 루프의 안전 지점에서만 호출한다. */
  drain(): Intent[] {
    const out = this.q;
    this.q = [];
    return out;
  }

  /** 아직 적용되지 않은 건수 — 라운드가 길면 UI 가 "대기 중" 을 보여줘야 한다. */
  get pending(): number {
    return this.q.length;
  }
}

export const intents = new IntentQueue();
