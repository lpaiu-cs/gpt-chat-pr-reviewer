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
                      gh 실행은 `gh()` 게이트웨이 하나로만 — execSync 금지 (아래)
  parser.ts         — GPT 응답 → ReviewResult 파서
  poster.ts         — ReviewResult → GitHub 인라인 코멘트 게시
  instructions.ts   — 맞춤 지침 파일 (instructions.md → {{instructions}} 주입)
  config.ts         — 설정 로드/저장 (pr-review.config.json)
  progress.ts       — 진행 상황 버스 (리프 — http·config·상태 머신을 모른다)
  intents.ts        — 제어 의도 큐 (리프 — UI POST 와 루프 사이의 완충 지대)
  ui/
    server.ts       — 관측 대시보드: node:http + SSE, 127.0.0.1 전용
    app.html        — 대시보드 (단일 파일 · 빌드 스텝 없음)
  types.ts          — 공유 타입 (PRState/PREvent/PRContext 포함)
scripts/
  smoke-machine.ts  — 상태 머신 스모크 테스트 (npm run smoke)
  copy-ui.mjs       — app.html 을 dist 로 복사 (tsc 는 .html 을 안 옮긴다)
  notify.mjs        — 대시보드 SSE 구독 → 리뷰 게시 알림 (의존성 없음, node 로 직접 실행)
                      --pr 로 세션별 대상 한정 · --porcelain 으로 에이전트가 소비
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

## 대시보드 (`watch --ui`)

**watch 프로세스 안에서** 돈다. 별도 프로세스가 아니고 `data/state/*.json` 을 읽지도
않는다 — `progress.ts` 버스에 모인 루프의 메모리만 본다. 이유는 큐를 파일로 저장하지
않는 것과 정확히 같다: `store.ts` 에 잠금이 없고 라운드 하나가 2~15분 동안
read-modify-write 를 붙잡으므로, 다른 읽기·쓰기 경로가 끼어들면 결과를 덮어쓰거나
찢어진 JSON 을 읽는다.

의존 방향은 `reviewer/chatgpt → progress ← ui/server` 로만 흐른다. `progress.ts` 는
리프로 유지한다 — 여기가 상태 머신 라벨을 알기 시작하면 UI 를 거쳐 모듈이 얽힌다.
그래서 `PRContext → ContextCard` 변환은 `cli.ts` 에 둔다.

- 로그는 `console.log/error` 를 한 번 감싸 미러링한다 (호출부 60여 곳을 고치지 않는다).
  심각도는 chalk 의 첫 SGR 코드로 추론하고, 색이 꺼진 환경에서는 마커(`✓ ⚠ ✗`)가 폴백.
- 라운드 진행 단계는 `reviewer.ts` 와 `chatgpt.ts` 의 `progress.phase()` 로 보고한다.
  `waiting` 이 압도적으로 길어(2~15분) 이 구간의 스트리밍 관측값(`progress.stream`)이
  관측의 핵심이다. **이슈 #1(원인 미상 타임아웃)의 증상 기록 창구이기도 하다.**
- 세션 id 는 프로세스마다 새로 만든다. 로그 `seq` 가 1부터 다시 시작하므로, 이게 없으면
  watch 재시작 후 클라이언트가 새 로그를 전부 "이미 본 것" 으로 버린다.
- `--ui` 없이 돌면 `progress.enabled === false` 라 모든 기록 호출이 no-op 이다.

### 제어 (의도 큐)

POST 는 상태를 직접 건드리지 않는다. `intents.ts` 에 쌓아두고 루프가 **스캔 직전**
(= `applyIntents()`, 라운드가 돌지 않는 유일한 지점)에서 한 번에 꺼내 적용한다.
라운드 하나가 2~15분 동안 ctx 와 scope 를 붙잡고 있으므로 그 사이에 끼어들면
반쯤 낡은 기준으로 판정한 결과가 저장된다. 대기 건수는 스냅샷의
`control.pendingIntents` 로 나가 화면에 "적용 대기" 로 뜬다.

필터·범위 변경은 메모리(`scope` 객체 in-place)와 설정 파일에 **함께** 반영한다.
저장은 `patchConfigFile` 로 `watch` 키만 갈아 끼운다 — `saveConfig(loadConfig())` 로
쓰면 프롬프트 템플릿·셀렉터 기본값이 사용자 파일에 박제되어 이후 기본값 개선이
반영되지 않는다. `scope.include` 를 바꿀 때는 `repoSource.lastAt = 0` 으로 탐색
캐시를 무효화해야 `discoveryIntervalMs`(기본 30초)를 기다리지 않는다.

지침(`instructions.md`)만 의도 큐를 건너뛰고 즉시 쓴다. 상태가 아니라 **입력**이고
루프가 라운드마다 새로 읽으므로 붙잡고 있는 주체가 없다.

POST 는 `Origin` 검사와 `application/json` 요구로 막는다. 127.0.0.1 바인딩만으로는
부족하다 — 사용자가 열어둔 아무 페이지나 localhost 로 요청을 보낼 수 있고, 이제
POST 가 설정 파일을 바꾸기 때문이다.

`scripts/notify.mjs` 가 이 SSE 의 첫 소비자다. **상태 파일을 읽지 않고 SSE 만 구독하므로
별도 프로세스로 띄워도 안전하다** — 대시보드를 만들 때 세운 규칙이 그대로 배당금이 됐다.
전이 판정은 `active.phase` 가 아니라 **컨텍스트 카드의 state** 로 한다: `endReview` 직후
스냅샷의 카드는 아직 라운드 이전 값이고 결과는 다음 publish 에 실리는데, 카드만 보면 그
타이밍을 신경 쓸 필요가 없다.

`--pr` 필터가 필수인 이유: 대시보드는 watch 프로세스당 하나인데 작업 세션은 여러 개다.
각 세션은 자기가 붙잡은 PR 만 기다리므로, 필터가 없으면 남의 PR 이 게시될 때마다 전부
깨어난다. 필터에 걸리는 PR 이 하나도 없으면 경고한다 — 오타로 영원히 조용한 상태가
정상처럼 보이면 안 된다. `--porcelain` 은 에이전트가 소비하는 모드로, 연결 상태까지
같은 1줄 형식으로 내보내 침묵이 "아직" 인지 "끊김" 인지 구분되게 한다.

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

`filters.skip` / `filters.only` (`'owner/repo#12'`) 는 authors/labels/draft 로 표현할 수
없는 PR 단위 지정이다. `passesFilters` 에서 **가장 먼저** 판정한다 — 명시적으로 지목한
조건을 `draft: true` 같은 다른 설정이 뒤집으면 안 된다. 겹치면 skip 이 이긴다.
둘 다 **감시가 아니라 큐 자격만** 좁힌다 — 제외된 PR 도 계속 동기화되고 대시보드에 남는다.
형식이 틀리면 아무것도 매치하지 않아 조용히 무효가 되는데 결과가 정반대다 (skip 오타는
리뷰돼 버리고 only 오타는 전부 멈춘다). `invalidPRRefs` 로 watch 시작 시 검사해 알린다.

`--observe` 는 감시·동기화·큐 계산만 하고 리뷰를 실행하지 않는다. 브라우저를 아예 띄우지
않아 완전히 무비용이다 (`driver` 가 null 로 남는다). `--dry-run` 은 게시만 건너뛸 뿐
ChatGPT 를 호출하므로 이 용도로 쓸 수 없다.

**watch 와 review 를 동시에 돌리면 안 된다.** `syncPRFromProbe` 는 스캔마다 무조건
`saveContext` 하고(reviewer.ts) `runRound` 는 2~15분 동안 ctx 를 메모리에 물고 있다.
잠금이 없으므로 서로의 결과를 덮어쓴다. "지켜보되 하나만 리뷰" 는 `filters.only` 로
한 프로세스 안에서 푼다.

검색과 폴링의 역할을 나눈 이유: 검색 인덱스는 반영 지연이 있어 새 커밋 감지에 쓸 수
없다. 발견은 `discoveryIntervalMs`(기본 30초) 주기로, 감지는 10초 주기 probe 가 맡는다.
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

probe 는 레포 수에 선형 비례하므로 **resolve 를 기다리지 않는 레포는 주기를 늦춘다**
(`probeIdleIntervalMs`, 기본 60초). 10초가 정말 필요한 건 `AWAITING_AUTHOR` 레포뿐이다 —
나머지에서 probe 가 잡는 것(새 PR·새 커밋·닫힘)은 몇십 초 늦어도 무해하다.
**건너뛴 주기에도 이미 아는 컨텍스트는 큐에 남긴다** — 빼면 REVIEW_DUE PR 이 건너뛴
주기마다 큐에서 사라져 리뷰 시작이 들쭉날쭉해진다. `watchedRepos` 는 실제로 부른 수다.

**두 축의 비용 성격이 다르다.** 탐색은 소유자 수에 비례하고(레포 50개든 500개든 1 point),
probe 는 레포 수에 비례한다. 시간당 탐색 30초=120 vs 레포 4개 probe 10초=1,440.
그래서 "탐색이 비싸니 뜸하게" 는 틀린 전제다 — 원래 기본값 5분이 거기서 나왔고,
머지 직후 같은 레포의 새 PR 이 최대 5분 안 보이는 구멍을 만들었다 (닫힌 컨텍스트는
lingering 에서 빠지므로 그 레포가 스캔 대상에서 통째로 사라진다). 30초로 낮췄다.
레포가 늘 때 손봐야 하는 쪽은 probe 다 (이슈 참고).

## 빌드 & 실행

```sh
npm install
npm run smoke        # 상태 머신 테스트
npm run dev -- init  # 설정 + instructions.md 생성
npm run dev -- review <pr-url> [--dry-run|--force]
npm run dev -- watch [--once|--headless|--observe|--ui|--ui-port <port>]
npm run dev -- queue [--json]   # 리뷰 대기열
npm run dev -- status [pr] [--json]
npm run dev -- graph [pr]   # mermaid 다이어그램
npm run notify       # 대시보드 이벤트 알림 (watch --ui 가 떠 있어야 한다)
```

## 설정

- `pr-review.config.json` — `init` 으로 생성. ChatGPT DOM 변경 시 `selectors` 오버라이드.
  `watch.include` 에 감시 범위를 적는다 (비면 `watchRepos` 폴백).
- `instructions.md` — 맞춤 리뷰 지침. 매 프롬프트의 `{{instructions}}` 에 주입됨.

## gh 실행 (Windows 콘솔 깜빡임)

`execSync` 를 쓰면 안 된다. execSync 는 명령을 **셸(cmd.exe)에 넘기는데** cmd.exe 는
콘솔 서브시스템이라 Windows 가 호출마다 새 콘솔 창을 할당한다. 감시 레포마다 매 주기
gh 를 부르므로 빈 검은 창이 연속으로 깜빡인다 (실측 25분에 conhost 198개 ≈ 분당 8개).
`windowsHide` 는 execSync 에서 안 먹는다 — 숨겨야 할 대상이 gh 가 아니라 그 앞의 셸이다.

그래서 **모든 gh 호출은 `github.ts` 의 `gh()` 게이트웨이 하나만 지난다.**
`execFileSync('gh', argv, { windowsHide: true })` 로 셸을 아예 거치지 않는다.
호출부마다 플래그를 붙이는 방식은 쓰지 않았다 — opt-in 이면 새 호출부마다 재발한다.

**인자는 배열로 넘긴다.** 셸이 없으므로 인용부호를 우리가 쓰면 안 된다.
`-q ".owner.login"` → `['-q', '.owner.login']`. 특히 검색 인자에 `JSON.stringify` 를
쓰면 안 된다 — 셸이 있을 때는 그 따옴표를 셸이 벗겨줬지만 이제 gh 가 값으로 받는다.

실측: A/B 로 gh 12회 호출 시 execSync 는 cmd.exe 6개 포착(25ms 샘플러라 하한),
execFileSync 는 0개. 수정 후 watch 70초 폴링에서도 0개.

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
