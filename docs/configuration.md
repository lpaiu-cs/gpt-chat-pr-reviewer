# 설정과 감시 범위

[README로 돌아가기](../README.md)

## 설정 파일 만들기

```bash
npm run dev -- init
```

다음 파일이 생성됩니다.

- `pr-review.config.json`: 실행과 감시 범위 설정
- `instructions.md`: 매 리뷰에 포함할 맞춤 지침

## 감시 범위

`watch.mode`와 `watch.include`가 새로 추적할 대상을 정합니다.

| mode | 대상 |
|---|---|
| `account` | 계정이나 조직에서 열린 PR이 있는 레포를 자동 발견 |
| `repos` | 지정한 `owner/repo`만 감시 |
| `review-requested` | 현재 `gh` 계정에 리뷰가 요청된 PR만 감시 |

### 전체 예시

```jsonc
{
  "watch": {
    "mode": "account",
    "include": ["myorg/*"],
    "exclude": ["*/archived-*"],
    "filters": {
      "authors": ["octocat"],
      "labels": ["needs-review"],
      "draft": false,
      "skip": ["myorg/api#12"],
      "only": ["myorg/web#34"]
    },
    "discoveryIntervalMs": 30000
  }
}
```

`account` 모드에서는 글롭을 사용할 수 있습니다. 슬래시 없는 값은
`owner/*`로 해석합니다. `repos` 모드에서는 정확한 `owner/repo`만 사용하세요.

### 필터

필터는 모두 AND로 적용됩니다. `filters`가 없으면 draft PR은 기본적으로
제외됩니다.

| 키 | 의미 |
|---|---|
| `authors` | 지정한 작성자의 PR만 허용 |
| `labels` | 지정한 라벨 중 하나 이상이 있는 PR만 허용 |
| `draft` | `true`이면 draft PR도 허용 |
| `skip` | 정확한 `owner/repo#number`를 제외 |
| `only` | 정확한 `owner/repo#number`만 리뷰 |

`skip`과 `only`가 겹치면 `skip`이 우선합니다. 형식이 잘못된 항목은
`watch` 시작 시 경고합니다.

`skip`과 `only`는 추적 자체를 끊지 않습니다. 제외된 PR도 상태가 갱신되고
대시보드에 표시되지만 리뷰 대기열에는 올라오지 않습니다.

### PR 하나만 리뷰하기

다른 PR도 관측하면서 하나만 실제 리뷰하려면 다음처럼 설정합니다.

```jsonc
{
  "watch": {
    "mode": "account",
    "include": ["myorg/*"],
    "filters": {
      "only": ["myorg/api#34"]
    }
  }
}
```

## 주요 설정값

| 키 | 기본값 | 설명 |
|---|---:|---|
| `watchIntervalMs` | `10000` | 기본 폴링 간격 |
| `probeIdleIntervalMs` | `60000` | 즉시 응답을 기다리지 않는 레포의 폴링 간격 |
| `quotaCooldownMs` | `10800000` | ChatGPT 한도 도달 후 대기 시간 |
| `maxAutoRetries` | `2` | 실패한 리뷰의 자동 재시도 횟수 |
| `maxTurnsPerConversation` | `10` | 한 ChatGPT 대화에서 보낼 최대 프롬프트 수 |
| `headless` | `true` | 창 없는 Chrome 실행. setup은 로그인·프로젝트 선택을 위해 창을 표시 |
| `browserChannel` | `chrome` | Playwright 브라우저 채널 |
| `chatgptProjectUrl` | setup에서 등록 | 실제 리뷰에 필수인 ChatGPT 프로젝트 URL |
| `chatgptProjectName` | setup에서 등록 | 사이드바 탐색용 이름. 진입 후 URL의 프로젝트 ID를 대조 |
| `selectors` | — | ChatGPT UI 셀렉터 오버라이드 |
| `promptTemplate` | — | 리뷰 프롬프트 템플릿 |

### 자동 리뷰 대화를 ChatGPT 프로젝트에 모으기

`npm run dev -- setup`은 로그인 후 리뷰 전용 프로젝트를 만들거나 열도록 안내합니다.
프로젝트 홈에서 입력창이 보이면 터미널에서 Enter를 누르세요. 이름과 URL을 자동으로 읽고,
홈으로 돌아갔다가 자동으로 다시 진입하는 검증을 통과해야 `pr-review.config.json`에 저장합니다.
비대화형 실행에서는 `setup --project-url <URL> --project-name "이름"` 또는 저장된 URL과 이름이 필요합니다.
프로젝트는 사이드바에 고정해 두세요. 같은 이름이 여럿이면 유일한 이름으로 변경한 뒤 다시 등록하세요.
일반 Chrome과 자동화 프로필은 계정이 다를 수 있으므로 setup이 표시하는 계정과 프로젝트를 확인하세요.

직접 설정할 경우 다음 형식을 사용합니다.

```json
{
  "chatgptProjectUrl": "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/project",
  "chatgptProjectName": "PR 자동 리뷰"
}
```

설정 변경 후 데몬을 정상 종료하고 다시 시작하면 적용됩니다. 실행 중인 리뷰가 있다면 완료될 때까지 기다립니다.

```bash
npm run dev -- stop
# 기존 데몬 종료를 확인한 뒤
node scripts/daemon.mjs ensure
```

새 대화와 회전된 대화는 지정한 프로젝트에서 시작하며, 같은 프로젝트의 PR 대화는 기존대로 이어 씁니다. 프로젝트를 변경하면 다음 전송은 새 위치에서 시작합니다. 프로젝트 접근 실패나 일반 대화로의 리다이렉트는 오류로 처리하며 프로젝트 밖으로 대신 전송하지 않습니다.

기존 대화를 자동 이동하거나 삭제하지는 않습니다. 새 설정은 이후 생성·전송에 적용됩니다. 프로젝트 URL이 없거나 빈 문자열이면 실제 리뷰는 실행하지 않고 setup을 안내합니다. 관측 전용 `watch --observe`와 설정 조회는 프로젝트 없이 사용할 수 있습니다. 자동화 Chrome 프로필의 계정에도 해당 프로젝트 접근 권한이 있어야 합니다.

프로젝트 이름을 정하거나 변경하면 주소의 `g-p-<ID>` 뒤에 이름이 붙거나 바뀔 수 있습니다.
프로젝트 ID와 대화 ID가 같으면 같은 대화로 인식하므로, 이름이 바뀐 주소로 리다이렉트되어도 기존 대화와 응답 캐시를 유지합니다.
주소를 직접 열면 실패하지만 사이드바에서 열면 성공하는 경우가 있어 자동화는 화면 내부 이동을 사용합니다.
프로젝트 홈 버튼은 Enter로 실행하므로 마우스 호버와 창을 앞으로 가져오는 동작이 필요하지 않습니다.
기존 빈 프로젝트 홈은 재사용하며, 입력창에 작성 중인 내용이 있으면 덮어쓰지 않고 중단합니다.
프로젝트 이름을 바꾸거나 진입에 실패하면 setup에서 해당 프로젝트를 다시 열어 등록하세요.

```bash
npm run dev -- stop
# 기존 데몬이 종료된 뒤
npm run dev -- setup
npm run dev -- project-check --repeat 3
node scripts/daemon.mjs ensure
```

입력창 오류가 반드시 이름 변경 때문인 것은 아닙니다. 최신 URL에서도 실패하면 자동화 프로필의 로그인·프로젝트 접근 권한과 입력창 표시 여부를 확인하세요. 오류에는 현재 주소와 원래 실패 원인이 함께 기록됩니다.

watch의 `ready=true`는 로그인뿐 아니라 프로젝트 자동 진입도 통과한 뒤에만 표시됩니다.
`project-check`는 응답을 생성하거나 GitHub 리뷰를 게시하지 않습니다. 기본은 설정된 Chrome 실행 방식이며,
`--headless`로 창 없는 실행을 명시할 수도 있습니다. 구버전 설정의 `headless: false`는 유지되므로
포커스를 뺏지 않는 자동 실행을 원하면 `true`로 바꾸세요. 창을 표시하는 `false` 모드는 기동 시 포커스가 이동할 수 있습니다.

[ChatGPT 프로젝트 안내](https://learn.chatgpt.com/docs/projects)에 따라 프로젝트의 지침과 자료도 대화에 적용됩니다. 리뷰 전용으로 사용할 지침·자료만 넣어 두세요. 실제 프로젝트 UI의 입력창이나 URL 형식이 바뀌면 드라이버 업데이트가 필요할 수 있습니다.

### 탐색 주기와 GitHub 비용

- 레포 탐색은 계정이나 조직 단위 검색입니다.
- 실제 변화 확인은 레포 단위 GraphQL 조회입니다.
- 스레드 해결을 기다리는 레포는 기본 주기로 확인하고, 나머지는
  `probeIdleIntervalMs`에 맞춰 느리게 확인합니다.
- 검색 인덱스는 대상 레포 발견에만 사용하고 새 커밋 감지에는 사용하지 않습니다.

레포 수가 많아 API 사용량이 부담되면 `probeIdleIntervalMs`부터 늘리는 것이
효과적입니다.

## 맞춤 리뷰 지침

`instructions.md`의 내용은 매 리뷰 프롬프트에 포함됩니다.

```markdown
- 코멘트 앞에 심각도를 표기: [P1] 버그·보안 / [P2] 로직·성능 / [P3] 스타일
- 스타일보다 버그·보안·성능을 우선
- 테스트 누락 여부 확인
```

한 번만 다른 지침을 사용하려면:

```bash
npm run dev -- review <pr-url> --instructions <file>
```

실행 중 대시보드에서도 지침을 편집할 수 있습니다. 다음 리뷰 라운드부터
새 내용이 적용됩니다.
