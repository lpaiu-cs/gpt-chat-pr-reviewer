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
  cli.ts            — CLI 진입점 (setup/init/instructions/review/watch/queue/status/graph/rounds)
  state/
    machine.ts      — 상태 머신: TRANSITIONS 선언 테이블 (단일 소스) + fire/canFire/toMermaid
    store.ts        — PR 컨텍스트 영속화 (data/state/<owner>__<repo>__<n>.json). 잠금 없음
  watch-scope.ts    — 감시 범위: 글롭 include/exclude · 레포 탐색·캐시 · 대상 필터
  queue.ts          — 리뷰 큐 (컨텍스트에서 파생, 저장하지 않음) + 쿼터 게이트
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

**큐도 대화 URL 도 상태가 아니다.** 둘 다 실행기 사정이라 `TRANSITIONS` 에 넣지 않는다.

## 대화 세션

미수렴 PR 은 라운드 간 같은 ChatGPT 대화를 이어 쓴다. 대화 URL 은 **상태가 아니라
실행기 사정**이므로 `TRANSITIONS` 에 관여하지 않고 `PRContext.conversationUrl` /
`conversationStartRound` 로만 관리한다 (`reviewer.ts` 의 `planConversation` ·
`releaseConversation`). 복귀 실패 시 새 대화로 폴백하고,
`maxTurnsPerConversation` 도달 시 회전한다 (완료 라운드가 아니라 `conversationTurns`
= 실제 전송 횟수 기준 — 실패·재시도도 대화에는 쌓이므로). CONVERGED · CLOSED ·
캐시 출처 불일치(`reconcileCachedOrigin`)에서 해제.

## 리뷰 큐

리뷰 대기열은 `REVIEW_DUE` 인 컨텍스트에서 매번 파생하며 저장하지 않는다 (`queue.ts`).
`store.ts` 에 잠금이 없어 큐 파일을 따로 두면 watch 와 `queue` 명령이 같은 파일을
다툰다. 큐 대기는 GitHub 에서 관측된 PR 상태가 아니므로 `QUEUED` 같은 상태를
`TRANSITIONS` 에 추가하지 않는다.

## 핵심 흐름

1. `setup` → Chrome 영속 프로필로 ChatGPT 수동 로그인 (1회)
2. `watch` → 감시 범위 해석(`watch-scope.ts`) → 레포 폴링 → `syncPR` 이 GitHub
   현황(스레드 resolve·head SHA·닫힘)을 상태 머신 이벤트로 변환
3. 스캔이 끝나면 `buildQueue` 로 우선순위를 매기고 **한 건만** `runRound` 실행 후
   즉시 재스캔 (브라우저 페이지가 단일 자원이라 리뷰는 직렬만 가능 — f34146b 참고)
4. `runRound` → PR 전용 대화 진입(`conversationUrl` 이 있으면 복귀, 없으면 새 대화)
   → 프롬프트(맞춤 지침 + 이전 라운드 스레드 현황 포함) 전송
   → 응답 JSON 파싱 → diff 대조 → 인라인 리뷰 게시 → 스레드 동기화 → 상태 전이

## 감시 범위

`pr-review.config.json` 의 `watch` 블록이 대상을 정한다 (`mode`: account/repos/
review-requested + 글롭 `include`/`exclude` + `filters`). 계정 모드는 GraphQL 검색으로
"열린 PR 이 있는 레포" 를 발견한 뒤 그 목록을 레포 probe 에 넘긴다.

검색과 폴링의 역할을 나눈 이유: 검색 인덱스는 반영 지연이 있어 새 커밋 감지에 쓸 수
없다. 발견은 `discoveryIntervalMs`(기본 5분) 주기로, 감지는 10초 주기 probe 가 맡는다.
구버전 `watchRepos` 는 `watch.include` 가 비었을 때의 폴백으로 계속 동작한다.

스캔 대상 = 검색으로 발견한 레포 ∪ **아직 살아있는 컨텍스트가 있는 (범위 내) 레포**.
검색은 열린 PR 이 있는 레포만 주므로, 후자를 빼면 마지막 PR 이 닫힌 레포의 컨텍스트가
`PR_CLOSED` 를 못 받고 영영 남는다.

`review-requested` 는 검색 조건이 PR 단위다. 레포로 축약하면 요청받지 않은 PR 까지
리뷰하게 되므로 PR 번호를 보존해 **새 추적 시작만** 제한한다 (`admitsNewPR`).
`targets` 가 있으면 제한 모드이며, 레포 키가 없으면 **빈 집합 = 전부 거부**다 —
무제한으로 넘기면 요청 해제 후 lingering 으로 남은 레포의 다른 PR 이 전부 대상이 된다.
이미 추적 중인 PR 은 계속 간다 — 리뷰를 게시하면 GitHub 이 요청을 해제해 2차 라운드가
끊기기 때문이다.

탐색 캐시 갱신은 `nextRepoCache` 하나로 정의한다. `partial`(일부 쿼리 실패)이면 아무것도
빼지 않고, **완전히 성공한 빈 결과는 그대로 반영**한다. 후자를 되살리면 이미 정리된
레포를 계속 probe 한다 — 종료 동기화가 필요한 레포는 scan 의 lingering 이 따로 챙긴다.

실측 비용: 검색 1 point/페이지 · probe 1 point/레포 (PR 개수·라벨 조회와 무관).

## 빌드 & 실행

```sh
npm install
npm run smoke        # 상태 머신 테스트
npm run dev -- init  # 설정 + instructions.md 생성
npm run dev -- review <pr-url> [--dry-run|--force]
npm run dev -- watch [--once|--headless]
npm run dev -- queue [--json]   # 리뷰 대기열
npm run dev -- status [pr] [--json]
npm run dev -- graph [pr]   # mermaid 다이어그램
```

## 설정

- `pr-review.config.json` — `init` 으로 생성. ChatGPT DOM 변경 시 `selectors` 오버라이드.
  `watch.include` 에 감시 범위를 적는다 (비면 `watchRepos` 폴백).
- `instructions.md` — 맞춤 리뷰 지침. 매 프롬프트의 `{{instructions}}` 에 주입됨.

## 주의사항

- ChatGPT 셀렉터는 UI 업데이트 시 깨질 수 있음 → config 에서 오버라이드
- `headless: true` 는 서버용이지만 봇 감지에 걸릴 수 있음
- CAPTCHA 발생 시 수동 해결 필요 (자동 우회 미구현)
- 쿼터 한도 감지 시 QUOTA_BLOCKED 로 전이, `quotaCooldownMs` (기본 3시간) 후 자동 재개.
  한도는 계정 단위라 나머지 큐도 같이 보류되지만 **버리지 않고** 쿨다운 후 재개한다
- `filters` 없으면 draft PR 은 제외된다 (`filters.draft: true` 로 되돌림)
- **미해결 이슈 #1** — 응답이 멈춰도 중지 버튼이 남아 `isStreaming()` 이 참을 유지하면
  연결 중단 복구(`!streaming` 조건)에 진입하지 못하고 타임아웃까지 대기한다.
  근인 미확정이라 수정 보류 중. 정체 타임아웃을 넣기 전에 셀렉터 오탐인지
  실제 생성 중인지부터 가려야 한다 (오판 시 정상 응답을 절단하게 됨)
