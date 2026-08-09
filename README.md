# gpt-chat-pr-reviewer

**ChatGPT의 chat 기능**으로 GitHub PR을 자동 리뷰하는 CLI. 상태 머신으로 리뷰 라운드를 관리합니다.

> Codex도, ChatGPT Work(에이전트) 기능도 아닌 **일반 대화창**을 사용합니다.
> API 토큰 대신 이미 구독 중인 ChatGPT 플랜의 대화 한도를 소비하므로 추가 비용이 들지 않습니다.

```
PR 감지 → ChatGPT 대화창에 리뷰 요청 → 응답 파싱 → 인라인 스레드로 게시
        → 작성자 응답 대기 → 반영 확인 → 재리뷰 → 수렴
```

---

## 왜 만들었나

AI PR 리뷰 도구는 이미 많지만 대부분 API 토큰을 소비합니다. 리뷰는 diff 전체를 컨텍스트에 넣기 때문에 토큰 소모가 크고, 라운드를 반복하면 비용이 빠르게 누적됩니다.

반면 ChatGPT 대화창에 PR URL을 던지고 *"리뷰해줘"* 라고 하면 GPT가 알아서 PR을 읽고 리뷰합니다. 이미 내고 있는 구독료 안에서요. 이 도구는 **그 반복 작업만 자동화**합니다.

## 동작 방식

Playwright로 시스템 Chrome을 **영속 프로필**로 띄웁니다. 최초 1회 수동 로그인하면 이후 세션이 재사용됩니다. 리뷰 요청 프롬프트를 대화창에 입력하고, 스트리밍이 끝날 때까지 대기한 뒤 응답을 수집합니다.

응답에서 JSON을 추출해 `gh` CLI로 PR에 인라인 코멘트를 게시합니다. 코멘트 위치는 diff의 실제 변경 라인과 대조해 검증하며, 인라인이 불가능한 항목은 리뷰 본문에 포함시킵니다.

## 상태 머신

리뷰 라이프사이클 전체를 명시적 상태로 관리합니다. 전이 테이블은 [`src/state/machine.ts`](src/state/machine.ts)의 `TRANSITIONS` 하나로만 정의되며, 실행·검증·시각화가 모두 여기서 파생됩니다.

```mermaid
stateDiagram-v2
  [*] --> REVIEW_DUE
  REVIEW_DUE --> REVIEWING: START_REVIEW
  REVIEWING --> AWAITING_AUTHOR: POSTED_COMMENTS
  REVIEWING --> CONVERGED: POSTED_CLEAN
  REVIEWING --> QUOTA_BLOCKED: QUOTA_EXCEEDED
  REVIEWING --> ERROR: REVIEW_FAILED
  AWAITING_AUTHOR --> REVIEW_DUE: AUTHOR_RESPONDED
  CONVERGED --> REVIEW_DUE: NEW_COMMITS
  QUOTA_BLOCKED --> REVIEW_DUE: COOLDOWN_ELAPSED
  ERROR --> REVIEW_DUE: RETRY
  REVIEW_DUE --> CLOSED: PR_CLOSED
  AWAITING_AUTHOR --> CLOSED: PR_CLOSED
  CONVERGED --> CLOSED: PR_CLOSED
  CLOSED --> [*]
```

| 상태 | 의미 | 벗어나는 조건 |
|---|---|---|
| `REVIEW_DUE` | 리뷰 대기 | watch가 라운드 실행 |
| `REVIEWING` | 리뷰 진행 중 | 게시 완료 / 쿼터 / 실패 |
| `AWAITING_AUTHOR` | 작성자 응답 대기 | 새 커밋 push **또는** 해당 라운드 스레드 전체 resolve |
| `CONVERGED` | 리뷰 수렴 (approve) | 새 커밋 발생 시 재개 |
| `QUOTA_BLOCKED` | ChatGPT 한도 도달 | 쿨다운 경과 (기본 3시간) |
| `ERROR` | 실패 | 자동 재시도 (기본 2회) |
| `CLOSED` | PR 닫힘/머지 | — (terminal) |

PR별 컨텍스트에 **라운드 수 · 누적 요청 코멘트 수 · 스레드별 resolve/답글 여부 · 전체 이벤트 히스토리**가 기록됩니다. `data/state/<owner>__<repo>__<n>.json`에 영속화되며, `status --json`으로 그대로 읽을 수 있어 UI를 얹기 쉽습니다.

### 리컨실리에이션

`watch` 루프는 매 사이클마다 GitHub 현황(스레드 resolve 상태, head SHA, PR 열림/닫힘)을 읽어 상태 머신 이벤트로 변환합니다. 프로세스가 죽어 `REVIEWING`에 멈춰 있어도 다음 사이클에서 자동 복구됩니다.

스캔은 **레포당 GraphQL 1회**입니다. 열린 PR 목록과 리뷰 스레드의 resolve 상태를 한 쿼리에 담아 비용이 PR 개수와 무관한 상수(1 point)가 됩니다. 기본 폴링 주기는 10초이며, 리뷰를 실행한 사이클 직후에는 대기 없이 재스캔합니다.

> 스레드 resolve는 `pullRequest.updatedAt`을 갱신하지 **않습니다**(실측 확인). 따라서 `updatedAt` 비교만으로는 resolve를 감지할 수 없고, `AWAITING_AUTHOR` 상태인 PR은 스레드 상태를 직접 조회합니다. 자세한 측정은 [#4](https://github.com/lpaiu-cs/gpt-chat-pr-reviewer/issues/4) 참고.

2차 라운드부터는 프롬프트에 **이전 라운드 코멘트 현황**(해결됨 / 답변만 있음 / 미해결)이 포함되어, 이전 지적의 반영 여부와 새 변경사항 위주로 검토합니다.

## 감시 범위

레포를 하나씩 등록하는 대신 **계정/조직 단위로 감시**할 수 있습니다. 새 레포에 PR이 열리면 설정을 고치지 않아도 자동으로 대상에 들어옵니다.

```jsonc
{
  "watch": {
    "mode": "account",              // account | repos | review-requested
    "include": ["myorg/*"],         // 글롭 허용. 슬래시가 없으면 'owner/*' 로 해석
    "exclude": ["*/archived-*"],
    "filters": {
      "authors": ["lpaiu-cs"],      // 이 작성자들의 PR만
      "labels": ["needs-review"],   // 이 라벨을 하나라도 가진 PR만
      "draft": false                // 초안 제외 (기본값)
    },
    "discoveryIntervalMs": 300000   // 레포 재탐색 주기 (기본 5분)
  }
}
```

| `mode` | 대상 |
|---|---|
| `account` | `include`의 계정/조직에서 **열린 PR이 있는 레포**를 검색으로 발견 |
| `repos` | `include`에 적은 `owner/repo`만 (글롭 불가) |
| `review-requested` | 현재 `gh` 계정에 **리뷰가 요청된 PR만** (레포 단위가 아니라 PR 단위) |

필터는 AND로 적용되며, 걸린 PR은 추적을 시작하지도 않습니다. `filters`가 없으면 **초안(draft)은 제외**됩니다 — 작성 중인 PR까지 대화 한도를 쓰지 않기 위해서입니다. `"draft": true`로 되돌릴 수 있습니다.

> `review-requested`는 PR 번호까지 보존해 대상을 한정합니다. 레포 단위로 축약하면 리뷰 요청받은 PR 하나 때문에 그 레포의 열린 PR 전부가 리뷰 대상이 됩니다.
>
> 다만 **이미 추적을 시작한 PR은 계속 따라갑니다.** 리뷰를 게시하면 GitHub이 리뷰 요청을 해제하므로, 검색 결과만 믿으면 1차 라운드 직후 대상에서 빠져 2차 라운드가 오지 않습니다.

라벨 목록이 한 번에 다 읽히지 않은 경우(`labelsTruncated`)에는 라벨 조건으로 **제외하지 않습니다.** 못 읽은 구간에 대상 라벨이 있을 수 있어서, 불완전한 근거로 빼면 그 PR은 조용히 영영 리뷰되지 않습니다. 이때는 경고를 출력하고 통과시킵니다.

> 구버전 `watchRepos`도 그대로 동작합니다. `watch.include`가 비어 있으면 `watchRepos`를 `repos` 모드로 해석합니다.

**비용.** 레포 발견은 GraphQL 검색 1회(실측 1 point)이고 기본 5분 주기로만 돕니다. 감지 자체는 기존대로 레포당 1 point/스캔입니다. 검색 인덱스는 반영 지연이 있어 새 커밋 감지에는 쓰지 않고, **대상 목록을 정하는 데에만** 사용합니다.

## 리뷰 큐

브라우저 페이지가 단일 자원이라 리뷰는 **직렬로만** 돌 수 있고, 라운드 하나가 2~15분 걸립니다. 대상이 많아지면 "무엇을 먼저 볼 것인가"가 문제가 되므로 스캔과 실행을 분리했습니다. 한 사이클은 감시 범위를 전부 동기화한 뒤, 큐에서 **한 건만** 리뷰하고 즉시 재스캔합니다 — 라운드가 도는 동안 바뀐 상황이 다음 순서에 반영됩니다.

```bash
npm run dev -- queue          # 대기열 조회
npm run dev -- queue --json   # UI/스크립트 연동
```

우선순위는 **라운드 미진행 → 작성자 응답 완료 → 그 외**이고, 같은 순위 안에서는 오래 기다린 PR이 먼저입니다.

`queue`는 watch와 **같은 범위·필터**를 적용합니다. 감시 범위 밖 레포나 필터에 걸린 PR은 대기열에 나오지 않으며, 몇 건을 감췄는지 함께 알려줍니다. 필터 판정은 스캔이 컨텍스트에 남긴 결과를 읽으므로 `queue`는 GitHub을 다시 호출하지 않습니다.

감시 범위가 설정되지 않았으면 watch 자체가 돌지 않으므로, `queue`도 대기열 대신 설정이 비었다고 알립니다 (`--json`은 `"scopeConfigured": false`). 추적 기록을 그대로 보려면 `status`를 쓰세요.

```
  대기열 3건  (위에서부터 처리)
   1. myorg/api#42   [1차 리뷰]     대기 2시간 10분
   2. myorg/web#17   [작성자 응답]  대기 35분
   3. myorg/api#31   [재시도]       대기 6시간 2분
```

쿼터 한도에 걸려도 **큐는 그대로 보존**됩니다. ChatGPT 한도는 계정 단위라 남은 대상도 지금은 못 돌지만, 사이클을 중단하는 대신 실행만 미루고 폴링은 계속합니다. 쿨다운이 지나면 우선순위 그대로 재개하며, `watch`를 껐다 켜도 저장된 컨텍스트에서 복원됩니다.

> 큐는 저장되지 않습니다. `REVIEW_DUE`인 컨텍스트에서 매번 다시 계산합니다 — 상태가 이미 단일 소스이므로 큐 파일을 따로 두면 잠금 없는 저장소를 두 곳에서 다투게 됩니다. 같은 이유로 `QUEUED` 같은 상태를 상태 머신에 추가하지 않았습니다. 큐 대기는 실행기 사정이지 GitHub에서 관측된 PR 상태가 아닙니다.

---

## 요구사항

- Node.js 20+
- [`gh` CLI](https://cli.github.com/) — 인증 완료 상태 (`gh auth login`)
- 데스크톱 Chrome
- ChatGPT 계정 — **비공개 레포를 리뷰하려면 ChatGPT 설정에서 GitHub 커넥터를 연결**하세요. 연결하면 권한 있는 private 레포도 읽습니다.

## 설치

```bash
git clone https://github.com/lpaiu-cs/gpt-chat-pr-reviewer.git
cd gpt-chat-pr-reviewer
npm install
```

## 시작하기

**1. 설정 파일 생성**

```bash
npm run dev -- init
```

`pr-review.config.json`과 `instructions.md`가 생성됩니다.

**2. ChatGPT 로그인 (최초 1회)**

```bash
npm run dev -- setup
```

브라우저가 열리면 직접 로그인하세요. 세션은 `browser-profile/`에 저장되어 이후 재사용됩니다.

**3. 리뷰 실행**

```bash
npm run dev -- review https://github.com/owner/repo/pull/123 --dry-run
```

`--dry-run`은 게시하지 않고 결과만 출력합니다. 확인 후 플래그를 빼고 실행하세요.

**4. 자동 감시**

`pr-review.config.json`의 `watch.include`에 감시 범위를 적은 뒤:

```jsonc
"watch": { "mode": "account", "include": ["myorg/*"] }   // 조직 전체
"watch": { "mode": "repos",   "include": ["owner/repo"] } // 레포 지정
```

```bash
npm run dev -- watch
```

계정 전체를 감시하면 새 레포의 PR도 자동으로 큐에 올라옵니다. 자세한 옵션은 [감시 범위](#감시-범위)를 참고하세요.

**5. 대시보드 (선택)**

```bash
npm run dev -- watch --ui
```

`http://127.0.0.1:4478`에 관측용 대시보드가 열립니다. 자세한 내용은 [대시보드](#대시보드)를 참고하세요.

## 명령어

| 명령 | 설명 |
|---|---|
| `setup` | ChatGPT 최초 로그인 (브라우저 프로필 생성) |
| `whoami` | 현재 프로필의 ChatGPT 로그인 상태 확인 |
| `init` | 설정 파일 + 맞춤 지침 파일 생성 |
| `instructions` | 맞춤 리뷰 지침 파일 열기 |
| `review <pr>` | 리뷰 라운드 실행 — `--dry-run` `--force` `--headless` `--timeout <분>` `--from-cache` `--instructions <file>` |
| `watch` | 감시 범위 폴링 → 동기화 → 큐 순서대로 자동 리뷰 — `--once` `--headless` `--dry-run` `--ui` `--ui-port <port>` |
| `queue` | 리뷰 대기열 조회 — `--json` |
| `status [pr]` | PR 상태 조회 — `--json` |
| `graph [pr]` | 상태 머신 mermaid 다이어그램 출력 |
| `rounds <pr>` | 리뷰 라운드 이력 |

### 응답 캐시

받은 응답은 `data/responses/`에 즉시 저장됩니다. 게시 단계에서 실패했을 때 (라인 불일치, 권한 오류 등) ChatGPT 대화 한도를 다시 쓰지 않고 게시만 재시도할 수 있습니다.

```bash
npm run dev -- review <pr-url> --from-cache
```

이 경우 브라우저를 아예 띄우지 않습니다.

### 대화 세션

한 PR의 리뷰 라운드는 **같은 ChatGPT 대화**에서 이어집니다. 1차 라운드가 만든 대화 URL을 상태 파일에 기록해 두고, 다음 라운드에서 그 대화로 돌아가 이어서 질문합니다. GPT가 이전 라운드에 무엇을 왜 지적했는지 그대로 기억하므로, 반복 패턴이나 이미 합의한 판단 기준이 매 라운드 초기화되지 않습니다. `status <pr>`에서 현재 대화 URL을 볼 수 있습니다.

- 대화가 삭제됐거나 다른 계정으로 바뀌어 열 수 없으면 새 대화로 폴백하고 그 사실을 로그로 알립니다.
- `maxTurnsPerConversation`(기본 5)회를 전송하면 컨텍스트 한도를 피해 새 대화로 전환하고, 프롬프트가 이전 지적을 요약해 이월합니다. 완료된 라운드가 아니라 **실제 전송 횟수**를 셉니다 — 게시에 실패해 다시 보낸 것도 대화에는 그대로 쌓이기 때문입니다.
- 리뷰가 수렴(`CONVERGED`)하거나 PR이 닫히면 대화 참조를 놓습니다. 새 커밋으로 재개될 때는 새 대화에서 시작합니다.
- `--dry-run`은 저장된 대화를 건드리지 않고 일회성 새 대화에서 실행합니다. 그러지 않으면 dry-run 응답이 섞인 대화를 다음 실제 라운드가 물려받습니다.
- 캐시된 응답에는 어느 대화에서 나왔는지가 함께 저장됩니다. `--from-cache`로 게시할 때 출처가 현재 대화와 다르면(예: dry-run 응답) 대화 참조를 놓습니다 — 그 코멘트는 대화에 없으므로, 다음 라운드가 있다고 오판하면 안 됩니다.

`review`는 상태를 존중합니다. `AWAITING_AUTHOR`인 PR에 실행하면 대기 중임을 알리고 종료하며, `--force`로만 강제 실행됩니다.

## 대시보드

```bash
npm run dev -- watch --ui        # http://127.0.0.1:4478
npm run dev -- watch --ui --ui-port 9000
```

**읽기 전용 관측 화면입니다.** 진행 중인 라운드, 대기열, 추적 중인 PR, GraphQL 잔여 한도, 쿼터 쿨다운, 그리고 터미널 로그를 실시간으로 보여줍니다.

가장 큰 쓸모는 **진행 중 패널**입니다. 리뷰 라운드 하나는 2~15분 걸리는데, 터미널에는 그동안 30초마다 한 줄만 찍혀서 살아 있는지 알기 어려웠습니다. 대시보드는 지금 어느 단계인지(대화 준비 → 프롬프트 전송 → 응답 대기 → 파싱 → 게시 → 동기화), 그 단계에 얼마나 머물렀는지, ChatGPT가 생성 중인지 추론 중인지, 몇 글자를 받았는지를 초 단위로 보여줍니다.

### 왜 watch 프로세스 안에서 도는가

대시보드는 **별도 프로세스가 아니고, 상태 파일을 읽지도 않습니다.** watch 루프의 메모리만 봅니다.

`store.ts`의 `saveContext`는 잠금 없는 `writeFileSync`이고, 리뷰 라운드 하나는 2~15분 동안 read-modify-write를 붙잡고 있습니다. 다른 프로세스가 `data/state/*.json`을 건드리면 라운드 결과를 덮어쓰거나 찢어진 JSON을 읽습니다. [리뷰 큐](#리뷰-큐)를 파일로 저장하지 않는 것과 같은 이유입니다.

- 통신은 SSE(`node:http`) — 새 의존성이 없고, watch를 재시작해도 브라우저가 알아서 재연결합니다 (로그에 `── watch 재시작 ──` 구분선이 들어갑니다)
- **`127.0.0.1`에만 바인딩합니다.** PR 제목·상태·리뷰 로그가 그대로 보이므로 같은 네트워크에 노출하지 않습니다
- 포트가 쓰이고 있으면 다음 포트로 최대 10번 물러섭니다
- 대시보드가 못 떠도 감시는 그대로 계속됩니다
- `--ui` 없이 돌면 관련 코드는 전부 no-op입니다

SSE를 쓸 수 없는 소비자를 위해 `GET /api/state`가 같은 스냅샷을 JSON으로 돌려줍니다.

## 맞춤 지침

`instructions.md`의 내용이 매 리뷰 프롬프트에 주입됩니다.

```markdown
- 코멘트 앞에 심각도를 표기: [P1] 버그·보안 / [P2] 로직·성능 / [P3] 스타일
- 스타일 지적은 최소화하고 버그·보안·성능 위주로 검토
- 테스트 누락 여부를 확인
```

`--instructions <file>`로 1회성 오버라이드도 가능합니다.

## 설정

`pr-review.config.json`:

| 키 | 기본값 | 설명 |
|---|---|---|
| `watch` | — | 감시 범위 — [위 절](#감시-범위) 참고 |
| `watchRepos` | `[]` | 감시할 `owner/repo` 목록 (구버전 — `watch.include` 폴백) |
| `watchIntervalMs` | `10000` | 폴링 간격 (10초, 하한 5초) |
| `quotaCooldownMs` | `10800000` | 쿼터 쿨다운 (3시간) |
| `maxAutoRetries` | `2` | ERROR 자동 재시도 횟수 |
| `maxTurnsPerConversation` | `5` | 대화 1개에 전송할 최대 프롬프트 수 (도달 시 새 대화) |
| `headless` | `false` | 헤드리스 실행 |
| `browserChannel` | `chrome` | Playwright 채널 |
| `selectors` | — | ChatGPT DOM 셀렉터 오버라이드 |
| `promptTemplate` | — | 프롬프트 템플릿 |

## 개발

```bash
npm run smoke   # 상태 머신 테스트
npm run build   # dist/ 생성
```

구조는 [CLAUDE.md](CLAUDE.md)를 참고하세요.

---

## 알려진 한계

- **ChatGPT UI 변경에 취약합니다.** 셀렉터가 깨지면 `pr-review.config.json`의 `selectors`에서 오버라이드하세요.
- **CAPTCHA는 자동 우회하지 않습니다.** 발생 시 직접 해결해야 합니다. 헤드리스 모드는 봇 감지에 걸릴 확률이 높습니다.
- **리뷰 품질은 GPT가 PR을 얼마나 잘 읽느냐에 달려 있습니다.** 비공개 레포는 ChatGPT에 GitHub 커넥터가 연결되어 있어야 읽을 수 있습니다.
- 라인 번호가 부정확한 경우 인라인 대신 리뷰 본문에 포함됩니다.
- **대시보드는 관측 전용입니다.** 리뷰를 지금 실행하거나 일시정지하는 등의 제어는 아직 없습니다.

## 주의

이 도구는 ChatGPT 웹 인터페이스를 브라우저 자동화로 조작합니다. OpenAI 이용약관상 자동화된 접근은 회색지대이므로, 사용에 따른 책임은 사용자에게 있습니다. 계정 제재 가능성을 인지하고 사용하세요.

## 라이선스

[MIT](LICENSE)
