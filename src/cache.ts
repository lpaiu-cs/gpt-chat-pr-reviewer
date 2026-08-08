/**
 * ChatGPT 원본 응답 캐시 — data/responses/
 *
 * 응답을 받은 즉시 저장한다. 게시 단계에서 실패해도 (라인 불일치, 권한,
 * API 오류 등) 대화 한도를 다시 쓰지 않고 `review --from-cache` 로
 * 파싱·게시만 재시도할 수 있다.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AppConfig, PRContext } from './types.js';

function responsesDir(cfg: AppConfig): string {
  const d = path.join(cfg.dataDir, 'responses');
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

function prefixFor(ctx: PRContext): string {
  return `${ctx.owner}__${ctx.repo}__${ctx.prNumber}__`;
}

/** 원본 응답을 저장하고 경로를 반환한다. */
export function saveResponse(cfg: AppConfig, ctx: PRContext, round: number, raw: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fp = path.join(responsesDir(cfg), `${prefixFor(ctx)}r${round}__${stamp}.txt`);
  writeFileSync(fp, raw, 'utf-8');
  return fp;
}

/** 해당 PR 의 가장 최근 응답을 읽는다 (없으면 null). */
export function loadLatestResponse(
  cfg: AppConfig,
  ctx: PRContext,
): { path: string; raw: string } | null {
  const dir = responsesDir(cfg);
  const prefix = prefixFor(ctx);

  const candidates = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.txt'))
    .map((f) => {
      const fp = path.join(dir, f);
      return { path: fp, mtime: statSync(fp).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  if (candidates.length === 0) return null;
  const latest = candidates[0];
  return { path: latest.path, raw: readFileSync(latest.path, 'utf-8') };
}
