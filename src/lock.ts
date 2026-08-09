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

/**
 * 잔여 잠금 인수 재시도 횟수.
 *
 * 잔여 잠금을 여럿이 동시에 발견하면 치우고 다시 경쟁하는데, 그 경쟁에서 진 쪽은
 * 다음 회차에 살아 있는 주인을 보고 정상적으로 거부된다. 무한 루프를 막는 상한이다.
 */
const STALE_TAKEOVER_ATTEMPTS = 3;

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
  const f = lockFile(dataDir);
  const payload = JSON.stringify(
    { pid: process.pid, startedAt: new Date().toISOString(), command } satisfies LockInfo,
    null,
    2,
  );

  for (let attempt = 0; attempt < STALE_TAKEOVER_ATTEMPTS; attempt++) {
    try {
      // `wx` = 파일이 없을 때만 생성. **확인과 생성이 한 번의 원자적 연산**이다.
      // 읽어보고 없으면 쓰는 방식이면, 거의 동시에 시작한 두 프로세스가 둘 다
      // "없다" 를 보고 각자 써버린다 — 이 잠금이 막으려던 상황이 그대로 재현된다.
      writeFileSync(f, payload, { encoding: 'utf-8', flag: 'wx' });
      return makeRelease(f);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }

    // 이미 있다. 주인이 살아 있으면 거부하고, 죽었으면 치운 뒤 **다시 경쟁**한다.
    // 잔여 잠금을 여럿이 동시에 발견해도 재경쟁의 승자는 wx 가 하나로 정한다.
    const held = readLock(dataDir);
    if (held) throw new LockHeldError(held);
    try {
      unlinkSync(f);
    } catch {
      /* 다른 프로세스가 먼저 치웠다 — 그대로 재시도한다 */
    }
  }

  // 여기까지 왔다 = 잔여 잠금 인수를 연달아 놓쳤다. 경쟁자가 있다는 뜻이므로 거부한다.
  const held = readLock(dataDir);
  throw held
    ? new LockHeldError(held)
    : new Error('잠금을 잡지 못했습니다 — 다른 프로세스와 경쟁 중입니다. 잠시 후 다시 시도하세요.');
}

function makeRelease(f: string): () => void {
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
