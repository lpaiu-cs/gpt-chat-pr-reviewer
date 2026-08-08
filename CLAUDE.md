# gpt-chat-pr-reviewer

ChatGPT 웹 대화창(Playwright)을 이용하여 GitHub PR을 자동으로 리뷰하는 CLI 도구.
API 토큰 대신 ChatGPT Plus/Team 구독의 대화 한도를 소비하여 비용을 절약한다.
Codex 자동 리뷰를 모방한 **상태 머신 기반** 리뷰 라이프사이클을 제공한다.

## 스택

- **TypeScript + Node 22** — `tsx` 로 dev 실행, `tsc` 로 빌드
- **Playwright** (channel: 'chrome') — 시스템 Chrome 의 영속 프로필 재사용
- **Commander** — CLI 프레임워크
- **gh CLI** — GitHub PR 조회·diff·리뷰 게시·GraphQL 스레드 동기화

## 디렉터리 구조

```
src/
  cli.ts            — CLI 진입점 (setup/init/instructions/review/watch/status/graph/rounds)
  state/
    machine.ts      — 상태 머신: TRANSITIONS 선언 테이블 (단일 소스) + fire/canFire/toMermaid
    store.ts        — PR 컨텍스트 영속화 (data/state/<owner>__<repo>__<n>.json)
  reviewer.ts       — 오케스트레이션: syncPR(동기화→이벤트 발화) + runRound(리뷰 실행)
  chatgpt.ts        — ChatGPT Playwright 드라이버 + QuotaLimitError 감지
  github.ts         — gh CLI 래퍼 (PR 정보·diff·게시·GraphQL reviewThreads)
  parser.ts         — GPT 응답 → ReviewResult 파서
  poster.ts         — ReviewResult → GitHub 인라인 코멘트 게시
  instructions.ts   — 맞춤 지침 파일 (instructions.md → {{instructions}} 주입)
  config.ts         — 설정 로드/저장 (pr-review.config.json)
  types.ts          — 공유 타입 (PRState/PREvent/PRContext 포함)
scripts/
  smoke-machine.ts  — 상태 머신 스모크 테스트 (npm run smoke)
```

## 상태 머신

전이 테이블은 `src/state/machine.ts` 의 `TRANSITIONS` 하나로만 정의된다.
상태 추가·수정 시 이 테이블만 바꾸면 실행·검증·mermaid 시각화가 모두 따라온다.

```
REVIEW_DUE ─ START_REVIEW → REVIEWING ─ POSTED_COMMENTS → AWAITING_AUTHOR
                              │ POSTED_CLEAN → CONVERGED (수렴)
                              │ QUOTA_EXCEEDED → QUOTA_BLOCKED ─ COOLDOWN_ELAPSED → REVIEW_DUE
                              └ REVIEW_FAILED → ERROR ─ RETRY → REVIEW_DUE
AWAITING_AUTHOR ─ AUTHOR_RESPONDED(새 커밋 or 전체 resolve) → REVIEW_DUE
CONVERGED ─ NEW_COMMITS → REVIEW_DUE
모든 상태 ─ PR_CLOSED → CLOSED (terminal)
```

PR별 컨텍스트(`PRContext`)에 라운드 수·요청 코멘트 수·스레드별 resolve/답글 여부·
쿼터 해제 시각·전체 이벤트 히스토리가 기록된다. `status --json` 이 UI 연동 포인트.

## 핵심 흐름

1. `setup` → Chrome 영속 프로필로 ChatGPT 수동 로그인 (1회)
2. `watch` → 레포 폴링 → `syncPR` 이 GitHub 현황(스레드 resolve·head SHA·닫힘)을
   상태 머신 이벤트로 변환 → `REVIEW_DUE` 인 PR 만 `runRound` 실행
3. `runRound` → 새 대화 → 프롬프트(맞춤 지침 + 이전 라운드 스레드 현황 포함) 전송
   → 응답 JSON 파싱 → diff 대조 → 인라인 리뷰 게시 → 스레드 동기화 → 상태 전이

## 빌드 & 실행

```sh
npm install
npm run smoke        # 상태 머신 테스트
npm run dev -- init  # 설정 + instructions.md 생성
npm run dev -- review <pr-url> [--dry-run|--force]
npm run dev -- watch [--once|--headless]
npm run dev -- status [pr] [--json]
npm run dev -- graph [pr]   # mermaid 다이어그램
```

## 설정

- `pr-review.config.json` — `init` 으로 생성. ChatGPT DOM 변경 시 `selectors` 오버라이드.
- `instructions.md` — 맞춤 리뷰 지침. 매 프롬프트의 `{{instructions}}` 에 주입됨.

## 주의사항

- ChatGPT 셀렉터는 UI 업데이트 시 깨질 수 있음 → config 에서 오버라이드
- `headless: true` 는 서버용이지만 봇 감지에 걸릴 수 있음
- CAPTCHA 발생 시 수동 해결 필요 (자동 우회 미구현)
- 쿼터 한도 감지 시 QUOTA_BLOCKED 로 전이, `quotaCooldownMs` (기본 3시간) 후 자동 재개
