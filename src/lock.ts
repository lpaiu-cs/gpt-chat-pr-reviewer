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
 * ## 왜 디렉터리인가
 *
 * 잠금의 어려운 부분은 생성이 아니라 **잔여 잠금 인수**다. 파일 + `wx` 로는 생성만
 * 원자화된다. 인수는 "읽어서 죽었나 보고 → 지우고 → 새로 만든다" 인데, `unlink(경로)`
 * 는 **어떤 파일을 지우는지 확인하지 않는다.** 그래서 A 가 인수를 마친 직후 B 가
 * 자기가 봤던 잔여 잠금인 줄 알고 **A 의 멀쩡한 잠금을 지운다.** 그러면 둘 다 돈다.
 *
 * 디렉터리는 `rename` 이 그 문제를 풀어준다 — 같은 디렉터리를 두 프로세스가 옮기려
 * 하면 **하나만 성공하고** 진 쪽은 ENOENT 를 받는다. 인수 자체가 원자적이 된다.
 *
 *   data/watch.lock/            ← 이 디렉터리의 존재가 잠금
 *   data/watch.lock/owner.json  ← 누가 잡았는지 (mkdir 직후에 쓴다)
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  renameSync,
  statSync,
} from 'node:fs';
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
 * 인수 경쟁에서 진 쪽은 다음 회차에 새 주인을 보고 정상 거부되므로 한 번이면
 * 충분하지만, 연속 인수(주인이 계속 죽는 상황)를 위해 여유를 둔다.
 */
const TAKEOVER_ATTEMPTS = 3;

/**
 * `owner.json` 을 아직 못 읽을 때 "방금 만들어진 잠금" 으로 봐줄 시간.
 *
 * `mkdir` 과 `owner.json` 쓰기 사이에는 틈이 있다. 그 순간 읽은 쪽이 "깨졌으니
 * 잔여물" 로 판단하면 **막 획득한 정상 잠금을 뺏는다.** 반대로 영원히 살아있다고
 * 보면 진짜 깨진 잠금이 영구 고장이 되므로, 이 시간이 지나면 잔여물로 본다.
 */
const OWNER_WRITE_GRACE_MS = 10_000;

function lockDir(dataDir: string): string {
  return path.join(dataDir, 'watch.lock');
}

function ownerFile(dir: string): string {
  return path.join(dir, 'owner.json');
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

/** 잠금 디렉터리의 상태. */
type LockState =
  | { kind: 'free' }
  | { kind: 'held'; info: LockInfo }
  /** 주인이 죽었거나 오래도록 owner.json 이 없다 — 인수 대상 */
  | { kind: 'stale' }
  /** 방금 만들어져 owner.json 을 아직 못 읽는다 — 건드리면 안 된다 */
  | { kind: 'settling' };

function inspect(dataDir: string): LockState {
  const dir = lockDir(dataDir);
  if (!existsSync(dir)) return { kind: 'free' };

  let info: LockInfo | null = null;
  try {
    info = JSON.parse(readFileSync(ownerFile(dir), 'utf-8'));
  } catch {
    // owner.json 이 없거나 아직 덜 쓰였다. 방금 만들어진 것이면 기다려 준다.
    let age = Number.POSITIVE_INFINITY;
    try {
      age = Date.now() - statSync(dir).mtimeMs;
    } catch {
      /* 그 사이에 사라졌다 — 자유로 본다 */
      return { kind: 'free' };
    }
    return age < OWNER_WRITE_GRACE_MS ? { kind: 'settling' } : { kind: 'stale' };
  }

  return info && alive(info.pid) ? { kind: 'held', info } : { kind: 'stale' };
}

/** 현재 잠금의 주인 (살아 있는 주인이 없으면 null). */
export function readLock(dataDir: string): LockInfo | null {
  const st = inspect(dataDir);
  return st.kind === 'held' ? st.info : null;
}

/**
 * 잠금을 잡는다. 이미 살아 있는 주인이 있으면 `LockHeldError`.
 *
 * 반환값은 해제 함수다 (멱등). 프로세스가 죽어도 잔여 잠금은 다음 실행이 인수하므로
 * 해제를 놓쳐도 영구 고장으로 이어지지 않는다.
 */
export function acquireLock(dataDir: string, command: string): () => void {
  mkdirSync(dataDir, { recursive: true });
  const dir = lockDir(dataDir);

  for (let attempt = 0; attempt < TAKEOVER_ATTEMPTS; attempt++) {
    try {
      // mkdir 은 이미 있으면 EEXIST 로 실패한다 — 생성 경쟁의 승자가 하나로 정해진다.
      mkdirSync(dir);
      const info: LockInfo = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        command,
      };
      writeFileSync(ownerFile(dir), JSON.stringify(info, null, 2), 'utf-8');
      return makeRelease(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }

    const st = inspect(dataDir);
    if (st.kind === 'held') throw new LockHeldError(st.info);
    if (st.kind === 'settling') {
      // 누군가 막 잡았다. 다음 회차에 owner.json 을 읽고 정상 거부된다.
      continue;
    }
    if (st.kind === 'stale') {
      // **인수는 rename 으로 경쟁한다.** 같은 디렉터리를 여럿이 옮기려 하면 하나만
      // 성공하고 나머지는 ENOENT 를 받는다. unlink 로 지우면 "내가 본 그 잠금" 인지
      // 확인할 방법이 없어, 그 사이 새로 획득된 정상 잠금을 지울 수 있다.
      const parked = `${dir}.stale-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        renameSync(dir, parked);
      } catch {
        continue; // 경쟁에서 졌다 — 다음 회차에 새 주인을 보고 거부된다
      }
      rmSync(parked, { recursive: true, force: true });
    }
  }

  const st = inspect(dataDir);
  if (st.kind === 'held') throw new LockHeldError(st.info);
  throw new Error('잠금을 잡지 못했습니다 — 다른 프로세스와 경쟁 중입니다. 잠시 후 다시 시도하세요.');
}

function makeRelease(dir: string): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      // **내가 주인일 때만** 지운다. 잔여 잠금을 다른 프로세스가 인수한 뒤라면
      // 그쪽 것을 지워서는 안 된다.
      const info: LockInfo = JSON.parse(readFileSync(ownerFile(dir), 'utf-8'));
      if (info.pid === process.pid) rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 이미 없거나 못 읽어도 무해하다 — 다음 실행이 인수한다 */
    }
  };
}
