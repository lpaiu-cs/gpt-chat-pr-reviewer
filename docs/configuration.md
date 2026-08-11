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
| `maxTurnsPerConversation` | `5` | 한 ChatGPT 대화에서 보낼 최대 프롬프트 수 |
| `headless` | `false` | Chrome 헤드리스 실행 |
| `browserChannel` | `chrome` | Playwright 브라우저 채널 |
| `selectors` | — | ChatGPT UI 셀렉터 오버라이드 |
| `promptTemplate` | — | 리뷰 프롬프트 템플릿 |

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
