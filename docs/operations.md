# 운영 가이드

[README로 돌아가기](../README.md)

## 명령어

| 명령 | 설명 |
|---|---|
| `setup` | ChatGPT 로그인용 브라우저 프로필 생성 |
| `whoami` | 현재 ChatGPT 로그인 상태 확인 |
| `init` | 설정과 맞춤 지침 파일 생성 |
| `instructions` | 맞춤 지침 파일 열기 |
| `review <pr>` | PR 한 건 리뷰 |
| `watch` | 감시 범위를 폴링하고 리뷰 대기열 실행 |
| `queue` | 리뷰 대기열 조회 |
| `status [pr]` | 현재 PR 상태 조회 |
| `rounds <pr>` | 리뷰 라운드 이력 조회 |
| `graph [pr]` | 상태 정보를 Mermaid 텍스트로 출력 |
| `stop` | 실행 중인 watch 종료 |

각 명령의 전체 옵션은 `--help`로 확인할 수 있습니다.

```bash
npm run dev -- review --help
npm run dev -- watch --help
```

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
npm run dev -- watch --observe
```

GitHub 동기화와 대기열 계산만 하고 리뷰는 실행하지 않습니다. Chrome과 ChatGPT
로그인이 필요 없으며 ChatGPT 대화 한도도 사용하지 않습니다.

감시 범위나 필터를 처음 설정했을 때 실제 리뷰 전에 확인하는 용도입니다.

> `--dry-run`은 관측 모드가 아닙니다. 게시만 생략하고 ChatGPT는 호출합니다.

## 대시보드

```bash
npm run dev -- watch --ui
npm run dev -- watch --ui --observe
npm run dev -- watch --ui --ui-port 9000
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
| 헤더 | 일시정지, 감시 범위 편집, 리뷰 지침 편집, 종료 |

감시 범위와 필터 변경은 `pr-review.config.json`에 저장됩니다. 리뷰가 진행 중이면
제어 요청은 라운드가 끝난 뒤 적용되며 화면에 대기 건수가 표시됩니다.

## 안전하게 종료하기

```bash
npm run dev -- stop
npm run dev -- stop --now
```

기본 `stop`은 진행 중인 라운드를 마친 뒤 종료합니다. `--now`는 즉시
종료하므로 이미 생성 중인 응답을 버릴 수 있습니다.

## 이벤트 알림

`watch --ui`의 이벤트 스트림을 구독해 리뷰 결과가 올라올 때 알림을 받을 수
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
