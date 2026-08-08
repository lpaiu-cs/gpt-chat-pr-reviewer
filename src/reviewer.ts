/**
 * 리뷰 오케스트레이션.
 *
 *  syncPR   — GitHub 현황을 컨텍스트와 대조해 상태 머신 이벤트를 발화
 *             (PR 닫힘 / 작성자 응답 / 새 커밋 / 쿨다운 종료 / 중단 복구 / 자동 재시도)
 *  runRound — REVIEW_DUE 상태의 PR 에 대해 리뷰 라운드 1회를 실행
 *             (START_REVIEW → ChatGPT → 파싱 → 게시 → POSTED_* / QUOTA / FAILED)
 */

import chalk from 'chalk';
import type { AppConfig, PRContext, ReviewResult } from './types.js';
import { fire } from './state/machine.js';
import { saveContext } from './state/store.js';
import {
  fetchPRSyncData,
  getViewerLogin,
  type SyncThread,
} from './github.js';
import { ChatGPTDriver, QuotaLimitError } from './chatgpt.js';
import { parseGPTResponse, isAccessFailure } from './parser.js';
import { postReviewToGitHub } from './poster.js';
import { loadInstructions } from './instructions.js';

// ── 스레드 동기화 ───────────────────────────────────────────

/**
 * GraphQL 스레드 목록에서 우리(뷰어)가 시작한 스레드를 컨텍스트에 병합한다.
 * 새로 발견된 스레드는 roundForNew 라운드 소속으로 기록된다.
 */
export function adoptThreads(
  ctx: PRContext,
  threads: SyncThread[],
  viewer: string,
  roundForNew: number,
): void {
  if (!viewer) return;
  for (const t of threads) {
    const first = t.comments[0];
    if (!first || first.author !== viewer) continue; // 우리가 시작한 스레드만

    const replied = t.comments.slice(1).some((c) => c.author !== viewer);
    const existing = ctx.threads.find((r) => r.id === t.id);
    if (existing) {
      existing.isResolved = t.isResolved;
      existing.authorReplied = replied;
    } else {
      ctx.threads.push({
        id: t.id,
        path: t.path,
        line: t.line,
        isResolved: t.isResolved,
        authorReplied: replied,
        round: roundForNew,
        snippet: first.body.slice(0, 80).replace(/\s+/g, ' '),
      });
    }
  }
}

// ── 동기화 (reconciliation) ─────────────────────────────────

/**
 * GitHub 현황을 가져와 컨텍스트 상태를 전이시킨다.
 * 호출 후 컨텍스트는 저장된 상태다.
 */
export function syncPR(cfg: AppConfig, ctx: PRContext): void {
  let data;
  try {
    data = fetchPRSyncData(ctx.owner, ctx.repo, ctx.prNumber);
  } catch (e) {
    console.log(
      chalk.yellow(`  ⚠ ${ctx.owner}/${ctx.repo}#${ctx.prNumber} 동기화 실패 — 스킵`),
    );
    return;
  }

  let viewer = '';
  try {
    viewer = getViewerLogin();
  } catch {
    /* 오프라인 등 — 스레드 병합만 생략 */
  }
  adoptThreads(ctx, data.threads, viewer, ctx.round);

  // 1. PR 닫힘/머지
  if (data.status !== 'OPEN') {
    if (ctx.state !== 'CLOSED') {
      fire(ctx, 'PR_CLOSED', { note: data.status === 'MERGED' ? '머지됨' : '닫힘' });
    }
    saveContext(cfg, ctx);
    return;
  }

  // 2. 중단된 REVIEWING 복구 (프로세스 크래시 등)
  if (ctx.state === 'REVIEWING') {
    fire(ctx, 'REVIEW_FAILED', { note: '중단된 리뷰 감지 — 복구' });
  }

  // 3. ERROR 자동 재시도
  if (ctx.state === 'ERROR' && ctx.retryCount < cfg.maxAutoRetries) {
    fire(ctx, 'RETRY', {
      note: `자동 재시도 ${ctx.retryCount + 1}/${cfg.maxAutoRetries}`,
      patch: { retryCount: ctx.retryCount + 1 },
    });
  }

  // 4. 쿼터 쿨다운 종료
  if (
    ctx.state === 'QUOTA_BLOCKED' &&
    ctx.quotaRetryAt &&
    Date.now() >= Date.parse(ctx.quotaRetryAt)
  ) {
    fire(ctx, 'COOLDOWN_ELAPSED', { note: '쿼터 쿨다운 종료' });
  }

  // 5. 작성자 응답 감지 (새 커밋 or 마지막 라운드 스레드 전체 resolve)
  if (ctx.state === 'AWAITING_AUTHOR') {
    const headChanged =
      !!ctx.headShaAtLastReview && data.headSha !== ctx.headShaAtLastReview;
    const lastRound = ctx.threads.filter((t) => t.round === ctx.round);
    const allResolved = lastRound.length > 0 && lastRound.every((t) => t.isResolved);
    if (headChanged || allResolved) {
      fire(ctx, 'AUTHOR_RESPONDED', {
        note: headChanged ? '새 커밋 감지' : '전체 스레드 resolve 확인',
      });
    }
  }

  // 6. 수렴 후 새 커밋 → 리뷰 재개
  if (
    ctx.state === 'CONVERGED' &&
    ctx.headShaAtLastReview &&
    data.headSha !== ctx.headShaAtLastReview
  ) {
    fire(ctx, 'NEW_COMMITS', { note: '수렴 후 새 커밋 — 리뷰 재개' });
  }

  saveContext(cfg, ctx);
}

// ── 프롬프트 구성 ───────────────────────────────────────────

function buildPrompt(cfg: AppConfig, ctx: PRContext, round: number, instructions: string): string {
  let previous = '';
  if (round > 1 && ctx.threads.length > 0) {
    const lines = ctx.threads.map((t) => {
      const status = t.isResolved ? '해결됨' : t.authorReplied ? '답변만 있음' : '미해결';
      return `- [${status}] ${t.path}:${t.line ?? '?'} — ${t.snippet}`;
    });
    previous = [
      '## 이전 라운드 코멘트 현황',
      ...lines,
      '',
      '위 코멘트가 실제로 반영되었는지 확인하고, 미반영 항목은 다시 지적해주세요.',
    ].join('\n');
  }

  // 지침은 "리뷰의 제약"임을 명시한다. 이 래핑이 없으면 GPT 가 지침 문서 자체를
  // 주제로 착각해 리뷰 대신 지침을 다듬어 응답하는 경우가 있다.
  const instructionBlock = instructions
    ? [
        '',
        '## 리뷰 지침',
        '아래 지침에 따라 리뷰하세요. 지침 자체를 요약·평가·개선하지 마세요.',
        '',
        instructions,
      ].join('\n')
    : '';

  return cfg.promptTemplate
    .replace(/\{\{instructions\}\}/g, instructionBlock)
    .replace(/\{\{url\}\}/g, ctx.prUrl)
    .replace(/\{\{round\}\}/g, String(round))
    .replace(/\{\{previous\}\}/g, previous ? `\n${previous}` : '')
    .replace(/\n{3,}/g, '\n\n'); // 빈 치환으로 생긴 과잉 공백 정리
}

// ── 리뷰 라운드 실행 ────────────────────────────────────────

/** 응답이 리뷰로 인정되지 않아 게시를 거부했을 때. */
export class ReviewRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewRejectedError';
  }
}

/**
 * 응답을 PR 에 게시해도 되는지 검증한다.
 * 실패 시 원인을 출력하고 false 를 반환한다.
 */
function assertReviewable(result: ReviewResult): boolean {
  if (!result.parsed) {
    console.log(chalk.red('  ✗ 응답에서 리뷰 JSON 을 찾지 못했습니다 — 게시하지 않습니다.'));
    console.log(chalk.dim('    GPT 가 리뷰 대신 다른 답변을 했을 가능성이 높습니다.'));
    console.log(chalk.dim(`    원본 응답 앞부분: ${result.raw.slice(0, 200).replace(/\s+/g, ' ')}…`));
    return false;
  }
  if (isAccessFailure(result)) {
    console.log(chalk.red('  ✗ GPT 가 PR 에 접근하지 못했습니다 (ACCESS_FAILED).'));
    console.log(
      chalk.dim('    비공개 레포라면 ChatGPT 설정에서 GitHub 커넥터를 연결했는지 확인하세요.'),
    );
    return false;
  }
  return true;
}

export type RoundOutcome = 'posted' | 'clean' | 'quota' | 'failed' | 'dry';

export interface RunRoundOptions {
  dryRun?: boolean;
  instructionsFile?: string;
}

/**
 * 리뷰 라운드 1회 실행. 컨텍스트는 REVIEW_DUE 상태여야 한다.
 * dry-run 은 상태를 전이시키지 않고 결과만 출력한다.
 */
export async function runRound(
  cfg: AppConfig,
  driver: ChatGPTDriver,
  ctx: PRContext,
  opts: RunRoundOptions = {},
): Promise<RoundOutcome> {
  const round = ctx.round + 1;
  const instructions = loadInstructions(cfg, opts.instructionsFile);
  const prompt = buildPrompt(cfg, ctx, round, instructions);

  console.log(chalk.bold(`\n  📋 ${ctx.title}`));
  console.log(chalk.dim(`     ${ctx.prUrl}  (${round}차 리뷰${opts.dryRun ? ' · dry-run' : ''})`));

  // ── dry-run: 상태 전이 없이 결과만 ──
  if (opts.dryRun) {
    try {
      await driver.startNewChat();
      const raw = await driver.sendAndCollect(prompt);
      const result = parseGPTResponse(raw);
      if (!assertReviewable(result)) return 'failed';
      console.log(chalk.dim(`  approval=${result.approval}  comments=${result.comments.length}`));
      await postReviewToGitHub(ctx.owner, ctx.repo, ctx.prNumber, result, true);
      console.log(chalk.dim('  (dry-run — 상태 변화 없음)'));
      return 'dry';
    } catch (e) {
      if (e instanceof QuotaLimitError) {
        console.log(chalk.yellow(`  ⚠ 쿼터 한도 — ${e.message}`));
        return 'quota';
      }
      console.error(chalk.red('  ✗ 리뷰 실패:'), String(e).replace(/^Error:\s*/, '').slice(0, 300));
      return 'failed';
    }
  }

  // ── 실제 라운드 ──
  fire(ctx, 'START_REVIEW', { note: `${round}차 리뷰 시작` });
  saveContext(cfg, ctx);

  try {
    await driver.startNewChat();
    const raw = await driver.sendAndCollect(prompt);
    const result = parseGPTResponse(raw);

    // 리뷰가 아닌 응답을 PR 에 게시하지 않는다.
    if (!assertReviewable(result)) {
      throw new ReviewRejectedError(
        result.parsed ? 'GPT 가 PR 에 접근하지 못했습니다' : 'GPT 응답에서 리뷰 JSON 을 찾지 못했습니다',
      );
    }
    console.log(chalk.dim(`  approval=${result.approval}  comments=${result.comments.length}`));

    await postReviewToGitHub(ctx.owner, ctx.repo, ctx.prNumber, result, false);

    // 게시 직후 head SHA · 새 스레드 동기화
    let headSha = ctx.headShaAtLastReview;
    try {
      const sync = fetchPRSyncData(ctx.owner, ctx.repo, ctx.prNumber);
      headSha = sync.headSha;
      adoptThreads(ctx, sync.threads, getViewerLogin(), round);
    } catch {
      console.log(chalk.yellow('  ⚠ 게시 후 스레드 동기화 실패 — 다음 sync 에서 보정됩니다.'));
    }

    const n = result.comments.length;
    const converged = result.approval === 'approve';
    fire(ctx, converged ? 'POSTED_CLEAN' : 'POSTED_COMMENTS', {
      note: `${round}차 완료: 코멘트 ${n}개, approval=${result.approval}`,
      patch: {
        round,
        requestedCount: ctx.requestedCount + n,
        headShaAtLastReview: headSha,
        retryCount: 0,
        lastError: undefined,
      },
    });
    saveContext(cfg, ctx);
    return converged ? 'clean' : 'posted';
  } catch (e) {
    if (e instanceof QuotaLimitError) {
      const retryAt = new Date(Date.now() + cfg.quotaCooldownMs).toISOString();
      fire(ctx, 'QUOTA_EXCEEDED', {
        note: e.message,
        patch: { quotaRetryAt: retryAt },
      });
      saveContext(cfg, ctx);
      console.log(
        chalk.yellow(
          `  ⚠ 쿼터 한도 — ${new Date(retryAt).toLocaleString('ko-KR')} 이후 자동 재시도`,
        ),
      );
      return 'quota';
    }

    const msg = String(e).slice(0, 300);
    fire(ctx, 'REVIEW_FAILED', { note: msg, patch: { lastError: msg } });
    saveContext(cfg, ctx);
    console.error(chalk.red('  ✗ 리뷰 실패:'), msg);
    return 'failed';
  }
}
