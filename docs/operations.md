# 운영 가이드

[README로 돌아가기](../README.md)

## 명령어

| 명령 | 설명 |
|---|---|
| `setup` | 로그인 후 열린 프로젝트의 이름·URL 읽기 → 자동 재진입 검증 → 저장 |
| `project-check` | 리뷰를 보내지 않고 프로젝트 진입 반복 검증 (`--repeat 3`, 선택적 `--headless`) |
| `whoami` | 현재 ChatGPT 로그인 상태 확인 |
| `init` | 설정과 맞춤 지침 파일 생성 |
| `instructions` | 맞춤 지침 파일 열기 |
| `review <pr>` | PR 한 건 리뷰 |
| `serve` | 감시 범위를 폴링하고 리뷰 대기열 실행 |
| `queue` | 리뷰 대기열 조회 |
| `status [pr]` | 현재 PR 상태 조회 |
| `rounds <pr>` | 리뷰 라운드 이력 조회 |
| `graph [pr]` | 상태 정보를 Mermaid 텍스트로 출력 |
| `stop` | 실행 중인 리뷰 데몬 종료 |

각 명령의 전체 옵션은 `--help`로 확인할 수 있습니다.

```bash
npm run dev -- review --help
npm run dev -- serve --help
```

`pr-review serve -b` (`--background`)는 저장된 설정으로 백그라운드 데몬을
시작하거나 기존 데몬에 연결합니다. 준비가 끝나면 실제 대시보드 주소를 기본
브라우저로 엽니다. `--no-open`으로 자동 열기를 끌 수 있습니다.
포그라운드 `serve`도 대시보드와 자동 열기가 기본이며, `--no-ui`로 UI를 끕니다.
`--once`, `--observe`, `--dry-run`, `--headless`, `--ui-port`는 포그라운드 전용입니다.

## PR 한 건 리뷰

```bash
npm run dev -- review https://github.com/owner/repo/pull/123
```

자주 쓰는 옵션:

- `--dry-run`: GitHub 게시만 생략합니다. ChatGPT는 호출합니다.
- `--force`: 작성자 응답 대기나 수렴 상태를 무시하고 새 라운드를 요청합니다.
- `--headless`: 브라우저 창을 숨깁니다.
- `--timeout <분>`: 응답 대기 제한을 바꿉니다.
- `--from-cache`: 저장된 응답으로 게시만 다시 시도합니다.

## 응답 캐시

ChatGPT 응답은 `data/responses/`에 즉시 저장됩니다. GitHub 권한이나 라인 검증
문제로 게시만 실패했다면 대화 한도를 다시 쓰지 않고 재시도할 수 있습니다.

```bash
npm run dev -- review <pr-url> --from-cache
```

`--from-cache`는 브라우저를 열지 않습니다.

## 대화 세션

한 PR의 미수렴 라운드는 같은 ChatGPT 대화에서 이어집니다. 이전 지적과 답변을
그대로 볼 수 있어 매 라운드에 맥락을 다시 설명할 필요가 없습니다.

- 대화 URL은 응답 대기 전에 저장됩니다.
- 이미 보낸 라운드는 중복 전송하지 않고 기존 응답을 회수합니다.
- 대화를 열 수 없으면 새 대화로 전환합니다.
- `maxTurnsPerConversation`에 도달하면 새 대화로 전환하고 이전 현황을 요약합니다.
- 수렴하거나 PR이 닫히면 대화 참조를 놓습니다.
- `--dry-run`은 실제 리뷰 대화와 섞이지 않도록 일회성 대화를 사용합니다.

현재 대화 URL은 `status <pr>`에서 볼 수 있습니다.

## 관측 모드

```bash
npm run dev -- serve --observe
```

GitHub 동기화와 대기열 계산만 하고 리뷰는 실행하지 않습니다. Chrome과 ChatGPT
로그인이 필요 없으며 ChatGPT 대화 한도도 사용하지 않습니다.

감시 범위나 필터를 처음 설정했을 때 실제 리뷰 전에 확인하는 용도입니다.

> `--dry-run`은 관측 모드가 아닙니다. 게시만 생략하고 ChatGPT는 호출합니다.

## 대시보드

```bash
npm run dev -- serve --ui
npm run dev -- serve --ui --observe
npm run dev -- serve --ui --ui-port 9000
```

기본 주소는 `http://127.0.0.1:4478`입니다. 다음 정보를 실시간으로 보여줍니다.

- 현재 리뷰 단계와 경과 시간
- 리뷰 대기열
- 추적 중인 PR과 필터 제외 이유
- GraphQL 잔여 한도와 ChatGPT 쿨다운
- 터미널 로그

대시보드에서 다음 작업을 할 수 있습니다.

| 위치 | 작업 |
|---|---|
| PR 카드 | 지금 리뷰, 건너뛰기, 이 PR만 리뷰 |
| 헤더 | 일시정지, 계정 변경, 감시 범위 편집, 리뷰 지침 편집, 종료 |

감시 범위와 필터 변경은 `pr-review.config.json`에 저장됩니다. 리뷰가 진행 중이면
제어 요청은 라운드가 끝난 뒤 적용되며 화면에 대기 건수가 표시됩니다.

## 응답 타임아웃 이후 자동 회수

`responseTimeoutMs`를 넘겼어도 ChatGPT는 답을 계속 생성할 수 있습니다. 대화 URL과
고정 검토 대상이 저장된 전송은 **응답 회수 대기**로 표시하고, 1분 뒤부터 기존
대화를 다시 확인합니다. 다른 리뷰가 실행 중이면 해당 배치가 끝난 뒤 확인합니다.
확인할 때는 최대 30초만 수집을 기다리고, 아직 생성 중이면 부분 답을 게시하지 않고
다음 확인을 예약합니다. 새 질문을 보내거나 일반 실패의 `maxAutoRetries`를 소비하지 않습니다.

대기 시각은 `pendingSend.recoverAfter`에 저장하므로 재시작 후에도 이어집니다.
이전 버전에서 재시도 한도를 소진한 타임아웃도 전송 기록이 온전하면 회수합니다.
응답을 얻으면 기존 파싱·SHA 검증·중복 게시 방지를 그대로 거칩니다. head나 base가
바뀌면 해당 응답 회수를 중단하고 이유를 남깁니다. 대화 접근이 계속 불가능하면
감시 제외 또는 계정 변경으로 회수를 멈출 수 있습니다. 계정 변경과 PR 종료는
이전 대화의 전송 기록도 함께 해제합니다.

## ChatGPT 계정 변경

대시보드의 **계정 변경 → 계정 변경 시작**을 누르면 진행 중인 리뷰를 마친 뒤
로그인용 Chrome 창을 엽니다. 그 창에서 현재 계정을 로그아웃하고 원하는 계정으로
로그인한 다음, 리뷰용 프로젝트를 열고 사이드바에 고정하세요. 일반 Chrome의 로그인과는 별개입니다.

**프로젝트 홈**을 연 상태에서 대시보드의 **로그인·프로젝트 확인**을 누릅니다.
열린 프로젝트의 이름과 URL을 자동으로 읽고 재진입까지 검증한 뒤 설정 파일에
함께 저장합니다. 같은 계정이거나 프로젝트 접근·저장에 실패하면 이유를 표시하고
리뷰는 계속 대기합니다. 창을 닫았으면 **로그인 창 다시 열기**로 돌아갈 수 있습니다.

전환 대기는 재시작 뒤에도 유지됩니다. `serve --ui`로 대시보드에서 마무리하세요.
완료되면 이전 계정의 대화 연결·미완료 전송 회수 기록·쿼터 대기를 정리하고 리뷰를
재개합니다. 기존 리뷰 이력과 작성자 응답 대기 상태는 유지하며, 사용자가 별도로
일시정지해 둔 경우에는 자동으로 재개하지 않습니다.

## 안전하게 종료하기

```bash
npm run dev -- stop
npm run dev -- stop --now
```

기본 `stop`은 진행 중인 라운드를 마친 뒤 종료합니다. `--now`는 즉시
종료하므로 이미 생성 중인 응답을 버릴 수 있습니다.

## 이벤트 알림

`serve --ui`의 이벤트 스트림을 구독해 리뷰 결과가 올라올 때 알림을 받을 수
있습니다.

```bash
npm run notify
node scripts/notify.mjs --pr myorg/api#34
```

주요 이벤트:

| 이벤트 | 의미 |
|---|---|
| `round-start` | 리뷰 라운드 시작 |
| `posting` | GitHub 게시 단계 진입 |
| `posted` | 지적 코멘트 게시 완료 |
| `converged` | 지적 없이 수렴 |
| `failed` | 리뷰 실패 |
| `quota` | ChatGPT 한도 도달 |
| `closed` | PR 닫힘 또는 머지 |

외부 명령을 실행하려면:

```bash
node scripts/notify.mjs --pr myorg/api#34 --on posted --exec "your-handler.sh"
```

### 에이전트가 대기할 때

`--porcelain`은 이벤트를 한 줄씩 출력합니다. `--until`을 함께 사용하면
이벤트 하나를 받은 뒤 프로세스가 종료되어 에이전트가 완료 신호로 쓸 수 있습니다.

```bash
node scripts/notify.mjs --porcelain --pr myorg/api#34 \
  --until posted,converged,failed,quota,closed --timeout 2700 --since-seq 7
```

`--since-seq`는 리뷰 요청 이후의 결과만 인정하기 위한 기준값입니다. 직접
추측하지 말고 리뷰 요청 명령이 출력한 값을 사용하세요.

`--exec`로 실행되는 명령에는 `PR_EVENT`, `PR_KEY`, `PR_URL`, `PR_OWNER`,
`PR_REPO`, `PR_NUMBER`, `PR_ROUND`, `PR_STATE`, `PR_TITLE` 환경변수가
전달됩니다.

## Codex와 Claude Code 스킬

```bash
npm run install-skills -- --target codex
npm run install-skills -- --target claude
npm run install-skills -- --target all
```

설치기는 두 스킬을 함께 복사하고 `{{DAEMON}}`을 현재 저장소의 절대 경로로
치환합니다. 저장소를 옮겼다면 설치 명령을 다시 실행하세요.

- `gpt-chat-pr-review`: 명시적으로 호출할 때만 리뷰를 요청합니다.
- `gpt-chat-pr-watch`: 읽기 전용으로 상태를 조회하고 변화만 기다립니다.

스킬은 감시 범위를 자동으로 넓히거나 전체 데몬 설정을 바꾸지 않습니다. 여러
에이전트 세션은 하나의 데몬과 브라우저를 공유합니다.
