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
  /**
   * 범위 **증분** 변경. `scope-set` 과 달리 나머지를 건드리지 않는다.
   *
   * 대시보드는 사람 하나가 쓰지만 스킬은 여러 세션이 동시에 쓴다. 세션 A 가
   * 자기 레포를 넣겠다고 `scope-set` 을 부르면 세션 B·C 가 넣어둔 레포가
   * 통째로 사라진다 — read-modify-write 를 클라이언트가 하게 되기 때문이다.
   * 그래서 "무엇을 원하는가"(추가/제거)를 그대로 보내게 하고 병합은 루프가 한다.
   */
  | { kind: 'scope-add'; include: string[] }
  | { kind: 'scope-remove'; include: string[] }
  /** 큐 맨 앞으로. REVIEW_DUE 가 아니면 강제 전이시킨다 (review --force 와 같은 경로) */
  | { kind: 'review-now'; ref: string }
  | { kind: 'pause' }
  | { kind: 'resume' }
  /**
   * 데몬 종료. **`INTENT_KINDS` 에 없다 — `/api/intent` 로는 들어올 수 없다.**
   * 전용 엔드포인트(`/api/shutdown`)만 만들 수 있다. 이유는 아래 참고.
   */
  | { kind: 'stop' };

/**
 * `/api/intent` 가 받아주는 종류. **의도적으로 `stop` 이 빠져 있다.**
 *
 * 이 목록이 곧 "네트워크로 부를 수 있는 것" 의 전부이고, 스킬을 쓰는 세션은
 * 여럿이다. 종료는 한 세션이 다른 세션들의 리뷰를 통째로 끊는 유일한 동작이라
 * 일반 의도와 같은 문 안에 두지 않는다. 사람이 쓰는 경로(대시보드 종료 버튼 ·
 * `stop` 명령)는 전용 엔드포인트를 지나며, 큐에 넣는 것은 똑같다 — 라운드
 * 중간에 끊지 않으려면 결국 이 완충 지대를 거쳐야 하기 때문이다.
 */
export const INTENT_KINDS: Intent['kind'][] = [
  'skip-add',
  'skip-remove',
  'only-set',
  'scope-set',
  'scope-add',
  'scope-remove',
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
