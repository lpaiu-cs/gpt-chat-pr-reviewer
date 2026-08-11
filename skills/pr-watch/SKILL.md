---
name: pr-watch
description: GitHub PR 의 상태 변화(새 커밋·리뷰 코멘트 게시·스레드 resolve·머지/닫힘)를 추적하고 변화가 생기면 알려준다. 사용자가 "이 PR 지켜봐 / 뭔가 올라오면 알려줘 / PR 상태 어때" 라고 하거나, PR 을 올린 뒤 반응을 기다려야 할 때 사용한다. 브라우저와 ChatGPT 한도를 쓰지 않는다.
---

# PR 상태 추적

로컬 데몬이 GitHub 을 폴링하며 PR 상태를 추적한다. 이 스킬은 그 관측값만
쓴다 — **리뷰를 실행하지 않으므로 ChatGPT 한도도 브라우저도 쓰지 않는다.**
(리뷰까지 돌리려면 `pr-review` 스킬을 쓴다.)

```
node "{{DAEMON}}" <동사> [인자]
```

## 절차

**1. 추적 대상에 넣기** — 레포 단위로 감시 범위에 추가한다.

```bash
node "{{DAEMON}}" track owner/repo#12
```

데몬이 없으면 같이 띄운다. **새로 띄웠다면** 출력의 대시보드 주소와 종료
방법을 사용자에게 그대로 전달한다.

**2. 현황 보기**

```bash
node "{{DAEMON}}" status --pr owner/repo#12
node "{{DAEMON}}" status --json          # 전체, 기계 판독용
```

**3. 변화 대기** — **백그라운드로** 실행한다 (Bash 도구의 `run_in_background`).

```bash
node "{{DAEMON}}" wait owner/repo#12 --timeout 3600
```

이벤트 하나를 받으면 종료한다. 출력 첫 낱말이 이벤트다:
`posted`(리뷰 코멘트 게시) · `converged`(approve) · `failed` · `quota` ·
`closed`(머지/닫힘) · `timeout`.

## 상태 읽는 법

| 상태 | 뜻 |
|---|---|
| `REVIEW_DUE` | 리뷰 차례를 기다리는 중 |
| `REVIEWING` | 지금 리뷰가 도는 중 |
| `AWAITING_AUTHOR` | 코멘트가 게시됨 — 작성자 대응 대기 |
| `CONVERGED` | approve, 수렴 |
| `QUOTA_BLOCKED` | ChatGPT 한도 — 쿨다운 후 자동 재개 |
| `ERROR` | 라운드 실패 — 자동 재시도한다 |
| `CLOSED` | 머지되거나 닫힘 |

## 하지 말 것

데몬은 **여러 세션이 함께 쓴다.**

- **끄거나 재시작하지 않는다.** 종료는 사용자 몫이다 (대시보드 종료 버튼 ·
  `npm run dev -- stop`).
- **감시 범위를 통째로 바꾸지 않는다.** `track` 은 추가만 한다.
  `scope-set` · `only-set` 을 HTTP 로 직접 부르면 다른 세션의 PR 이 사라진다.
- 사용자가 "그만 봐" 라고 하면 범위에서 빼는 대신 **대기를 멈추는 것**으로
  충분한 경우가 많다. 범위 변경은 사용자에게 확인한다.
