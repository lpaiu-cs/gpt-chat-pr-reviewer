/**
 * 실행 중인 데몬의 주소를 알리는 안내 파일 (`data/daemon.json`).
 *
 * 대시보드 포트는 고정이 아니다 — `startUIServer` 는 4478 이 막히면 옆으로
 * 최대 10칸 물러선다. 붙으려는 쪽(스킬 클라이언트 · `stop` 명령)이 상수를
 * 가정하면 조용히 엉뚱한 포트를 두드리거나 "데몬 없음" 으로 오판한다.
 *
 * **잠금이 아니다.** 정확성은 `lock.ts` 의 포트가 전적으로 책임지고, 이 파일은
 * 낡아도 무해하다 — 읽는 쪽은 언제나 `/api/state` 로 살아 있는지 확인한 뒤에
 * 쓰기 때문이다. 그래서 쓰기 실패도 치명적이지 않다 (`watch.lock.json` 과 같은
 * 취급이다).
 *
 * 홈 디렉터리가 아니라 dataDir 에 두는 이유: 설치본마다 dataDir 이 다르고,
 * 잠금도 dataDir 단위다. 홈에 하나만 두면 설치본이 둘일 때 서로를 덮어쓴다.
 */

import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * 이 설치본의 식별자 — 해석된 dataDir 의 해시.
 *
 * 잠금은 dataDir 단위인데 대시보드 포트는 머신 전체에서 공유된다. 체크아웃이
 * 둘이면 (worktree 를 포함해) 서로 다른 설치본의 데몬이 4478·4479 에 동시에
 * 뜰 수 있고, 붙는 쪽이 포트만 보고 고르면 **남의 설정·계정으로** 리뷰를
 * 요청하거나 남의 데몬을 종료한다. 잠금 포트가 `dirKey` 로 신원을 밝히는 것과
 * 같은 이유·같은 방식이다.
 */
export function instanceId(dataDir: string): string {
  return createHash('sha1').update(path.resolve(dataDir)).digest('hex').slice(0, 16);
}

export interface DaemonInfo {
  /** 대시보드 origin — `http://127.0.0.1:4478` */
  ui: string;
  pid: number;
  /** 데몬을 띄운 작업 디렉터리 (설정·dataDir 이 이 경로 상대다) */
  root: string;
  startedAt: string;
  /** 'review' = 리뷰까지 실행 · 'observe' = 관측만 (`--observe`) */
  mode: 'review' | 'observe';
}

function file(dataDir: string): string {
  return path.join(dataDir, 'daemon.json');
}

export function publishDaemonFile(dataDir: string, info: DaemonInfo): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file(dataDir), JSON.stringify(info, null, 2), 'utf-8');
  } catch {
    /* 안내용이다 — 못 써도 데몬은 정상이고, 읽는 쪽에는 포트 폴백이 있다 */
  }
}

export function readDaemonFile(dataDir: string): DaemonInfo | null {
  try {
    return JSON.parse(readFileSync(file(dataDir), 'utf-8')) as DaemonInfo;
  } catch {
    return null;
  }
}

/** 내가 쓴 것일 때만 지운다 — 잔여 파일을 다음 주인이 이미 덮어썼을 수 있다. */
export function clearDaemonFile(dataDir: string): void {
  try {
    if (readDaemonFile(dataDir)?.pid !== process.pid) return;
    unlinkSync(file(dataDir));
  } catch {
    /* 남아도 무해하다 — 읽는 쪽이 /api/state 로 확인한다 */
  }
}
