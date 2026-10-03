// `node --test` 자식 프로세스의 stdout 은 러너와 주고받는 직렬화 채널이다 — console 은 stderr 로 보낸다.
// Node 22 러너(internal/test_runner/runner.js #processRawBuffer)는 메시지 하나를 읽은 뒤 같은 청크의
// 나머지가 다음 헤더라고 가정하고, 뒤에 붙은 로그의 3~6번째 바이트를 길이로 읽는다. 한글(UTF-8 ≥ 0x80)
// 이면 `<< 24` 가 음수가 되어 길이 검사를 통과하고 쓰레기를 역직렬화한다 → "Unable to deserialize cloned
// data" 로 파일째 실패하고 남은 테스트가 사라진다. stderr 는 줄 단위로만 읽어 안전하다 (upstream 은 수정됨).
import { Console } from 'node:console';

if (process.env.NODE_TEST_CONTEXT === 'child-v8') {
  globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
}
