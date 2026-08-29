/**
 * PR 컨텍스트 영속화 — data/state/<owner>__<repo>__<number>.json
 *
 * 파일 하나 = PR 하나. 상태·라운드·스레드·이벤트 히스토리를 모두 담아
 * status/graph 명령과 향후 UI 가 그대로 읽을 수 있다.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { AppConfig, PRContext, PRInfo } from '../types.js';

function stateDir(cfg: AppConfig): string {
  const d = path.join(cfg.dataDir, 'state');
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

function fileFor(cfg: AppConfig, owner: string, repo: string, num: number): string {
  return path.join(stateDir(cfg), `${owner}__${repo}__${num}.json`);
}

// ── CRUD ────────────────────────────────────────────────────

/**
 * @param at 이 PR 을 **처음 본 시각** (ISO). 생략하면 지금.
 *
 * **한 스캔에서 발견한 PR 들은 같은 값을 받아야 한다.** 큐는 같은 티어 안에서
 * 대기 시각이 이른 것을 먼저 돌리는데(`buildQueue` — 오래 기다린 것 먼저),
 * 신규 컨텍스트의 대기 시각은 이 `createdAt` 이다. PR 마다 시각을 따로 찍으면
 * 스캔 한 번 안의 밀리초 차이가 곧 처리 순서가 되고, probe 는 GitHub 이 주는
 * 순서(최근 갱신 순 ≈ 번호 내림차순)로 돌기 때문에 **번호가 큰 것부터** 처리된다.
 * 실측: 데몬을 새로 띄우자 3.2초 안에 만들어진 7건이 #7 → #1 로 거꾸로 돌았다.
 *
 * 같은 값을 주면 동점이 되어 다음 기준(PR 번호 오름차순)이 순서를 정한다 —
 * 번호가 작을수록 먼저 열린 PR 이므로 그게 사람이 기대하는 순서다.
 * scan 이 레포별 주기 판정에 스캔 단위 `now` 를 쓰는 것과 같은 이유다.
 */
export function createContext(pr: PRInfo, at?: string): PRContext {
  const now = at ?? new Date().toISOString();
  return {
    prUrl: pr.url,
    owner: pr.owner,
    repo: pr.repo,
    prNumber: pr.number,
    title: pr.title,
    author: pr.author,
    state: 'REVIEW_DUE',
    round: 0,
    requestedCount: 0,
    headShaAtLastReview: null,
    threads: [],
    retryCount: 0,
    history: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function loadContext(
  cfg: AppConfig,
  owner: string,
  repo: string,
  num: number,
): PRContext | null {
  const fp = fileFor(cfg, owner, repo, num);
  if (!existsSync(fp)) return null;
  try {
    return JSON.parse(readFileSync(fp, 'utf-8'));
  } catch {
    return null;
  }
}

export function saveContext(cfg: AppConfig, ctx: PRContext): void {
  writeFileSync(fileFor(cfg, ctx.owner, ctx.repo, ctx.prNumber), JSON.stringify(ctx, null, 2), 'utf-8');
}

/** 추적 중인 모든 PR 컨텍스트 (최근 업데이트 순). */
export function listContexts(cfg: AppConfig): PRContext[] {
  const dir = stateDir(cfg);
  const out: PRContext[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(readFileSync(path.join(dir, f), 'utf-8')));
    } catch {
      /* 손상된 파일 스킵 */
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
