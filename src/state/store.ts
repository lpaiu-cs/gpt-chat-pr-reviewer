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

export function createContext(pr: PRInfo): PRContext {
  const now = new Date().toISOString();
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
