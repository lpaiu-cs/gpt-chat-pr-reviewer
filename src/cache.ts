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
  /**
   * **이 응답이 검토한 대상** (`base...head`).
   *
   * --from-cache 는 아무것도 전송하지 않으므로 대상을 다시 알아낼 방법이 없다.
   * 없으면 리뷰가 게시 시점의 최신 커밋에 붙고 그 커밋이 검토 완료로 기록된다 —
   * 보지 않은 코드가 수렴하는 경로가 캐시 재사용에도 그대로 있다.
   */
  headSha?: string;
  baseRef?: string;
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

/**
 * 이 라운드의 응답을 **이미 받아본 적이 있는가.**
 *
 * 대화에 남아 있는 답을 재사용해도 되는지 판정하는 데 쓴다. 파일이 있다는 건
 * 답을 받고도 그 라운드가 실패했다는 뜻이므로(파싱 실패·ACCESS_FAILED·게시 오류)
 * 같은 답을 다시 써봐야 같은 결과다 — 그때는 다시 물어야 한다.
 *
 * 반대로 파일이 없으면 응답을 받기 전에 죽은 것이므로, 대화에 답이 있다면 그건
 * 우리가 아직 못 본 새 답이다.
 */
export function hasResponseForRound(cfg: AppConfig, ctx: PRContext, round: number): boolean {
  return responseTimesForRound(cfg, ctx, round).length > 0;
}

/**
 * **이 전송** 이후에 저장된 응답이 있는가 (`sinceMs` = 전송 시각).
 *
 * 라운드 단위로 보면 안 된다. 2차 첫 응답이 파싱 실패로 저장되고 자동 재시도가
 * 2차 질문을 **다시** 보낸 뒤 응답 대기 중 죽으면, 그 두 번째 전송은 아직 답을
 * 받은 적이 없는데 첫 응답 파일 때문에 회수가 막힌다. 그러면 같은 질문이 또
 * 나가서 — 이 변경이 막으려는 바로 그 낭비가 재발한다.
 *
 * 전송 시각을 모르면(구버전 기록) 라운드 단위로 물러선다. 회수를 놓치는 쪽이
 * 낡은 응답을 게시하는 쪽보다 낫다.
 */
export function hasResponseSince(
  cfg: AppConfig,
  ctx: PRContext,
  round: number,
  sinceMs: number | null,
): boolean {
  if (sinceMs === null) return hasResponseForRound(cfg, ctx, round);
  return responseTimesForRound(cfg, ctx, round).some((t) => t >= sinceMs);
}

/** 해당 라운드로 저장된 응답들의 저장 시각(ms). */
function responseTimesForRound(cfg: AppConfig, ctx: PRContext, round: number): number[] {
  const dir = responsesDir(cfg);
  if (!existsSync(dir)) return [];
  const head = `${prefixFor(ctx)}r${round}__`;
  return readdirSync(dir)
    .filter((f) => f.startsWith(head) && f.endsWith('.txt'))
    .map((f) => {
      try {
        return statSync(path.join(dir, f)).mtimeMs;
      } catch {
        return 0; // 사라졌다 — 없는 것으로 본다
      }
    });
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
