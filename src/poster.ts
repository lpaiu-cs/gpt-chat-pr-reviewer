/**
 * 파싱된 ReviewResult 를 GitHub PR 에 게시한다.
 *
 * 1. diff 를 가져와 인라인 가능한 (path, line) 을 판별
 * 2. 유효한 코멘트 → 인라인, 유효하지 않은 코멘트 → 리뷰 본문에 포함
 * 3. 인라인 게시 실패 시 전체를 본문 리뷰로 fallback
 */

import chalk from 'chalk';
import { createHash } from 'node:crypto';
import type { ReviewResult, DiffHunk, ReviewComment } from './types.js';
import {
  fetchDiff,
  fetchDiffAt,
  parseDiffHunks,
  postReview,
  postSimpleReview,
  ghErrorMessage,
  findPublishedReview,
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

// ── 중복 게시 방어 ──────────────────────────────────────────

/**
 * 코멘트 본문의 지문. 공백 차이는 같은 지적으로 본다.
 *
 * 라운드가 반복되면 같은 지적이 다시 나올 수 있고, 실제로 응답 수집이 어긋나
 * **직전 라운드의 답을 그대로 다시 게시한 사고**가 있었다 (#75 6·7차 — 4건이
 * 글자 하나까지 같았다). 사람이 손으로 숨겨 치우는 것 말고 방어가 없었다.
 */
export function commentDigest(body: string): string {
  return createHash('sha1').update(body.trim().replace(/\s+/g, ' ')).digest('hex').slice(0, 16);
}

/** 아직 화면에 살아 있는 (미해결·숨김 아님) 우리 지적. */
export interface LiveComment {
  path: string;
  line: number | null;
  digest?: string;
}

/**
 * 이미 열려 있는 지적과 **같은 자리에 같은 내용**인 코멘트를 걸러낸다 (순수 함수).
 *
 * 해결된 스레드는 대조 대상이 아니다 — 작성자가 처리했다고 닫은 지적을 모델이
 * 다시 든다면 그건 "아직 안 고쳐졌다" 는 재지적이라 게시되어야 한다. 걸러내는
 * 것은 지금 화면에 그대로 떠 있는 것뿐이다.
 *
 * 자리(path·line)까지 같을 때만 중복으로 본다. 같은 문구라도 다른 줄이면 다른
 * 곳에서 같은 실수가 반복된 것일 수 있어, 지우는 쪽이 더 비싼 실패다.
 */
export function dropDuplicateComments(
  comments: ReviewComment[],
  live: LiveComment[],
): { kept: ReviewComment[]; dropped: ReviewComment[] } {
  const key = (path: string, line: number | null, digest: string): string =>
    `${path}\0${line ?? '?'}\0${digest}`;
  const seen = new Set(
    live.filter((t) => t.digest).map((t) => key(t.path, t.line, t.digest as string)),
  );
  if (seen.size === 0) return { kept: comments, dropped: [] };

  const kept: ReviewComment[] = [];
  const dropped: ReviewComment[] = [];
  for (const c of comments) {
    (seen.has(key(c.path, c.line, commentDigest(c.body))) ? dropped : kept).push(c);
  }
  return { kept, dropped };
}

/** 게시 결과 — 호출부가 "무엇이 실제로 올라갔는지" 로 상태를 정한다. */
export interface PostOutcome {
  reviewId?: number;
  /** 리뷰를 실제로 게시했는가 (전부 중복이면 false) */
  posted: boolean;
  inline: number;
  inBody: number;
  /** 중복이라 게시하지 않은 코멘트 수 */
  duplicates: number;
}

export interface PostOptions {
  publicationKey?: string;
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
  /** 아직 열려 있는 우리 지적 — 같은 것을 다시 올리지 않기 위한 대조 대상. */
  live?: LiveComment[];
}

/** 검토한 대상과 **같은 기준**의 diff 를 가져온다. */
async function diffForPost(
  owner: string,
  repo: string,
  prNumber: number,
  commitId: string | null | undefined,
  baseRef: string | null | undefined,
): Promise<string> {
  if (commitId && baseRef) {
    return await fetchDiffAt(owner, repo, baseRef, commitId);
  }
  return await fetchDiff(owner, repo, prNumber);
}

/**
 * 사람의 리뷰로 읽히지 않게 하는 고지 (판정보다 먼저 온다).
 *
 * 이 봇은 메인테이너 토큰으로 게시하므로 GitHub 에서는 저장소 주인이
 * 직접 쓴 리뷰와 구별되지 않는다. 실제로 다른 에이전트가 이 코멘트를
 * **메인테이너 지시**로 읽고 그 급으로 판정하려 한 사례가 관측됐다.
 * 판정 문구보다 먼저 읽히도록 맨 위에 둔다.
 */
const BOT_DISCLAIMER =
  '> 이 리뷰는 자동화 봇에 의한 gpt 리뷰이며, 사용자 의견이나 판단을 담지 않습니다.';

export function buildReviewBody(
  review: ReviewResult,
  opts: Pick<PostOptions, 'round'> = {},
): string {
  const { round } = opts;

  let body = `## gpt-chat-pr-reviewer`;
  if (round !== undefined) {
    body += ` ${round}차 리뷰`;
  }
  body += `\n\n${BOT_DISCLAIMER}`;
  body += `\n\n**판정: ${VERDICT_LABEL[review.approval] ?? review.approval}**`;
  body += `\n\n${review.summary}`;
  return body;
}

export async function postReviewToGitHub(
  owner: string,
  repo: string,
  prNumber: number,
  review: ReviewResult,
  opts: PostOptions = {},
): Promise<PostOutcome> {
  const {
    dryRun = false,
    isSelfReview = false,
    commitId = null,
    baseRef = null,
    round,
    live = [],
  } = opts;

  const marker = (inline: number, inBody: number, duplicates: number): string =>
    `<!-- gpt-chat-pr-reviewer:${opts.publicationKey}:${inline}:${inBody}:${duplicates} -->`;
  if (!dryRun && opts.publicationKey && commitId) {
    const previous = await findPublishedReview(owner, repo, prNumber, opts.publicationKey, commitId);
    if (previous) {
      const counts = previous.body.split(`<!-- gpt-chat-pr-reviewer:${opts.publicationKey}:`)[1]
        ?.match(/^(\d+):(\d+):(\d+) -->/);
      if (!counts) throw new Error('기존 게시 기록의 코멘트 수를 확인하지 못했습니다');
      return { posted: true, reviewId: previous.id, inline: +counts[1], inBody: +counts[2], duplicates: +counts[3] };
    }
  }

  // ── 이미 열려 있는 지적과 같은 것은 뺀다 ──
  const { kept, dropped } = dropDuplicateComments(review.comments, live);
  if (dropped.length > 0) {
    console.log(
      chalk.yellow(`  ⚠ 이미 열려 있는 지적과 같은 코멘트 ${dropped.length}건 — 게시하지 않습니다.`),
    );
    for (const c of dropped) {
      console.log(chalk.dim(`    ${c.path}:${c.line} — ${c.body.slice(0, 60).replace(/\s+/g, ' ')}`));
    }
  }

  // 남은 지적이 없고 판정도 approve 가 아니면 새로 전할 말이 없다. 요약만 다른
  // 리뷰를 또 올리면 스레드만 두 벌이 되고, 그걸 사람이 손으로 숨겨야 한다.
  if (kept.length === 0 && review.comments.length > 0 && review.approval !== 'approve') {
    console.log(chalk.yellow('  ⚠ 전부 이미 지적한 내용입니다 — 리뷰를 게시하지 않습니다.'));
    return { posted: false, inline: 0, inBody: 0, duplicates: dropped.length };
  }

  // ── diff 로 유효 라인 확인 ──
  let hunks: DiffHunk[] = [];
  try {
    hunks = parseDiffHunks(await diffForPost(owner, repo, prNumber, commitId, baseRef));
  } catch {
    console.log(chalk.yellow('  diff 를 가져올 수 없어 모든 코멘트를 본문에 포함합니다.'));
  }

  const valid: ReviewComment[] = [];
  const invalid: ReviewComment[] = [];

  for (const c of kept) {
    const hunk = hunks.find((h) => h.path === c.path);
    if (hunk && hunk.lines.has(c.line)) {
      valid.push(c);
    } else {
      invalid.push(c);
    }
  }

  const { event, downgraded } = resolveEvent(review.approval, isSelfReview);

  // ── 리뷰 본문 구성 ──
  let body = buildReviewBody(review, { round });
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
    return { posted: false, inline: valid.length, inBody: invalid.length, duplicates: dropped.length };
  }

  const outcome = (reviewId: number, inline = valid.length, inBody = invalid.length): PostOutcome => ({
    posted: true,
    reviewId,
    inline,
    inBody,
    duplicates: dropped.length,
  });

  // ── 게시 ──
  try {
    const marked = opts.publicationKey ? `${body}\n\n${marker(valid.length, invalid.length, dropped.length)}` : body;
    const posted = valid.length > 0
      ? await postReview(owner, repo, prNumber, marked, event, valid, commitId)
      : await postSimpleReview(owner, repo, prNumber, marked, event, commitId);
    console.log(
      chalk.green(`  ✓ 리뷰 게시 완료 (인라인 ${valid.length}개 · 본문 ${invalid.length}개)`),
    );
    return outcome(posted.id);
  } catch (err) {
    // 응답 유실/시간 초과는 성공 여부를 모른다. 다음 실행이 같은 키로 조회한다.
    const msg = ghErrorMessage(err);
    if (!valid.length || !/422/.test(msg) || !/line|path|position|diff|comment/i.test(msg)) throw err;
    console.log(chalk.yellow(`  ⚠ 인라인 게시 실패 — ${ghErrorMessage(err)}`));
  }

  // ── 폴백: 인라인 없이 본문 전체로 재시도 ──
  const allBody =
    body +
    '\n\n---\n\n### 전체 코멘트\n' +
    valid.map((c) => `\n- **\`${c.path}:${c.line}\`** — ${c.body}`).join('') +
    (opts.publicationKey ? `\n\n${marker(0, kept.length, dropped.length)}` : '');

  try {
    const posted = await postSimpleReview(owner, repo, prNumber, allBody, event, commitId);
    console.log(chalk.green('  ✓ 리뷰 게시 완료 (본문 포함)'));
    return outcome(posted.id, 0, kept.length);
  } catch (err) {
    const msg = ghErrorMessage(err);
    // 이벤트 자체가 거부된 경우 COMMENT 로 한 번 더 시도
    if (event !== 'COMMENT' && /422/.test(msg) && /own pull request/i.test(msg)) {
      console.log(chalk.yellow(`  ⚠ ${msg} — COMMENT 로 재시도`));
      const posted = await postSimpleReview(owner, repo, prNumber, allBody, 'COMMENT', commitId);
      console.log(chalk.green('  ✓ 리뷰 게시 완료 (COMMENT 로 하향)'));
      return outcome(posted.id, 0, kept.length);
    }
    throw err; // 확정 거부와 성공 여부 미확정의 구분을 호출부까지 보존한다.
  }
}
