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

/**
 * 응답 1건의 출처 — 원본 .txt 옆에 같은 이름의 .json 으로 저장한다.
 *
 * 캐시로 게시할 때는 "이 응답이 어느 대화에서 나왔는가" 를 알아야 한다.
 * --from-cache 는 아무것도 전송하지 않으므로, 다른 대화(특히 dry-run 의 일회성
 * 대화)에서 나온 응답을 게시하면 코멘트는 PR 에 남지만 그 내용은 PR 에 묶인
 * 대화 어디에도 없다. 그 불일치를 감지하려면 출처를 남겨야 한다.
 */
export interface ResponseMeta {
  round: number;
  /** 응답을 만들어낸 대화 URL (확보 실패 시 없음) */
  conversationUrl?: string;
  /** dry-run 의 일회성 대화에서 나온 응답인지 */
  dryRun?: boolean;
}

/** 원본 응답과 출처를 저장하고 .txt 경로를 반환한다. */
export function saveResponse(
  cfg: AppConfig,
  ctx: PRContext,
  round: number,
  raw: string,
  meta: Omit<ResponseMeta, 'round'> = {},
): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(responsesDir(cfg), `${prefixFor(ctx)}r${round}__${stamp}`);
  writeFileSync(`${base}.txt`, raw, 'utf-8');
  writeFileSync(`${base}.json`, JSON.stringify({ round, ...meta }, null, 2), 'utf-8');
  return `${base}.txt`;
}

/** 사이드카 출처 파일을 읽는다 (구버전 캐시에는 없다). */
function readMeta(txtPath: string): ResponseMeta | null {
  const fp = txtPath.replace(/\.txt$/, '.json');
  if (!existsSync(fp)) return null;
  try {
    return JSON.parse(readFileSync(fp, 'utf-8'));
  } catch {
    return null;
  }
}

/** 해당 PR 의 가장 최근 응답을 읽는다 (없으면 null). */
export function loadLatestResponse(
  cfg: AppConfig,
  ctx: PRContext,
): { path: string; raw: string; meta: ResponseMeta | null } | null {
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
  return {
    path: latest.path,
    raw: readFileSync(latest.path, 'utf-8'),
    meta: readMeta(latest.path),
  };
}
