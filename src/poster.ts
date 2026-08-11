/**
 * 파싱된 ReviewResult 를 GitHub PR 에 게시한다.
 *
 * 1. diff 를 가져와 인라인 가능한 (path, line) 을 판별
 * 2. 유효한 코멘트 → 인라인, 유효하지 않은 코멘트 → 리뷰 본문에 포함
 * 3. 인라인 게시 실패 시 전체를 본문 리뷰로 fallback
 */

import chalk from 'chalk';
import type { ReviewResult, DiffHunk, ReviewComment } from './types.js';
import {
  fetchDiff,
  fetchDiffAt,
  parseDiffHunks,
  postReview,
  postSimpleReview,
  ghErrorMessage,
} from './github.js';

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

const EVENT_MAP: Record<string, ReviewEvent> = {
  approve: 'APPROVE',
  request_changes: 'REQUEST_CHANGES',
  comment: 'COMMENT',
};

/**
 * 실제로 사용할 리뷰 이벤트를 결정한다.
 *
 * GitHub 은 본인이 작성한 PR 에 APPROVE / REQUEST_CHANGES 를 허용하지 않는다
 * (422 "Can not request changes on your own pull request").
 * 셀프 리뷰에서는 COMMENT 로 낮추고, 원래 판정은 본문에 남긴다.
 */
export function resolveEvent(
  approval: ReviewResult['approval'],
  isSelfReview: boolean,
): { event: ReviewEvent; downgraded: boolean } {
  const intended = EVENT_MAP[approval] ?? 'COMMENT';
  if (isSelfReview && intended !== 'COMMENT') {
    return { event: 'COMMENT', downgraded: true };
  }
  return { event: intended, downgraded: false };
}

const VERDICT_LABEL: Record<string, string> = {
  approve: '✅ approve — 지적 사항 없음',
  request_changes: '🔧 request_changes — 수정 필요',
  comment: '💬 comment — 개선 제안',
};

export interface PostOptions {
  dryRun?: boolean;
  /** PR 작성자 == 리뷰 계정 인지 여부 */
  isSelfReview?: boolean;
  /** 현재 리뷰 라운드 번호 */
  round?: number;
  /**
   * **모델이 실제로 검토한 커밋.** 리뷰를 여기에 고정한다.
   *
   * 빼면 GitHub 이 게시 시점의 최신 커밋에 리뷰를 붙인다 — 응답을 기다리는 2~15분
   * 사이에 push 가 들어오면 본 적 없는 커밋에 APPROVE 가 직접 달린다. 라인 검증에
   * 쓰는 diff 도 같은 커밋 기준이어야 한다 (아니면 고정한 커밋에 없는 라인에
   * 코멘트를 달아 422 가 난다).
   */
  commitId?: string | null;
  /**
   * 검토 당시의 base ref. 리뷰가 본 diff 는 `base...head` 라 base 도 있어야
   * 같은 기준을 재현할 수 있다 (대기 중 base 가 바뀌었을 수 있다).
   */
  baseRef?: string | null;
}

/** 검토한 대상과 **같은 기준**의 diff 를 가져온다. */
function diffForPost(
  owner: string,
  repo: string,
  prNumber: number,
  commitId: string | null | undefined,
  baseRef: string | null | undefined,
): string {
  if (commitId && baseRef) {
    try {
      return fetchDiffAt(owner, repo, baseRef, commitId);
    } catch {
      console.log(chalk.dim('  검토 시점 기준 diff 를 가져오지 못해 현재 diff 로 검증합니다.'));
    }
  }
  return fetchDiff(owner, repo, prNumber);
}

export function buildReviewBody(
  review: ReviewResult,
  opts: Pick<PostOptions, 'round' | 'isSelfReview'> = {},
): string {
  const { round, isSelfReview = false } = opts;
  const { downgraded } = resolveEvent(review.approval, isSelfReview);

  let body = `## gpt-chat-pr-reviewer`;
  if (round !== undefined) {
    body += ` ${round}차 리뷰`;
  }
  body += `\n\n**판정: ${VERDICT_LABEL[review.approval] ?? review.approval}**`;
  if (downgraded) {
    body += '\n\n> self PR 이므로 코멘트로 게시됩니다.';
  }
  body += `\n\n${review.summary}`;
  return body;
}

export async function postReviewToGitHub(
  owner: string,
  repo: string,
  prNumber: number,
  review: ReviewResult,
  opts: PostOptions = {},
): Promise<void> {
  const { dryRun = false, isSelfReview = false, commitId = null, baseRef = null, round } = opts;

  // ── diff 로 유효 라인 확인 ──
  let hunks: DiffHunk[] = [];
  try {
    hunks = parseDiffHunks(diffForPost(owner, repo, prNumber, commitId, baseRef));
  } catch {
    console.log(chalk.yellow('  diff 를 가져올 수 없어 모든 코멘트를 본문에 포함합니다.'));
  }

  const valid: ReviewComment[] = [];
  const invalid: ReviewComment[] = [];

  for (const c of review.comments) {
    const hunk = hunks.find((h) => h.path === c.path);
    if (hunk && hunk.lines.has(c.line)) {
      valid.push(c);
    } else {
      invalid.push(c);
    }
  }

  const { event, downgraded } = resolveEvent(review.approval, isSelfReview);

  // ── 리뷰 본문 구성 ──
  let body = buildReviewBody(review, { round, isSelfReview });
  if (invalid.length > 0) {
    body += '\n\n---\n\n### Non-inline Review Comments\n';
    for (const c of invalid) {
      body += `\n- **\`${c.path}:${c.line}\`** — ${c.body}`;
    }
  }

  // ── dry-run ──
  if (dryRun) {
    console.log(chalk.cyan('\n  [DRY RUN] 게시 예정 리뷰:'));
    console.log(chalk.dim(`  Event: ${event}${downgraded ? ' (셀프 리뷰로 하향)' : ''}`));
    if (commitId) console.log(chalk.dim(`  대상: ${baseRef ?? '?'}...${commitId}`));
    console.log(chalk.dim(`  인라인 코멘트: ${valid.length}개`));
    console.log(chalk.dim(`  본문 포함 코멘트: ${invalid.length}개`));
    console.log(chalk.dim(`  ---\n${body}\n  ---`));
    for (const c of valid) {
      console.log(chalk.dim(`    ${c.path}:${c.line} — ${c.body.slice(0, 80)}`));
    }
    return;
  }

  // ── 게시 ──
  try {
    if (valid.length > 0) {
      postReview(owner, repo, prNumber, body, event, valid, commitId);
    } else {
      postSimpleReview(owner, repo, prNumber, body, event, commitId);
    }
    console.log(
      chalk.green(`  ✓ 리뷰 게시 완료 (인라인 ${valid.length}개 · 본문 ${invalid.length}개)`),
    );
    return;
  } catch (err) {
    console.log(chalk.yellow(`  ⚠ 인라인 게시 실패 — ${ghErrorMessage(err)}`));
  }

  // ── 폴백: 인라인 없이 본문 전체로 재시도 ──
  const allBody =
    body +
    '\n\n---\n\n### 전체 코멘트\n' +
    [...valid, ...invalid].map((c) => `\n- **\`${c.path}:${c.line}\`** — ${c.body}`).join('');

  try {
    postSimpleReview(owner, repo, prNumber, allBody, event, commitId);
    console.log(chalk.green('  ✓ 리뷰 게시 완료 (본문 포함)'));
    return;
  } catch (err) {
    const msg = ghErrorMessage(err);
    // 이벤트 자체가 거부된 경우 COMMENT 로 한 번 더 시도
    if (event !== 'COMMENT' && /own pull request|event/i.test(msg)) {
      console.log(chalk.yellow(`  ⚠ ${msg} — COMMENT 로 재시도`));
      postSimpleReview(owner, repo, prNumber, allBody, 'COMMENT', commitId);
      console.log(chalk.green('  ✓ 리뷰 게시 완료 (COMMENT 로 하향)'));
      return;
    }
    throw new Error(`리뷰 게시 실패: ${msg}`);
  }
}
