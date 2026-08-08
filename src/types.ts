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
  state: PRState;
  /** 완료된 리뷰 라운드 수 */
  round: number;
  /** 누적 요청(인라인 코멘트) 개수 */
  requestedCount: number;
  /** 마지막 리뷰 시점의 head SHA — 새 커밋 감지 기준 */
  headShaAtLastReview: string | null;
  threads: ThreadRecord[];
  retryCount: number;
  lastError?: string;
  /** QUOTA_BLOCKED 해제 예정 시각 (ISO) */
  quotaRetryAt?: string;
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
  /** 어시스턴트 메시지 컨테이너 */
  assistantMessage: string;
  /** 어시스턴트 메시지 안의 본문(마크다운) 영역 */
  messageContent: string;
  /** 새 대화 시작 링크/버튼 */
  newChatButton: string;
  /** 로그인 완료 판별용 요소 */
  loggedInIndicator: string;
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
  /** watch 모드 폴링 간격 (ms) */
  watchIntervalMs: number;
  /** watch 대상 레포 목록 ('owner/repo') */
  watchRepos: string[];
  /** 상태·기록 저장 디렉터리 */
  dataDir: string;
}
