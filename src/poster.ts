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
}

export async function postReviewToGitHub(
  owner: string,
  repo: string,
  prNumber: number,
  review: ReviewResult,
  opts: PostOptions = {},
): Promise<void> {
  const { dryRun = false, isSelfReview = false } = opts;

  // ── diff 로 유효 라인 확인 ──
  let hunks: DiffHunk[] = [];
  try {
    hunks = parseDiffHunks(fetchDiff(owner, repo, prNumber));
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
  let body = `## 🤖 ChatGPT PR 리뷰\n\n**판정: ${VERDICT_LABEL[review.approval] ?? review.approval}**`;
  if (downgraded) {
    body += '\n\n> 본인이 작성한 PR 이라 GitHub 정책상 승인/변경요청을 남길 수 없어 코멘트로 게시합니다.';
  }
  body += `\n\n${review.summary}`;
  if (invalid.length > 0) {
    body += '\n\n---\n\n### 추가 코멘트 (인라인 위치 확인 불가)\n';
    for (const c of invalid) {
      body += `\n- **\`${c.path}:${c.line}\`** — ${c.body}`;
    }
  }

  // ── dry-run ──
  if (dryRun) {
    console.log(chalk.cyan('\n  [DRY RUN] 게시 예정 리뷰:'));
    console.log(chalk.dim(`  Event: ${event}${downgraded ? ' (셀프 리뷰로 하향)' : ''}`));
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
      postReview(owner, repo, prNumber, body, event, valid);
    } else {
      postSimpleReview(owner, repo, prNumber, body, event);
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
    postSimpleReview(owner, repo, prNumber, allBody, event);
    console.log(chalk.green('  ✓ 리뷰 게시 완료 (본문 포함)'));
    return;
  } catch (err) {
    const msg = ghErrorMessage(err);
    // 이벤트 자체가 거부된 경우 COMMENT 로 한 번 더 시도
    if (event !== 'COMMENT' && /own pull request|event/i.test(msg)) {
      console.log(chalk.yellow(`  ⚠ ${msg} — COMMENT 로 재시도`));
      postSimpleReview(owner, repo, prNumber, allBody, 'COMMENT');
      console.log(chalk.green('  ✓ 리뷰 게시 완료 (COMMENT 로 하향)'));
      return;
    }
    throw new Error(`리뷰 게시 실패: ${msg}`);
  }
}
