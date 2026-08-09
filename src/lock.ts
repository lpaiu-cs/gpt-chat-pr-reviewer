/**
 * 단일 인스턴스 잠금 — 같은 dataDir 을 두 프로세스가 동시에 쓰지 못하게 한다.
 *
 * `store.ts` 에는 잠금이 없다. `saveContext` 는 맨 `writeFileSync` 이고 리뷰 라운드
 * 하나는 2~15분 동안 read-modify-write 를 붙잡는다. 그래서 watch 두 개, 혹은
 * watch + review 가 동시에 돌면 서로의 결과를 덮어쓴다 — 라운드 결과가 사라지거나,
 * 같은 PR 을 동시에 리뷰해 중복 코멘트를 게시한다.
 *
 * 지금까지 이건 문서에만 적혀 있었고 아무것도 막지 않았다. **실제로 사고가 났다**:
 * watch 가 꺼진 줄 알고 하나 더 띄운 상태에서, 대시보드 POST 가 의도한 쪽이 아니라
 * 다른 인스턴스로 들어가 제외해둔 PR 의 리뷰가 시작됐다.
 *
 * 대시보드 포트가 사실상 그 신호였는데, 포트 폴백(4478 이 막히면 4479로)이 그걸
 * 지워서 중복이 정상처럼 보였다. 그래서 **UI 서버를 띄우기 전에** 여기서 먼저 막는다.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export interface LockInfo {
  pid: number;
  /** ISO 시각 — 사용자에게 "언제부터 돌던 것" 인지 알려주려고 남긴다 */
  startedAt: string;
  /** 'watch' | 'review' 등 — 무엇이 잡고 있는지 */
  command: string;
}

export class LockHeldError extends Error {
  constructor(readonly info: LockInfo) {
    super(
      `이미 다른 프로세스가 실행 중입니다 (pid ${info.pid} · ${info.command} · ` +
        `${new Date(info.startedAt).toLocaleString('ko-KR')} 시작).`,
    );
    this.name = 'LockHeldError';
  }
}

function lockFile(dataDir: string): string {
  return path.join(dataDir, 'watch.lock');
}

/**
 * 그 pid 가 아직 살아 있는가.
 *
 * `kill(pid, 0)` 은 신호를 보내지 않고 존재만 확인한다. EPERM 은 "있는데 내 것이
 * 아니다" 이므로 살아 있는 것으로 본다 — 없다고 판단해 잠금을 뺏는 쪽이 위험하다.
 */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 현재 잠금을 읽는다. 없거나 깨졌거나 주인이 죽었으면 null. */
export function readLock(dataDir: string): LockInfo | null {
  const f = lockFile(dataDir);
  if (!existsSync(f)) return null;
  let info: LockInfo;
  try {
    info = JSON.parse(readFileSync(f, 'utf-8'));
  } catch {
    return null; // 깨진 파일은 잔여물로 본다
  }
  return alive(info.pid) ? info : null;
}

/**
 * 잠금을 잡는다. 이미 살아 있는 주인이 있으면 `LockHeldError`.
 *
 * 주인이 죽은 잔여 잠금(프로세스가 kill -9 등으로 죽은 경우)은 조용히 넘겨받는다 —
 * 그것 때문에 다시 못 뜨면 사용자가 파일을 손으로 지워야 한다.
 *
 * 반환값은 해제 함수다. 프로세스가 죽어도 잔여 잠금은 다음 실행이 정리하므로
 * 해제를 놓쳐도 영구 고장으로 이어지지 않는다.
 */
export function acquireLock(dataDir: string, command: string): () => void {
  mkdirSync(dataDir, { recursive: true });
  const held = readLock(dataDir);
  if (held) throw new LockHeldError(held);

  const f = lockFile(dataDir);
  const info: LockInfo = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    command,
  };
  writeFileSync(f, JSON.stringify(info, null, 2), 'utf-8');

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      // 내가 쓴 것일 때만 지운다. 잔여 잠금을 다른 프로세스가 넘겨받은 뒤라면
      // 그쪽 것을 지워서는 안 된다.
      const cur = existsSync(f) ? (JSON.parse(readFileSync(f, 'utf-8')) as LockInfo) : null;
      if (cur?.pid === process.pid) unlinkSync(f);
    } catch {
      /* 이미 없거나 못 읽어도 무해하다 — 다음 실행이 정리한다 */
    }
  };
}
