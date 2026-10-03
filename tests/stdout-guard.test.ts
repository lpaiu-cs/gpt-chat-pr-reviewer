import test from 'node:test';
import assert from 'node:assert/strict';

test('테스트 자식의 console 은 러너 채널(stdout)에 쓰지 않는다', () => {
  // 동기 구간 안에서만 바꾼다 — 비동기로 흘러가는 리포터 프레임을 삼키면 안 된다.
  const original = process.stdout.write;
  let leaked = '';
  process.stdout.write = ((chunk: string | Uint8Array) => { leaked += String(chunk); return true; }) as typeof process.stdout.write;
  try { console.log('⚠ 한글 로그'); } finally { process.stdout.write = original; }
  assert.equal(leaked, '', 'npm test 로 실행하세요 — tests/stdout-guard.ts 를 --import 로 실어야 한다');
});
