/**
 * 단일 인스턴스 잠금 — 같은 dataDir 을 두 프로세스가 동시에 쓰지 못하게 한다.
 *
 * `store.ts` 에는 잠금이 없다. `saveContext` 는 맨 `writeFileSync` 이고 리뷰 라운드
 * 하나는 2~15분 동안 read-modify-write 를 붙잡는다. 그래서 watch 두 개, 혹은
 * watch + review 가 동시에 돌면 서로의 결과를 덮어쓴다 — 라운드 결과가 사라지거나,
 * 같은 PR 을 동시에 리뷰해 중복 코멘트를 게시한다. 실제로 사고가 났다.
 *
 * ## 왜 파일이 아니라 포트인가
 *
 * 파일 기반 잠금의 어려운 부분은 획득이 아니라 **잔여 잠금 인수**다. 그리고 그건
 * 파일 API 만으로는 원리적으로 닫히지 않는다.
 *
 *   - `wx` 배타 생성은 **생성만** 원자화한다. 인수는 "죽었나 보고 → 지우고 → 만든다"
 *     인데 `unlink(경로)` 는 어떤 파일을 지우는지 확인하지 않는다.
 *   - 디렉터리 + `rename` 도 마찬가지다. 같은 경로 인스턴스를 여럿이 옮기면 하나만
 *     이기지만, **이긴 쪽이 그 경로를 다시 만든다.** 늦게 도착한 rename 은 자기가
 *     검사했던 잔여 잠금이 아니라 **새 주인의 멀쩡한 잠금**을 옮겨 버린다.
 *
 * 검사한 잠금과 제거할 잠금의 동일성을 파일 연산으로 보장할 방법이 없다. 그래서
 * **잔여 상태가 아예 생기지 않는 primitive** 로 바꿨다: 루프백 포트 바인딩이다.
 * 커널이 "정확히 하나" 를 보장하고, 프로세스가 어떻게 죽든 커널이 포트를 회수한다.
 * 인수 절차 자체가 없어진다.
 *
 * ## 포트 선정과 포트 획득을 분리하는 이유 (실측으로 배운 것)
 *
 * 개발 머신에서 45000–48999 가 **통째로** `EADDRINUSE` 였다. 리스닝 프로세스는 없고
 * `netsh ... show excludedportrange` 에도 안 잡히는 예약이다. 즉 대역을 하나 박아두면
 * 그 머신에서는 도구가 아예 안 뜬다. 그래서 "막혔으면 다음 포트로" 를 획득 루프에
 * 넣었는데, **그게 잠금을 깨뜨렸다.**
 *
 *   10 프로세스 × 60 라운드 · 보유시간 0ms 로 두드리자 상호배제 위반 4건.
 *   `blocked=0` — 아무도 차단되지 않았다. 전부 **다른 포트**를 잡은 것이다.
 *
 * 원인은 한 줄이다: 막힌 포트가 "시스템 예약" 인지 "방금 해제되는 중" 인지 구분할
 * 방법이 없다. 둘 다 `EADDRINUSE` + 접속 거부로 보인다. 경쟁이 심하면 bind 실패와
 * probe 사이에 주인이 바뀌어 `gone` 이 연속으로 나오고, 그때마다 옆 포트로 걸어가
 * **잠금이 N 개로 분열한다.**
 *
 * 그래서 걷는 일은 획득 경로에서 들어냈다:
 *
 *   1. **포트 선정** — `lock.port` 가 없을 때 딱 한 번. 시퀀스를 걸으며 실제로
 *      바인딩되는 포트를 찾아 못 박는다. 동시에 정해도 진 쪽이 **이긴 쪽의 값**을
 *      따르므로 모두 같은 포트로 수렴한다 (자기 후보로 진행하면 잠금이 둘이 된다).
 *      게시는 임시 파일 + `link` 로 원자화한다 — `wx` 는 생성만 배타적이라 진 쪽이
 *      아직 비어 있는 파일을 읽을 수 있다.
 *   2. **포트 획득** — 정해진 **한 포트에서만** 다툰다. 모호하면 그 자리에서
 *      재시도하고, 끝내 안 되면 **거절한다.** 옆으로 새지 않는다.
 *
 * 판단이 흐릴 때 전진하면 중복 실행이고 거절하면 사람이 보고 고친다. 방향이 다르다.
 *
 * `data/watch.lock.json` 은 **사람이 읽을 정보**일 뿐이다 (누가·언제·무엇을·어느 포트).
 * 잠금의 정확성은 전적으로 포트가 책임진다.
 */

import { createServer, connect, type Server, type Socket } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, linkSync } from 'node:fs';
import path from 'node:path';

export interface LockInfo {
  pid: number;
  /** ISO 시각 — 사용자에게 "언제부터 돌던 것" 인지 알려주려고 남긴다 */
  startedAt: string;
  /** 'watch' | 'review' 등 — 무엇이 잡고 있는지 */
  command: string;
}

/** 다른 인스턴스가 이미 돌고 있다 (포트가 우리 인사말로 자기 신원을 밝혔다). */
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
 * 잠금 포트를 쓸 수 없다 — 남의 프로그램이 쓰고 있거나 시스템 예약 구간이다.
 * "이미 돌고 있음" 과 같은 오류로 뭉치면 사용자가 원인을 영영 못 찾는다.
 */
export class LockPortBusyError extends Error {
  constructor(
    readonly ports: number[],
    detail: string,
  ) {
    super(`잠금 포트를 잡지 못했습니다 (${ports.join(', ')}). ${detail}`);
    this.name = 'LockPortBusyError';
  }
}

/** 시작점 대역. 임시 포트(동적) 구간과 겹치지 않게 잡는다. */
const BAND_START = 20_000;
const BAND_SPAN = 1_000;
/** 선정 시퀀스 길이 — 이만큼 연속으로 막혀 있으면 포기하고 원인을 알린다. */
const WALK = 16;

/**
 * dataDir → 선정 시퀀스의 i 번째 후보 포트.
 *
 * **후보일 뿐이다.** 실제로 쓰는 포트는 `lock.port` 에 적힌 값이다 — 시퀀스를 걷는
 * 일은 그 파일이 없을 때 한 번만 일어난다.
 */
export function lockPort(dataDir: string, index = 0): number {
  return BAND_START + (((dirKey(dataDir).readUInt16BE(0) % BAND_SPAN) + index) % BAND_SPAN);
}

function dirKey(dataDir: string): Buffer {
  return createHash('sha1').update(path.resolve(dataDir)).digest();
}

/**
 * 잠금 소켓이 접속자에게 돌려주는 한 줄. **포트 자체가 신원을 밝히게 한다.**
 *
 * 포트가 막혔을 때 "우리 잠금" 인지 "무관한 프로그램" 인지 구분하려면 물어보는
 * 수밖에 없다. 파일에 기대면 그 파일이 없거나 낡았을 때 다시 판정 불가가 된다.
 */
const MAGIC = 'PR-REVIEW-LOCK';
const NEWLINE = String.fromCharCode(10);

/** 포트가 닫히는 중일 때 같은 포트에서 버티는 시간. 옆 포트로 새지 않는다. */
const ACQUIRE_BUDGET_MS = 3_000;
const RETRY_MS = 100;
const PROBE_TIMEOUT_MS = 1_000;
/** 인사말만 받고 안 끊는 접속자를 정리한다 (잠금 소켓은 서비스가 아니다). */
const GREET_IDLE_MS = 5_000;
/** 승자가 쓴 포트 값이 보일 때까지 기다리는 시간. 안 보이면 거절한다. */
const PORTFILE_READ_ATTEMPTS = 20;
const PORTFILE_READ_MS = 50;

function greeting(dataDir: string, info: LockInfo): string {
  return [MAGIC, dirKey(dataDir).toString('hex'), JSON.stringify(info)].join(' ') + NEWLINE;
}

/**
 * 그 포트를 잡고 있는 게 같은 dataDir 의 우리 잠금인지 물어본다.
 *
 *  LockInfo  — 우리 것이다 (주인 정보까지 받았다)
 *  'foreign' — 응답이 우리 형식이 아니다 → 무관한 프로그램
 *  'gone'    — 접속이 안 된다 → 닫히는 중이거나 바인딩 불가 예약
 */
async function probe(dataDir: string, port: number): Promise<LockInfo | 'foreign' | 'gone'> {
  return new Promise((resolve) => {
    const sock = connect({ port, host: '127.0.0.1' });
    const want = `${MAGIC} ${dirKey(dataDir).toString('hex')} `;
    let buf = '';
    let settled = false;
    const done = (r: LockInfo | 'foreign' | 'gone'): void => {
      if (settled) return;
      settled = true;
      // 우리가 먼저 끊는다. 잠금 포트 쪽에 TIME_WAIT 를 남기면 바로 뒤의 재획득이
      // 막혀 잠금이 자기 자신을 밀어내게 된다.
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(PROBE_TIMEOUT_MS, () => done('gone'));
    sock.on('error', () => done('gone'));
    sock.on('close', () => done('gone'));
    sock.on('data', (d) => {
      buf += d.toString('utf-8');
      const nl = buf.indexOf(NEWLINE);
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      if (!line.startsWith(want)) return done('foreign');
      try {
        done(JSON.parse(line.slice(want.length)) as LockInfo);
      } catch {
        done('foreign');
      }
    });
  });
}

/**
 * 지금 이 dataDir 의 잠금을 쥐고 있는 프로세스. **커널이 보증하는 신원**이다.
 *
 * `watch.lock.json`·`daemon.json` 은 안내용이라 강제 종료·크래시 뒤에 남을 수
 * 있고, 그 사이 OS 가 pid 를 재사용하면 거기 적힌 pid 는 **무관한 프로세스**를
 * 가리킨다. 그걸 믿고 kill 하면 남의 프로세스를 죽인다. 포트를 쥔 쪽만이
 * 지금 살아 있는 주인이므로, 죽이기 전에는 반드시 여기에 물어본다.
 */
export async function probeLock(dataDir: string): Promise<LockInfo | 'foreign' | 'gone'> {
  const port = readLockPort(dataDir);
  if (port === null) return 'gone';
  return probe(dataDir, port);
}

function infoFile(dataDir: string): string {
  return path.join(dataDir, 'watch.lock.json');
}

function portFile(dataDir: string): string {
  return path.join(dataDir, 'lock.port');
}

/** 정보 파일에 적힌 주인 (없거나 깨졌으면 null). **잠금 판정에는 쓰지 않는다.** */
export function readLock(dataDir: string): (LockInfo & { port?: number }) | null {
  const f = infoFile(dataDir);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf-8'));
  } catch {
    return null;
  }
}

/** `lock.port` 에 못 박힌 포트 (없거나 이상하면 null). */
export function readLockPort(dataDir: string): number | null {
  try {
    const n = Number.parseInt(readFileSync(portFile(dataDir), 'utf-8').trim(), 10);
    return Number.isInteger(n) && n > 0 && n < 65_536 ? n : null;
  } catch {
    return null;
  }
}

/** 실제로 바인딩되는 포트인지 본다. 예약 구간을 걸러내는 용도다. */
async function canBind(port: number): Promise<boolean> {
  const server = createServer();
  const ok = await new Promise<boolean>((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => resolve(true));
  });
  if (!ok) return false;
  await new Promise<void>((r) => server.close(() => r()));
  return true;
}

/**
 * 정해진 포트를 게시한다. 이미 정해져 있으면 **그 값**을 돌려준다.
 *
 * `wx` 만으로는 부족하다. 배타적인 건 **생성**뿐이고 내용 쓰기는 그 뒤에 따로 일어나,
 * 진 쪽이 `EEXIST` 를 받고 읽었을 때 파일이 아직 비어 있을 수 있다. 그때 자기 후보로
 * 진행하면 둘이 서로 다른 포트를 잡아 **잠금이 분열한다** — 이 잠금이 막으려던 바로
 * 그 사고다. 쓰다 죽어 남은 빈 파일도 같은 분기를 탄다.
 *
 * 그래서 내용을 임시 파일에 **먼저 완성**한 뒤 `link` 로 원자적으로 게시한다.
 * `link` 는 대상이 있으면 실패하므로 배타성과 완전성을 한 번에 준다. 하드링크를
 * 못 쓰는 파일시스템에서만 `wx` 로 물러서고, 어느 경로든 마지막은 같다:
 * **유효한 값이 보일 때까지 기다렸다 그 값을 따른다. 없으면 거절한다.**
 */
async function publishPort(dataDir: string, port: number): Promise<number> {
  const target = portFile(dataDir);
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmp, String(port), 'utf-8');
    try {
      linkSync(tmp, target);
      return port;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
        // 하드링크를 못 쓰는 파일시스템 — 배타 생성으로 물러선다. 이 경로만
        // 내용 게시가 원자적이지 않으므로, 읽는 쪽의 대기가 그 틈을 덮는다.
        try {
          writeFileSync(target, String(port), { encoding: 'utf-8', flag: 'wx' });
          return port;
        } catch {
          /* 남이 먼저 만들었다 — 아래에서 그 값을 기다린다 */
        }
      }
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* 임시 파일이 남아도 다음 실행이 새 이름을 쓴다 */
    }
  }

  // 남이 먼저 정했다 — **그 값**을 따라야 한다. 자기 후보로 진행하면 잠금이 둘이 된다.
  for (let i = 0; i < PORTFILE_READ_ATTEMPTS; i++) {
    const settled = readLockPort(dataDir);
    if (settled !== null) return settled;
    await new Promise((r) => setTimeout(r, PORTFILE_READ_MS));
  }
  throw new LockPortBusyError(
    [port],
    `${target} 가 비었거나 깨졌습니다 (쓰다 만 잔여물일 수 있습니다). 지우고 다시 실행하세요.`,
  );
}

/**
 * 이 dataDir 이 쓸 포트를 **한 번만** 정해 `lock.port` 에 못 박는다.
 * 이후 실행은 걷지 않고 이 파일만 읽는다.
 */
async function resolvePort(dataDir: string): Promise<number> {
  const recorded = readLockPort(dataDir);
  if (recorded !== null) return recorded;

  const walked: number[] = [];
  for (let i = 0; i < WALK; i++) {
    const port = lockPort(dataDir, i);
    walked.push(port);
    if (!(await canBind(port))) continue;
    return publishPort(dataDir, port);
  }
  throw new LockPortBusyError(
    walked,
    '연속된 후보가 전부 막혀 있습니다. 시스템 예약 구간일 수 있습니다.',
  );
}

/**
 * 잠금을 잡는다. 이미 돌고 있으면 `LockHeldError`, 포트를 쓸 수 없으면
 * `LockPortBusyError`.
 *
 * 반환값은 해제 함수다 (멱등). 프로세스가 죽으면 커널이 포트를 회수하므로
 * 해제를 놓쳐도 다음 실행이 막히지 않는다.
 */
export async function acquireLock(dataDir: string, command: string): Promise<() => void> {
  mkdirSync(dataDir, { recursive: true });
  const port = await resolvePort(dataDir);
  const info: LockInfo = { pid: process.pid, startedAt: new Date().toISOString(), command };
  const hello = greeting(dataDir, info);
  const deadline = Date.now() + ACQUIRE_BUDGET_MS;

  for (;;) {
    const live = new Set<Socket>();
    // 접속자에게 신원만 알려주는 소켓. 서비스가 아니라 잠금이다.
    // `end()` 로 먼저 FIN 을 보내면 이 포트에 TIME_WAIT 가 쌓이므로 쓰기만 하고
    // 끊는 건 상대에게 맡긴다.
    const server: Server = createServer((sock) => {
      live.add(sock);
      sock.on('close', () => live.delete(sock));
      sock.on('error', () => sock.destroy());
      sock.setTimeout(GREET_IDLE_MS, () => sock.destroy());
      sock.write(hello);
    });
    server.unref();

    let bindError: NodeJS.ErrnoException | undefined;
    const bound = await new Promise<boolean>((resolve) => {
      server.once('error', (e) => {
        bindError = e as NodeJS.ErrnoException;
        resolve(false);
      });
      server.listen(port, '127.0.0.1', () => resolve(true));
    });

    if (bound) {
      try {
        writeFileSync(infoFile(dataDir), JSON.stringify({ ...info, port }, null, 2), 'utf-8');
      } catch {
        /* 정보 파일은 안내용이다 — 못 써도 잠금 자체는 유효하다 */
      }
      return makeRelease(server, live, dataDir);
    }

    server.close();
    if (bindError && bindError.code !== 'EADDRINUSE') throw bindError;

    const who = await probe(dataDir, port);
    if (who === 'foreign') {
      throw new LockPortBusyError(
        [port],
        `다른 프로그램이 쓰고 있습니다. 그 프로그램을 끄거나 ${portFile(dataDir)} 를 지워 ` +
          '포트를 다시 정하세요.',
      );
    }
    if (who !== 'gone') throw new LockHeldError(who);
    // 'gone' — 닫히는 중일 수 있다. **같은 포트에서** 기다렸다 다시 잡는다.
    // 여기서 옆 포트로 새면 잠금이 분열한다 (실측으로 확인했다 — 파일 상단 참고).
    if (Date.now() >= deadline) {
      throw new LockPortBusyError(
        [port],
        `${ACQUIRE_BUDGET_MS}ms 동안 바인딩되지 않았습니다. 시스템이 예약한 포트라면 ` +
          `${portFile(dataDir)} 를 지워 다시 정하게 하세요.`,
      );
    }
    await new Promise((r) => setTimeout(r, RETRY_MS));
  }
}

function makeRelease(server: Server, live: Set<Socket>, dataDir: string): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // 열려 있는 접속을 끊지 않으면 close() 가 끝나지 않아 포트가 늦게 풀린다.
    for (const sock of live) sock.destroy();
    server.close();
    try {
      // 내가 쓴 것일 때만 지운다. 잔여 정보 파일을 다음 주인이 덮어썼을 수 있다.
      const cur = readLock(dataDir);
      if (cur?.pid === process.pid) unlinkSync(infoFile(dataDir));
    } catch {
      /* 안내용 파일이라 남아도 무해하다 — 다음 획득자가 덮어쓴다 */
    }
  };
}
