# Chrome 프롬프트 입력 지연 — 관측과 후속 수정

2026-09-09 최초 결정은 기록 후 재발 시 조사였다. 2차 라운드에서 재발했고, PR #35 머지 후 후속 수정을 진행하도록 사용자가 요청했다.

## 관측

- PR #35, head `629879ece05474b87a418b4ea943d6c88d76bd1e`, Playwright 1.62.1.
- prompt 단계 194.8초 후 대화 URL이 저장되고 waiting으로 진행. 이후 1차 리뷰 게시 완료.
- 전달한 고정 diff만 83,852자 / UTF-8 96,341바이트 / 1,996줄.
- 사용자는 자동화 Chrome 탭의 새로고침까지 지연됐지만 다른 앱 및 시스템 전체 부하는 정상이었다고 보고.
- 당시 대시보드 HTTP 응답은 24ms. 탭 crash는 확인되지 않았고 호출별 시간 기록은 없음.
- 2차 prompt 단계는 14:01:31.934–14:09:23.557 UTC, 471.623초였다. 리뷰는 이후 정상 완료했다.
- 자동화 프로필 Chrome의 renderer PID 47864에서 working set 8.153 GiB, private 8.108 GiB를 관측했다. 3.022초 동안 CPU 시간이 3.219초 증가했다. 프로필 소속은 확인했으나 개별 탭과 PID의 직접 대응 및 crash는 확인하지 못했다.

## 후보와 별도 결함

`src/chatgpt.ts`의 `fillPrompt`는 전체 텍스트를 `keyboard.insertText`로 먼저 삽입한다. 설치된 Playwright의 Chromium 구현은 CDP `Input.insertText`로 연결된다. `locator.fill`도 contenteditable 입력에서 같은 경로를 쓰므로 단순 교체만으로 해결된다고 볼 수 없다.

[Playwright 조사 기록](https://github.com/microsoft/playwright/issues/33761#issuecomment-2503341123)은 다중 줄 Input.insertText에서 줄마다 레이아웃 재계산이 발생한다고 설명한다. 이번 사건의 유력 후보이나 실제 탭 성능 trace로 확정하지 않았다.

- 합성 paste의 `dispatchEvent` 반환값을 성공으로 해석하는 결함: 편집기가 내용을 넣고 preventDefault하면 false다. ProseMirror 구현도 이 패턴이다. EventTarget 최소 재현으로 확인했으나 이번 실행에서 폴백 로그는 없었다.
- 마지막 `keyboard.type(text, {delay: 1})` 폴백은 긴 텍스트에서 대량 이벤트와 중복 입력 위험이 있다.
- `inputHasText`는 비어 있지 않은지만 확인한다. 전체 내용 일치를 검증하지 않는다.
- `clickSend`는 중복 셀렉터 후보와 개별 클릭 대기, 조용히 삼키는 오류가 있어 실제 정체 위치를 구분하기 어렵다.

## 후속 수정과 검증

- 대량 `Input.insertText` 대신 편집기의 paste 트랜잭션을 먼저 사용한다. ProseMirror clipboard HTML에 hard break를 넣어 연속 개행과 들여쓰기를 보존한다. 문자열은 HTML escape한다.
- 이벤트 반환값 대신 전체 내용을 비교한다. CRLF 및 마지막 개행 하나의 렌더링 차이만 정규화하며, 부분 입력 위에 재입력하지 않는다. 빈 입력에 한해 4,000자·80줄 이하만 insertText로 폴백한다. 글자별 타이핑은 제거했다.
- 전송 버튼 후보는 하나의 10초 대기 예산을 공유하고 중지 버튼은 제외한다. 성공 여부를 모르는 Enter 재시도는 제거했다.
- 입력 길이·줄 수, 포커스/paste/검증/클릭/전송 확인 시간과 탭 crash 이벤트를 기록한다. 10초 경고는 실행 중 작업을 중단하거나 겹쳐 재시도하지 않는다.
- 회귀 테스트: `npm test`, 92/92 통과. 성공한 preventDefault paste, 부분 입력, 대량 입력의 폴백 금지, 짧은 입력 폴백 검증.
- 격리 Chrome 152.0.7977.83 + ProseMirror view 1.42.3 / basic schema에서 91,203자·7,201줄 입력 224ms (paste 61ms). 한글·HTML 특수문자·연속 개행·반복 공백을 포함한 내부 문서가 원문과 정확히 일치했다. 중지 버튼 옆의 전송 버튼만 클릭됨을 확인했다.
- 이 수치는 로컬 편집기 실험이다. 기존 실제 ChatGPT 측정과 동일 조건의 전후 비교가 아니며, 실서비스에서의 개선율이나 문제 해결 완료를 뜻하지 않는다. 실행 중 공유 데몬에는 아직 이 변경을 적용하지 않았다.

## 실제 적용 후 확인

1. focus / insert 또는 paste / 내용 검증 / click / 전송 확인의 시작·종료 시간을 구분한다. 길이·줄 수와 page crash 이벤트도 기록한다.
2. 진행 중 생성이나 공유 브라우저를 끊지 않는다. 별도 테스트 환경에서 같은 크기의 입력으로 paste와 insertText를 비교한다.
3. paste는 반환값이 아닌 전체 입력 내용으로 검증한다. 대량 글자별 타이핑 제거와 버튼 대기 예산 통합을 우선 검토한다.
4. 고정 diff 전달을 조용히 생략하거나 자르지 않는다. 입력 최적화와 리뷰 대상 보장은 별개다.
