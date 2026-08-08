import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import type { AppConfig, ChatGPTSelectors } from './types.js';

const CONFIG_FILE = 'pr-review.config.json';

// ── 기본 셀렉터 (ChatGPT DOM 변경 시 여기를 수정) ─────────

const DEFAULT_SELECTORS: ChatGPTSelectors = {
  textInput: '#prompt-textarea',
  sendButton: 'button[data-testid="send-button"]',
  assistantMessage: '[data-message-author-role="assistant"]',
  messageContent: '.markdown',
  newChatButton: 'a[data-discover="true"]',
  loggedInIndicator: '#prompt-textarea',
};

// ── 기본 프롬프트 ───────────────────────────────────────────
// 치환 변수: {{instructions}} {{url}} {{round}} {{previous}}

const DEFAULT_PROMPT = `{{instructions}}

다음 GitHub Pull Request의 {{round}}차 리뷰를 진행해주세요.

PR URL: {{url}}

{{previous}}

## 요청사항
- PR의 변경사항을 꼼꼼히 검토해주세요.
- 코드 품질, 버그 가능성, 보안 이슈, 성능 문제를 확인해주세요.
- 1차 리뷰면 전체를 검토하고, 2차 이상이면 이전 코멘트 반영 여부와 새 변경사항 위주로 검토해주세요.
- 결과를 반드시 아래 JSON 형식으로만 응답해주세요.

## 응답 형식 (JSON만 출력, 다른 텍스트 없이)

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

## 규칙
- path: PR에 표시된 정확한 파일 경로
- line: 변경된 파일의 새 버전(+쪽) 라인 번호
- comments가 없으면 빈 배열 []
- 버그/보안 이슈가 있으면 approval을 "request_changes"로
- 개선 제안만 있으면 "comment"
- 더 지적할 문제가 없으면 "approve" (리뷰 수렴)
- 한국어로 작성`;

// ── 기본 설정 ───────────────────────────────────────────────

const DEFAULT_CONFIG: AppConfig = {
  browserProfileDir: './browser-profile',
  headless: false,
  browserChannel: 'chrome',
  chatgptUrl: 'https://chatgpt.com',
  responseTimeoutMs: 300_000, // 5분
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
