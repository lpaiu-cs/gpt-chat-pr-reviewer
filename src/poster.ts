/**
 * 파싱된 ReviewResult 를 GitHub PR 에 게시한다.
 *
 * 1. diff 를 가져와 인라인 가능한 (path, line) 을 판별
 * 2. 유효한 코멘트 → 인라인, 유효하지 않은 코멘트 → 리뷰 본문에 포함
 * 3. 인라인 게시 실패 시 전체를 본문 리뷰로 fallback
 */

import chalk from 'chalk';
import type { ReviewResult, DiffHunk, ReviewComment } from './types.js';
import { fetchDiff, parseDiffHunks, postReview, postSimpleReview } from './github.js';

const EVENT_MAP: Record<string, string> = {
  approve: 'APPROVE',
  request_changes: 'REQUEST_CHANGES',
  comment: 'COMMENT',
};

export async function postReviewToGitHub(
  owner: string,
  repo: string,
  prNumber: number,
  review: ReviewResult,
  dryRun = false,
): Promise<void> {
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

  // ── 리뷰 본문 구성 ──
  let body = `## 🤖 ChatGPT PR 리뷰\n\n${review.summary}`;
  if (invalid.length > 0) {
    body += '\n\n---\n\n### 추가 코멘트 (인라인 위치 확인 불가)\n';
    for (const c of invalid) {
      body += `\n- **\`${c.path}:${c.line}\`** — ${c.body}`;
    }
  }

  const event = EVENT_MAP[review.approval] ?? 'COMMENT';

  // ── dry-run ──
  if (dryRun) {
    console.log(chalk.cyan('\n  [DRY RUN] 게시 예정 리뷰:'));
    console.log(chalk.dim(`  Event: ${event}`));
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
      postSimpleReview(owner, repo, prNumber, body, event as any);
    }
    console.log(
      chalk.green(
        `  ✓ 리뷰 게시 완료 (인라인 ${valid.length}개 · 본문 ${invalid.length}개)`,
      ),
    );
  } catch (err) {
    console.log(chalk.yellow('  ⚠ 인라인 게시 실패 — 본문 전체 포함으로 재시도'));
    const allBody =
      body +
      '\n\n---\n\n### 전체 코멘트\n' +
      [...valid, ...invalid].map((c) => `\n- **\`${c.path}:${c.line}\`** — ${c.body}`).join('');
    try {
      postSimpleReview(owner, repo, prNumber, allBody, event as any);
      console.log(chalk.green('  ✓ 리뷰 게시 완료 (본문 포함)'));
    } catch (e2) {
      console.error(chalk.red('  ✗ 리뷰 게시 실패:'), e2);
      throw e2;
    }
  }
}
