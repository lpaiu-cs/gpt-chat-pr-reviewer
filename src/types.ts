// ── PR & Review 데이터 ──────────────────────────────────────

export interface ReviewComment {
  path: string;
  line: number;
  body: string;
}

export interface ReviewResult {
  summary: string;
  approval: 'approve' | 'request_changes' | 'comment';
  comments: ReviewComment[];
  /** ChatGPT 원본 응답 전문 */
  raw: string;
  /** JSON 추출·파싱 성공 여부. false 면 게시해서는 안 된다. */
  parsed: boolean;
}

export interface PRInfo {
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  author: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
}

export interface DiffHunk {
  path: string;
  /** diff 의 new-side 에 존재하는 라인 번호 집합 */
  lines: Set<number>;
}

// ── 상태 머신 ───────────────────────────────────────────────

/**
 * PR 리뷰 라이프사이클 상태.
 *
 *  REVIEW_DUE      — 리뷰 실행 대기 (신규 발견 or 다음 라운드 준비 완료)
 *  REVIEWING       — ChatGPT 리뷰 진행 중 (transient)
 *  AWAITING_AUTHOR — 코멘트 게시 완료, 작성자 응답(커밋/resolve) 대기
 *  CONVERGED       — 리뷰 수렴 (approve) — 새 커밋 발생 시 재개
 *  QUOTA_BLOCKED   — ChatGPT 사용량 한도 — 쿨다운 후 재개
 *  ERROR           — 실패 — 재시도 대기
 *  CLOSED          — PR 닫힘/머지 (terminal)
 */
export type PRState =
  | 'REVIEW_DUE'
  | 'REVIEWING'
  | 'AWAITING_AUTHOR'
  | 'CONVERGED'
  | 'QUOTA_BLOCKED'
  | 'ERROR'
  | 'CLOSED';

export type PREvent =
  | 'START_REVIEW'
  | 'POSTED_COMMENTS'
  | 'POSTED_CLEAN'
  | 'AUTHOR_RESPONDED'
  | 'NEW_COMMITS'
  | 'QUOTA_EXCEEDED'
  | 'COOLDOWN_ELAPSED'
  | 'REVIEW_FAILED'
  | 'RETRY'
  | 'PR_CLOSED';

/** 우리가 게시한 리뷰 스레드 1개의 추적 레코드. */
export interface ThreadRecord {
  id: string;
  path: string;
  line: number | null;
  isResolved: boolean;
  /** 우리(리뷰어) 외 다른 사용자의 답글 존재 여부 */
  authorReplied: boolean;
  /** 게시된 리뷰 라운드 (best effort) */
  round: number;
  /** 첫 코멘트 앞부분 */
  snippet: string;
  /**
   * 첫 코멘트 **본문 전체**의 지문 — 같은 지적을 두 번 게시하지 않기 위한 것.
   *
   * snippet 으로는 판별할 수 없다 (80자까지만 남기므로 뒷부분이 다른 지적도
   * 같아 보인다). 본문을 통째로 들고 있으면 상태 파일이 리뷰 본문만큼 커지므로
   * 지문만 남긴다. 구버전 컨텍스트에는 없다 — 다음 동기화에서 채워진다.
   */
  digest?: string;
}

export interface EventRecord {
  at: string;
  event: PREvent;
  from: PRState;
  to: PRState;
  note?: string;
}

/** PR 1개에 대한 영속 상태 컨텍스트 — data/state/<owner>__<repo>__<n>.json */
export interface PRContext {
  prUrl: string;
  owner: string;
  repo: string;
  prNumber: number;
  title: string;
  /** PR 작성자 — 셀프 리뷰 판별에 쓰인다 (구버전 컨텍스트에는 없을 수 있음) */
  author?: string;
  state: PRState;
  /** 완료된 리뷰 라운드 수 */
  round: number;
  /** 누적 요청(인라인 코멘트) 개수 */
  requestedCount: number;
  /** 마지막 리뷰 시점의 head SHA — 새 커밋 감지 기준 */
  headShaAtLastReview: string | null;
  /**
   * 마지막 리뷰 시점의 base ref — **base 변경 감지 기준**.
   *
   * 리뷰 대상은 `base...head` 다. base 를 main → release 로 바꾸면 head 가
   * 그대로여도 다른 코드인데, head 만 추적하면 그 변경이 영영 감지되지 않아
   * 검토한 적 없는 diff 가 approve 하나로 CONVERGED 에 눌러앉는다.
   * 구버전 컨텍스트에는 없다 (없으면 판정하지 않는다).
   */
  baseRefAtLastReview?: string | null;
  threads: ThreadRecord[];
  /**
   * 이 PR 에서 관측한 **모든** 리뷰 스레드 id (남이 만든 것 포함).
   * probe 는 스레드 소유자를 알 수 없으므로, 이 목록이 없으면 남의 스레드가
   * 매 tick "미지" 로 판정되어 전체 동기화를 무한히 유발한다.
   */
  knownThreadIds?: string[];
  /**
   * 이 PR 의 라운드를 이어가는 ChatGPT 대화 URL (https://chatgpt.com/c/<uuid>).
   *
   * 상태가 아니라 실행기 사정이다 — 상태 머신(TRANSITIONS)에는 관여하지 않는다.
   * 미수렴 동안만 유지하고 CONVERGED·CLOSED 에서 해제한다.
   */
  conversationUrl?: string;
  /**
   * 위 대화를 만든 시점의 라운드 번호 (1-based).
   * 대화 누적 라운드 수(= round - conversationStartRound)와,
   * "어떤 스레드가 그 대화 안에 이미 있는지" 를 함께 판정하는 기준이다.
   */
  conversationStartRound?: number;
  /**
   * 위 대화에 **실제로 전송한 프롬프트 수**. 회전 판정의 기준이다.
   *
   * 완료된 라운드로 세면 안 된다 — 파싱·게시가 실패하면 ctx.round 는 늘지 않지만
   * 프롬프트와 응답은 이미 대화에 쌓여 있다. 라운드 기준이면 자동 재시도가
   * 컨텍스트 보호 상한을 그대로 우회한다.
   *
   * conversationUrl 과 짝을 이룰 때만 의미가 있다. URL 없이 남아 있는 값은 주소를
   * 확보하지 못한 채 끝난 대화의 잔여물이며, 다음 전송에서 버려진다(countTurn).
   */
  conversationTurns?: number;
  /**
   * **응답을 기다리는 중인 전송** — 어느 라운드를, 어느 head SHA 를 보고 물었는지.
   *
   * 대기 구간이 2~15분이라 그 사이에 죽으면 질문만 대화에 남는다. 재시작 후 그
   * 응답을 회수(reclaim)하려면 "이 답이 지금 코드에 대한 답인가" 를 알아야 한다.
   * 대화 + 라운드 번호만으로는 알 수 없다 — 죽어 있는 동안 작성자가 push 하면
   * 낡은 head 를 보고 만든 답을 회수하고, 게시 후에는 **현재** head 를
   * `headShaAtLastReview` 로 적어버려 검토한 적 없는 커밋이 CONVERGED 가 된다.
   *
   * head 만으로는 부족하다. 리뷰 대상 diff 는 `base...head` 라서 **base 가 바뀌면
   * head 가 같아도 다른 코드**다 (main → release 로 base 변경). 그래서 base ref 도
   * 함께 남긴다.
   *
   * 응답을 확보하면 지운다. 없거나 대상이 달라졌으면 회수하지 않고 다시 묻는다.
   */
  pendingSend?: {
    round: number;
    headSha: string | null;
    baseRef?: string | null;
    /** 전송 시각 (ISO) — "이 전송이 이미 답을 받았는가" 를 라운드가 아니라 전송 단위로 본다 */
    at?: string;
  };
  /**
   * 감시 필터에 걸려 큐에서 빠진 사유 (draft 로 되돌림·라벨 제거 등).
   * 관측된 GitHub 현황을 캐시한 것일 뿐 상태가 아니다 — 필터를 통과하면 지워진다.
   * 이게 없으면 `queue` 명령이 watch 가 실제로 돌리지 않을 PR 까지 보여준다.
   */
  excludedReason?: string;
  retryCount: number;
  lastError?: string;
  /** QUOTA_BLOCKED 해제 예정 시각 (ISO) */
  quotaRetryAt?: string;
  /**
   * 마지막으로 **전체** 동기화(fetchPRSyncData)를 돈 시각 (ISO).
   * probe 가 볼 수 없는 변화(코멘트 숨김 등)를 주기적으로 잡기 위한 기준이다.
   */
  lastFullSyncAt?: string;
  history: EventRecord[];
  createdAt: string;
  updatedAt: string;
}

// ── 설정 ────────────────────────────────────────────────────

export interface ChatGPTSelectors {
  /** 프롬프트 입력 영역 */
  textInput: string;
  /** 전송 버튼 */
  sendButton: string;
  /** 생성 중지 버튼 — 존재하면 아직 스트리밍 중이라는 신호 */
  stopButton: string;
  /** 어시스턴트 메시지 컨테이너 */
  assistantMessage: string;
  /** 어시스턴트 메시지 안의 본문(마크다운) 영역 */
  messageContent: string;
  /** 새 대화 시작 링크/버튼 */
  newChatButton: string;
  /** 로그인 완료 판별용 요소 */
  loggedInIndicator: string;
}

// ── 감시 범위 ───────────────────────────────────────────────

/** 수집한 PR 을 리뷰 큐에 올릴지 거르는 조건. 여러 개면 AND 로 적용된다. */
export interface WatchFilters {
  /** 지정 시 이 작성자들의 PR 만 (대소문자 무시) */
  authors?: string[];
  /** 지정 시 이 라벨을 하나라도 가진 PR 만 */
  labels?: string[];
  /** true 면 draft PR 도 리뷰한다. 기본값 false = 초안 제외 */
  draft?: boolean;
  /**
   * 개별 제외 목록 — `'owner/repo#12'` 형식 (대소문자 무시).
   *
   * authors/labels/draft 로는 "이 PR 만 빼기" 를 표현할 수 없다. 오래돼서 지금은
   * 리뷰받고 싶지 않은 PR 을 감시 범위를 좁히지 않고 골라낼 때 쓴다.
   * 이미 추적 중이던 PR 도 다음 스캔에서 큐에서 빠진다 (excludedReason 이 붙는다).
   */
  skip?: string[];
  /**
   * 리뷰 대상을 이 PR 들로만 한정한다 — `'owner/repo#12'` 형식 (대소문자 무시).
   * 비어 있거나 없으면 제한하지 않는다.
   *
   * `skip` 의 반대다. 여러 PR 중 하나만 돌려보고 싶을 때 나머지를 일일이 skip 에
   * 적는 대신 쓴다. **감시 자체를 좁히지는 않는다** — 이미 추적 중인 PR 은 계속
   * 동기화되고 대시보드에도 남는다. 큐에만 오르지 않는다.
   *
   * 같은 PR 이 skip 에도 있으면 skip 이 이긴다 ("확실히 하지 말 것" 이 우선).
   */
  only?: string[];
}

/**
 * 감시 대상 레포를 정하는 방식.
 *
 *  account          — 계정/조직 전체를 검색해 열린 PR 이 있는 레포를 자동 발견
 *  repos            — include 에 적은 owner/repo 만 (글롭 불가)
 *  review-requested — 현재 gh 계정에 리뷰가 요청된 PR 이 있는 레포만
 */
export type WatchMode = 'account' | 'repos' | 'review-requested';

/** 감시 범위 정의 — pr-review.config.json 의 `watch` 블록. */
export interface WatchScope {
  mode: WatchMode;
  /**
   * 감시 대상. 'owner/repo' 또는 글롭('owner/*', '*&#47;service-*').
   * 슬래시가 없으면 'owner' 를 'owner/*' 로 해석한다.
   * 비어 있으면 (review-requested 모드) 검색 결과 전체를 받는다.
   */
  include: string[];
  /** include 에 걸린 것 중 제외할 글롭 */
  exclude?: string[];
  filters?: WatchFilters;
  /** 레포 재탐색 주기 (ms) — account/review-requested 모드에서만 쓰인다 */
  discoveryIntervalMs?: number;
}

export interface AppConfig {
  /** Playwright persistent-context 가 사용할 Chrome 프로필 경로 */
  browserProfileDir: string;
  /** true 면 헤드리스 실행 (서버용) */
  headless: boolean;
  /** Playwright channel — 'chrome' = 시스템 Chrome, 'chromium' = Playwright 내장 */
  browserChannel: string;
  chatgptUrl: string;
  /** 응답 대기 최대 시간 (ms) */
  responseTimeoutMs: number;
  selectors: ChatGPTSelectors;
  /** {{instructions}}, {{url}}, {{round}}, {{previous}} 치환 */
  promptTemplate: string;
  /** 맞춤 지침 파일 경로 — 내용이 {{instructions}} 에 주입됨 */
  customInstructionsFile: string;
  /** 쿼터 한도 도달 시 재시도까지 대기 시간 (ms) */
  quotaCooldownMs: number;
  /** ERROR 상태 자동 재시도 최대 횟수 */
  maxAutoRetries: number;
  /**
   * 대화 1개에 전송할 최대 프롬프트 수. 초과하면 새 대화로 전환한다.
   * 전송마다 PR diff 전문이 대화에 쌓이므로 무한히 이어 붙일 수 없다.
   * 실패해 다시 보낸 것도 대화에는 남으므로 함께 센다 (완료 라운드 수가 아니다).
   */
  maxTurnsPerConversation: number;
  /** watch 모드 폴링 간격 (ms) */
  watchIntervalMs: number;
  /**
   * 스레드 resolve 를 기다리지 않는 레포의 probe 주기 (ms).
   *
   * probe 는 **레포당** 1 point 라 비용이 레포 수에 선형 비례한다 (실측: PR 개수·
   * 스레드 alias 와 무관하게 항상 1). 그런데 10초라는 촘촘한 주기가 필요한 건
   * `AWAITING_AUTHOR` PR 하나뿐이다 — 작성자가 방금 응답했고 사람이 결과를
   * 기다리는 상태다. 나머지 레포는 이 주기로 늦춘다.
   */
  probeIdleIntervalMs: number;
  /**
   * PR 1건의 전체 동기화 주기 (ms) — probe 가 볼 수 없는 변화를 잡는 안전망.
   *
   * probe 는 스레드의 id·resolve 만 본다. 사람이 코멘트를 **숨겨도** 아는
   * 스레드만 있으면 "변화 없음" 이라 보고하므로, 숨김은 이 주기가 아니면
   * 반영되지 않는다. PR 당 1 point 라 20개를 봐도 시간당 120 point 다.
   */
  fullSyncIntervalMs: number;
  /**
   * watch 대상 레포 목록 ('owner/repo') — 구버전 설정.
   * `watch.include` 가 비어 있을 때의 폴백으로만 쓰인다.
   */
  watchRepos: string[];
  /** 감시 범위 — 계정 단위 자동 발견 + 글롭 + 필터 */
  watch?: WatchScope;
  /** 상태·기록 저장 디렉터리 */
  dataDir: string;
}
