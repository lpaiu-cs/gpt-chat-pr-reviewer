import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import type { AppConfig, ChatGPTSelectors } from './types.js';

const CONFIG_FILE = 'pr-review.config.json';

// ── 기본 셀렉터 (ChatGPT DOM 변경 시 여기를 수정) ─────────

const DEFAULT_SELECTORS: ChatGPTSelectors = {
  textInput: '#prompt-textarea',
  sendButton: 'button[data-testid="send-button"]',
  stopButton: 'button[data-testid="stop-button"], button[aria-label*="Stop"]',
  assistantMessage: '[data-message-author-role="assistant"]',
  messageContent: '.markdown',
  newChatButton: 'a[data-discover="true"]',
  loggedInIndicator: '#prompt-textarea',
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
  watchIntervalMs: 300_000, // 5분
  watchRepos: [],
  dataDir: './data',
};

// ── 공개 API ────────────────────────────────────────────────

export function loadConfig(configPath?: string): AppConfig {
  const file = configPath ?? CONFIG_FILE;
  if (existsSync(file)) {
    const raw = readFileSync(file, 'utf-8');
    const user: Partial<AppConfig> = JSON.parse(raw);
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
