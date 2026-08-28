import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import type { AppConfig, ChatGPTSelectors, WatchScope } from './types.js';

const CONFIG_FILE = 'pr-review.config.json';

// ── 기본 셀렉터 (ChatGPT DOM 변경 시 여기를 수정) ─────────

const DEFAULT_SELECTORS: ChatGPTSelectors = {
  textInput: '#prompt-textarea',
  sendButton: 'button[data-testid="send-button"]',
  stopButton: 'button[data-testid="stop-button"], button[aria-label*="Stop"]',
  assistantMessage: '[data-message-author-role="assistant"]',
  messageContent: '.markdown',
};

// ── 기본 프롬프트 ───────────────────────────────────────────
// 치환 변수: {{instructions}} {{url}} {{round}} {{previous}}

const DEFAULT_PROMPT = `당신은 코드 리뷰어입니다. 아래 GitHub Pull Request를 직접 열어 읽고, 리뷰 결과를 JSON 하나로만 출력하세요.

## 대상 PR
{{url}}
리뷰 라운드: {{round}}차

## 작업 절차
1. 위 URL의 PR을 열어 변경된 파일과 diff를 실제로 확인합니다.
2. 버그 가능성, 보안 이슈, 성능 문제, 코드 품질을 검토합니다.
3. 1차 리뷰면 변경사항 전체를, 2차 이상이면 이전 코멘트의 반영 여부와 새 변경사항을 중심으로 봅니다.
4. 결과를 맨 아래 "출력 형식"의 JSON 하나로만 작성합니다.

**PR에 접근할 수 없다면** (권한 없음·URL 접근 실패 등) 추측해서 리뷰하지 말고,
summary를 정확히 \`ACCESS_FAILED\` 로, comments를 빈 배열로 출력하세요.
{{previous}}
{{instructions}}

## 출력 형식
JSON 코드블록 **하나만** 출력하세요. 인사말·해설·요약 문서·후속 제안은 출력하지 마세요.

\`\`\`json
{
  "summary": "전체 리뷰 요약",
  "approval": "approve 또는 request_changes 또는 comment",
  "comments": [
    {
      "path": "src/example.ts",
      "line": 42,
      "body": "구체적인 리뷰 코멘트"
    }
  ]
}
\`\`\`

## 필드 규칙
- \`path\`: PR에 표시된 정확한 파일 경로
- \`line\`: 변경된 파일의 새 버전(+쪽) 라인 번호
- \`comments\`: 지적할 내용이 없으면 빈 배열 \`[]\`
- \`approval\`: 버그·보안 이슈가 있으면 \`request_changes\`, 개선 제안만 있으면 \`comment\`,
  더 지적할 문제가 없으면 \`approve\` (리뷰 수렴)
- 코멘트 본문은 한국어로 작성`;

// ── 기본 설정 ───────────────────────────────────────────────

const DEFAULT_CONFIG: AppConfig = {
  browserProfileDir: './browser-profile',
  headless: false,
  browserChannel: 'chrome',
  chatgptUrl: 'https://chatgpt.com',
  responseTimeoutMs: 900_000, // 15분 — 추론 모드 + 커넥터 탐색은 오래 걸린다
  selectors: DEFAULT_SELECTORS,
  promptTemplate: DEFAULT_PROMPT,
  customInstructionsFile: './instructions.md',
  quotaCooldownMs: 3 * 60 * 60_000, // 3시간
  maxAutoRetries: 2,
  // 전송마다 diff 가 대화에 쌓이므로 무한 연장은 불가하다. 다만 회전은 공짜가 아니다 — 새 대화는
  // 이전 지적을 스니펫으로만 받으므로 같은 곳을 다시 집거나 고친 맥락을 놓친다.
  // 실측 라운드 하나의 diff 는 수십 KB 이라 10회까지는 한도 안에 들어간다.
  maxTurnsPerConversation: 10,
  // 순차 처리 (ChatGPT 한도를 아껴 쓴다). 2·5·0(제한 없음) 으로 올릴 수 있다.
  maxConcurrentReviews: 1,
  watchIntervalMs: 10_000, // 10초 — 스캔 1회 = 레포당 1 point 이므로 부담이 없다
  // 레포 20개면 10초 주기 probe 가 시간당 7,200 point 로 한도(5,000)를 넘는다.
  // resolve 를 기다리는 레포만 10초로 두고 나머지는 이 주기로 늦춘다.
  probeIdleIntervalMs: 60_000,
  // 숨김처럼 probe 가 못 보는 변화의 반영 지연 상한. PR 당 1 point 짜리 조회다.
  fullSyncIntervalMs: 10 * 60_000,
  watchRepos: [],
  dataDir: './data',
};

/** init 이 써 넣는 감시 범위 스켈레톤 — include 만 채우면 바로 돈다. */
const DEFAULT_WATCH_SCOPE: WatchScope = {
  mode: 'account',
  include: [], // 예: ['myorg/*', 'owner/repo']
  exclude: [],
  filters: { draft: false },
};

// ── 공개 API ────────────────────────────────────────────────

export function loadConfig(configPath?: string): AppConfig {
  const file = configPath ?? CONFIG_FILE;
  if (existsSync(file)) {
    const raw = readFileSync(file, 'utf-8');
    let user: Partial<AppConfig>;
    try {
      user = JSON.parse(raw);
    } catch {
      // patchConfigFile 과 같은 실패 철학 — 깨진 파일을 조용히 무시하면
      // 기본값으로 돌아가 사용자 설정이 사라진 것처럼 동작한다.
      throw new Error(
        `${file} 을 읽을 수 없습니다 (JSON 형식 오류) — 파일을 고치거나 지운 뒤 init 으로 다시 만들어주세요.`,
      );
    }
    return {
      ...DEFAULT_CONFIG,
      ...user,
      selectors: { ...DEFAULT_SELECTORS, ...(user.selectors ?? {}) },
    };
  }
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(config: Partial<AppConfig>, configPath?: string): void {
  const file = configPath ?? CONFIG_FILE;
  writeFileSync(file, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * 설정 파일에서 **지정한 키만** 갈아 끼운다 (나머지는 원본 그대로).
 *
 * `saveConfig(loadConfig())` 로 저장하면 안 된다 — loadConfig 는 기본값을 합쳐서
 * 돌려주므로, 그대로 쓰면 60줄짜리 프롬프트 템플릿과 셀렉터·타임아웃 기본값이
 * 전부 사용자 설정 파일에 박제된다. 그러면 (1) 손으로 관리하던 간결한 파일이
 * 부풀고 (2) 이후 기본값이 개선돼도 그 파일이 옛 값을 고정해 버린다.
 *
 * UI 에서 설정을 바꾸는 경로는 반드시 이쪽을 쓴다.
 */
export function patchConfigFile(patch: Partial<AppConfig>, configPath?: string): void {
  const file = configPath ?? CONFIG_FILE;
  let raw: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, 'utf-8'));
    } catch {
      // 손상된 파일을 조용히 덮어써서 사용자 설정을 날리지 않는다.
      throw new Error(`${file} 을 읽을 수 없습니다 (JSON 형식 오류) — 저장을 중단합니다.`);
    }
  }
  writeFileSync(file, JSON.stringify({ ...raw, ...patch }, null, 2), 'utf-8');
}

/** config.json 의 스켈레톤을 생성한다 (이미 있으면 스킵). */
export function initConfig(configPath?: string): string {
  const file = configPath ?? CONFIG_FILE;
  if (existsSync(file)) return file;
  const skeleton: Partial<AppConfig> = {
    browserProfileDir: DEFAULT_CONFIG.browserProfileDir,
    headless: false,
    browserChannel: 'chrome',
    customInstructionsFile: DEFAULT_CONFIG.customInstructionsFile,
    quotaCooldownMs: DEFAULT_CONFIG.quotaCooldownMs,
    maxTurnsPerConversation: DEFAULT_CONFIG.maxTurnsPerConversation,
    watch: DEFAULT_WATCH_SCOPE,
    watchRepos: [],
    watchIntervalMs: DEFAULT_CONFIG.watchIntervalMs,
  };
  saveConfig(skeleton, file);
  return file;
}

export function ensureDataDir(config: AppConfig): void {
  if (!existsSync(config.dataDir)) {
    mkdirSync(config.dataDir, { recursive: true });
  }
}
