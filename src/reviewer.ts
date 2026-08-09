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
  getPRInfo,
  type SyncThread,
  type PRProbe,
} from './github.js';
import { ChatGPTDriver, QuotaLimitError } from './chatgpt.js';
import { parseGPTResponse, isAccessFailure } from './parser.js';
import { postReviewToGitHub } from './poster.js';
import { loadInstructions } from './instructions.js';
import { saveResponse, loadLatestResponse, type ResponseMeta } from './cache.js';
import { progress } from './progress.js';

// ── 스레드 동기화 ───────────────────────────────────────────

/**
 * GraphQL 스레드 목록에서 우리(뷰어)가 시작한 스레드를 컨텍스트에 병합한다.
 * 새로 발견된 스레드는 roundForNew 라운드 소속으로 기록된다.
 *
 * 우리 것이 아닌 스레드도 id 만은 knownThreadIds 에 기록한다. 그렇게 하지 않으면
 * probe 가 매번 "미지의 스레드" 로 보고 전체 동기화를 무한 반복한다.
 */
export function adoptThreads(
  ctx: PRContext,
  threads: SyncThread[],
  viewer: string,
  roundForNew: number,
): void {
  if (!viewer) return;

  // 관측한 모든 스레드 id 를 기록 (소유자 무관)
  const seen = new Set(ctx.knownThreadIds ?? []);
  for (const t of threads) seen.add(t.id);
  ctx.knownThreadIds = [...seen];

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

/** 상태 전이 판정에 필요한 GitHub 현황의 최소 집합. */
export interface SyncSnapshot {
  status: 'OPEN' | 'CLOSED' | 'MERGED';
  headSha: string;
}

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
  applySyncEvents(cfg, ctx, data);
  saveContext(cfg, ctx);
}

/**
 * 스냅샷을 근거로 상태 머신 이벤트를 발화한다. 저장은 호출부 책임.
 *
 * 이 함수는 GitHub API 를 호출하지 않는다 — 전체 동기화 경로와 배치 probe 경로가
 * 동일한 판정 로직을 공유하게 하기 위해 분리했다. 상태 머신(TRANSITIONS)은
 * 그대로이며, 여기서는 어떤 이벤트를 언제 발화할지만 정한다.
 */
export function applySyncEvents(cfg: AppConfig, ctx: PRContext, data: SyncSnapshot): void {
  // 1. PR 닫힘/머지
  if (data.status !== 'OPEN') {
    if (ctx.state !== 'CLOSED') {
      fire(ctx, 'PR_CLOSED', { note: data.status === 'MERGED' ? '머지됨' : '닫힘' });
      releaseConversation(ctx); // 끝난 PR 의 대화는 더 이어 쓰지 않는다
    }
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
}

/**
 * 배치 probe 결과로 컨텍스트를 동기화한다 (GitHub 추가 호출 없음).
 *
 * probe 는 스레드의 id·isResolved 만 담으므로 소유자·답글 판별을 할 수 없다.
 * 따라서 **이미 추적 중인 스레드의 resolve 상태만 갱신**하고, 새 스레드가 보이면
 * 전체 동기화가 필요하다고 알린다.
 *
 * @returns 전체 동기화(fetchPRSyncData)가 추가로 필요하면 true
 */
export function syncPRFromProbe(cfg: AppConfig, ctx: PRContext, probe: PRProbe): boolean {
  let needsFull = false;

  if (probe.threads) {
    const ours = new Map(ctx.threads.map((t) => [t.id, t]));
    const seen = new Set(ctx.knownThreadIds ?? []);
    for (const t of probe.threads) {
      const rec = ours.get(t.id);
      if (rec) {
        rec.isResolved = t.isResolved;
      } else if (!seen.has(t.id)) {
        // 처음 보는 스레드 — 우리 것인지, 누가 답글을 달았는지 probe 로는 알 수 없다.
        // 전체 동기화가 이 id 를 knownThreadIds 에 기록하므로 다음 tick 부터는
        // 남의 스레드라도 다시 전체 동기화를 유발하지 않는다.
        needsFull = true;
      }
    }
  }

  applySyncEvents(cfg, ctx, { status: probe.status, headSha: probe.headSha });
  saveContext(cfg, ctx);
  return needsFull;
}

// ── 대화 세션 ───────────────────────────────────────────────

/**
 * 이번 라운드에 쓸 대화. 대화 URL 은 상태가 아니라 실행기 사정이므로
 * 상태 머신(TRANSITIONS)이 아니라 여기서만 다룬다.
 */
export type ConversationPlan =
  | { action: 'resume'; url: string; turnsUsed: number }
  | { action: 'new'; reason: 'first' | 'rotate' | 'dry-run'; turnsUsed: number };

/**
 * 저장된 대화를 이어 쓸지, 새로 열지 결정한다 (순수 함수).
 *
 * 전송마다 PR diff 전문이 대화에 쌓이므로 무한히 이어 붙이면 모델의 컨텍스트
 * 한도에 걸린다. maxTurnsPerConversation 을 넘기면 대화를 회전시키고,
 * 그때는 프롬프트가 스니펫까지 실어 맥락을 이월한다(buildPreviousBlock 참고).
 */
export function planConversation(
  cfg: AppConfig,
  ctx: PRContext,
  round: number,
  opts: { dryRun?: boolean } = {},
): ConversationPlan {
  // dry-run 은 부작용이 없어야 한다. 저장된 대화로 복귀하면 라운드도 상태도 남기지
  // 않은 채 그 대화에 프롬프트만 끼워 넣게 되고, 다음 실제 라운드는 같은 회차의
  // dry-run 응답이 이미 섞인 대화를 이어받는다. watch --dry-run 이면 사이클마다
  // 쌓이는데 라운드 번호는 그대로라 회전 조건에도 걸리지 않는다.
  if (opts.dryRun) return { action: 'new', reason: 'dry-run', turnsUsed: 0 };

  const url = ctx.conversationUrl;
  if (!url) return { action: 'new', reason: 'first', turnsUsed: 0 };

  // 회전 판정은 완료된 라운드가 아니라 실제 전송 횟수로 한다. 파싱·게시가 실패해
  // ctx.round 가 늘지 않아도 프롬프트와 응답은 이미 대화에 쌓였기 때문이다.
  // 라운드로 세면 자동 재시도가 상한을 그대로 우회한다.
  // conversationTurns 가 없는 구버전 컨텍스트는 라운드 차이로 근사한다.
  const turnsUsed =
    ctx.conversationTurns ?? Math.max(0, round - (ctx.conversationStartRound ?? round));
  if (turnsUsed >= cfg.maxTurnsPerConversation) {
    return { action: 'new', reason: 'rotate', turnsUsed };
  }
  return { action: 'resume', url, turnsUsed };
}

/**
 * 이번 전송을 대화 누적에 반영하고 누적값을 반환한다.
 *
 * URL 이 없는 동안 쌓인 누적은 물려받지 않는다. URL 은 전송이 정상 반환된 뒤에야
 * 기록되므로, 전송·수집 중 예외가 나면 "누적은 있는데 URL 은 없는" 상태가 남는다.
 * 그 대화는 주소를 모르니 다시 돌아갈 수도 없어서 누적을 셀 이유가 없는데, 그대로
 * 물려받으면 정작 살아남은 새 대화가 상한에 일찍 걸려 조기 회전한다.
 *
 * 전송 **직전**에 부른다 — 쿼터 한도 등으로 예외가 나도 프롬프트는 이미 대화에
 * 남아 있다. 과다 계상은 회전이 빨라질 뿐이라 안전한 방향이다.
 */
export function countTurn(ctx: PRContext): number {
  ctx.conversationTurns = (ctx.conversationUrl ? (ctx.conversationTurns ?? 0) : 0) + 1;
  return ctx.conversationTurns;
}

/** 대화 참조를 놓는다 (수렴·PR 종료·복귀 실패·캐시 출처 불일치 시). */
export function releaseConversation(ctx: PRContext): void {
  ctx.conversationUrl = undefined;
  ctx.conversationStartRound = undefined;
  ctx.conversationTurns = undefined;
}

/**
 * 캐시된 응답의 출처가 지금 묶여 있는 대화와 다르면 대화 참조를 놓는다.
 * @returns 해제했으면 true
 *
 * --from-cache 는 아무것도 전송하지 않는다. 그러니 캐시가 다른 대화(특히 dry-run 의
 * 일회성 대화)에서 나온 것이면, 그 응답으로 게시된 코멘트는 저장된 대화 어디에도
 * 없다. 그대로 두면 다음 라운드가 "그 코멘트는 이 대화에 있다" 고 오판해 스니펫을
 * 생략하고, GPT 는 자기가 한 적 없는 지적의 처리 현황만 받아 들게 된다.
 */
export function reconcileCachedOrigin(ctx: PRContext, meta: ResponseMeta | null): boolean {
  if (!ctx.conversationUrl) return false;
  if (meta && !meta.dryRun && meta.conversationUrl === ctx.conversationUrl) return false;
  releaseConversation(ctx);
  return true;
}

/**
 * 이번 라운드를 진행할 대화를 화면에 띄운다.
 * @returns 이전 라운드 맥락이 살아 있는 대화면 true
 */
async function enterConversation(
  cfg: AppConfig,
  driver: ChatGPTDriver,
  ctx: PRContext,
  round: number,
  opts: RunRoundOptions,
): Promise<boolean> {
  const plan = planConversation(cfg, ctx, round, { dryRun: opts.dryRun });

  if (plan.action === 'resume') {
    if (await driver.resumeChat(plan.url)) {
      console.log(chalk.dim(`  이전 대화 이어서 진행 (누적 ${plan.turnsUsed}회 전송) — ${plan.url}`));
      return true;
    }
    // 대화 삭제·계정 변경 등 — 조용히 새 대화로 넘어가면 맥락이 사라진 걸 모른다
    console.log(
      chalk.yellow(`  ⚠ 이전 대화를 열지 못했습니다 (${plan.url}) — 새 대화로 시작합니다.`),
    );
    releaseConversation(ctx);
  } else if (plan.reason === 'rotate') {
    console.log(
      chalk.dim(`  대화 누적 ${plan.turnsUsed}회 전송 — 컨텍스트 한도를 피해 새 대화로 전환합니다.`),
    );
    releaseConversation(ctx);
  } else if (plan.reason === 'dry-run') {
    // 저장된 대화 참조는 그대로 둔다 — 건드리지 않는 것이 목적이다
    console.log(chalk.dim('  dry-run — 저장된 대화 대신 일회성 새 대화에서 실행합니다.'));
  }

  await driver.startNewChat();
  return false;
}

/**
 * 방금 만들어진 대화의 URL 을 컨텍스트에 기록한다.
 * ChatGPT 는 첫 메시지를 보낸 뒤에야 주소를 /c/<uuid> 로 바꾸므로 전송 후에 부른다.
 */
function rememberConversation(ctx: PRContext, url: string | undefined, round: number): void {
  if (ctx.conversationUrl) return; // 이어가던 대화 — 그대로 둔다

  if (!url) {
    console.log(
      chalk.yellow('  ⚠ 대화 URL 을 확보하지 못했습니다 — 다음 라운드는 새 대화로 시작합니다.'),
    );
    return;
  }
  ctx.conversationUrl = url;
  ctx.conversationStartRound = round;
  console.log(chalk.dim(`  대화 기록: ${url}`));
}

// ── 프롬프트 구성 ───────────────────────────────────────────

/** 이전 라운드 현황에 실을 스레드 최대 개수. */
const MAX_PREVIOUS_THREADS = 30;

/**
 * "이전 라운드 코멘트 현황" 블록을 만든다.
 *
 * 같은 대화를 이어갈 때도 이 블록은 없앨 수 없다. GPT 가 대화에서 이미 아는 것은
 * **자기가 무엇을 지적했는가** 뿐이고, resolve·답글 여부는 그 응답 이후 GitHub 에서
 * 벌어진 일이라 대화 어디에도 없다. 수렴 판단의 근거가 바로 그 처리 결과이므로,
 * 블록을 제거하는 대신 대화 안에 본문이 있는 항목의 스니펫만 걷어낸다.
 *
 * 대화를 회전했거나 폴백으로 새로 열었다면 그 대화에는 맥락이 없으므로 스니펫까지
 * 싣는다 — 이 블록이 곧 새 대화로의 요약 이월이다.
 */
export function buildPreviousBlock(
  ctx: PRContext,
  round: number,
  continued: boolean,
): { text: string; total: number; shown: number } {
  const empty = { text: '', total: 0, shown: 0 };
  if (round <= 1) return empty;

  // 직전 라운드에서 우리가 남긴 것 + 아직 미해결로 남은 과거 항목만 싣는다.
  // 전체를 싣으면 이전 리뷰 세션에서 넘어온 해결된 스레드까지 수십 개가 붙어
  // 프롬프트가 비대해지고 초점이 흐려진다.
  const relevant = ctx.threads.filter((t) => t.round === ctx.round || !t.isResolved);
  const shown = relevant.slice(0, MAX_PREVIOUS_THREADS);
  if (shown.length === 0) return empty;

  // 이어가는 대화라도 회전 이전 라운드의 코멘트는 그 대화에 없다 — 스니펫을 남긴다.
  const inConversationFrom = continued
    ? (ctx.conversationStartRound ?? round)
    : Number.POSITIVE_INFINITY;

  const lines = shown.map((t) => {
    const status = t.isResolved ? '해결됨' : t.authorReplied ? '답변만 있음' : '미해결';
    const head = `- [${status}] ${t.path}:${t.line ?? '?'}`;
    return t.round >= inConversationFrom ? head : `${head} — ${t.snippet}`;
  });
  const omitted = relevant.length - shown.length;

  const text = [
    '## 이전 라운드 코멘트 현황',
    ...(continued
      ? ['아래는 이 대화에서 당신이 남긴 지적의 GitHub 상 처리 결과입니다. 코멘트 본문은 위 대화를 참조하세요.']
      : []),
    ...lines,
    ...(omitted > 0 ? [`- (그 외 ${omitted}건 생략)`] : []),
    '',
    '위 코멘트가 실제로 반영되었는지 확인하고, 미반영 항목은 다시 지적해주세요.',
  ].join('\n');

  return { text, total: relevant.length, shown: shown.length };
}

function buildPrompt(
  cfg: AppConfig,
  ctx: PRContext,
  round: number,
  instructions: string,
  continued: boolean,
): string {
  const prev = buildPreviousBlock(ctx, round, continued);
  if (prev.total > prev.shown) {
    console.log(
      chalk.dim(`  이전 라운드 현황 ${prev.total}건 중 ${prev.shown}건만 프롬프트에 포함`),
    );
  }
  const previous = prev.text;

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

/**
 * PR 작성자 == 리뷰 계정 인지 판별한다.
 * 구버전 컨텍스트에는 author 가 없으므로 필요 시 조회해 채운다.
 */
function resolveSelfReview(ctx: PRContext): boolean {
  try {
    if (!ctx.author) {
      ctx.author = getPRInfo(ctx.owner, ctx.repo, ctx.prNumber).author;
    }
    return !!ctx.author && ctx.author === getViewerLogin();
  } catch {
    return false; // 판별 실패 시 원래 판정대로 시도하고, 거부되면 poster 가 폴백한다
  }
}

export type RoundOutcome = 'posted' | 'clean' | 'quota' | 'failed' | 'dry';

export interface RunRoundOptions {
  dryRun?: boolean;
  instructionsFile?: string;
  /** ChatGPT 를 호출하지 않고 마지막 저장 응답을 재사용한다. */
  fromCache?: boolean;
}

/**
 * 리뷰 원본 응답을 확보한다.
 *
 * 프롬프트는 여기서 만든다 — 대화를 이어 쓰는지 여부에 따라 이전 라운드 블록의
 * 모양이 달라지고, 그건 실제로 대화를 열어봐야 알 수 있기 때문이다.
 * 새로 받은 응답은 즉시 저장해, 게시 실패 시 대화 한도를 다시 쓰지 않고
 * --from-cache 로 재시도할 수 있게 한다.
 */
async function obtainRaw(
  cfg: AppConfig,
  driver: ChatGPTDriver | null,
  ctx: PRContext,
  round: number,
  instructions: string,
  opts: RunRoundOptions,
): Promise<string> {
  if (opts.fromCache) {
    const hit = loadLatestResponse(cfg, ctx);
    if (!hit) {
      throw new Error('캐시된 응답이 없습니다. --from-cache 없이 먼저 리뷰를 실행하세요.');
    }
    console.log(chalk.dim(`  캐시 사용: ${hit.path}`));
    if (!opts.dryRun && reconcileCachedOrigin(ctx, hit.meta)) {
      console.log(
        chalk.yellow('  ⚠ 캐시 응답이 현재 대화에서 나온 것이 아닙니다 — 대화 참조를 해제합니다.'),
      );
      saveContext(cfg, ctx);
    }
    return hit.raw;
  }

  if (!driver) throw new Error('브라우저 드라이버가 없습니다');
  const continued = await enterConversation(cfg, driver, ctx, round, opts);
  const prompt = buildPrompt(cfg, ctx, round, instructions, continued);

  // 전송하는 순간 프롬프트는 대화에 남는다. 이후 파싱·게시가 실패해 ctx.round 가
  // 늘지 않아도 컨텍스트는 이미 소비된 상태이므로, 보내기 직전에 센다.
  if (!opts.dryRun) {
    countTurn(ctx);
    saveContext(cfg, ctx);
  }

  progress.phase('prompt'); // collectResponse 가 곧 'waiting' 으로 넘긴다
  const raw = await driver.sendAndCollect(prompt);
  const conversationUrl = driver.currentConversationUrl() ?? undefined;

  // dry-run 의 일회성 대화는 기록하지 않는다 — 다음 라운드가 물려받으면 안 된다.
  if (!opts.dryRun) {
    rememberConversation(ctx, conversationUrl, round);
    saveContext(cfg, ctx); // 게시 도중 죽더라도 대화를 잃지 않게 확보 즉시 저장
  }

  const saved = saveResponse(cfg, ctx, round, raw, { conversationUrl, dryRun: opts.dryRun });
  console.log(chalk.dim(`  응답 저장: ${saved}`));
  return raw;
}

/**
 * 리뷰 라운드 1회 실행. 컨텍스트는 REVIEW_DUE 상태여야 한다.
 * dry-run 은 상태를 전이시키지 않고 결과만 출력한다.
 * fromCache 인 경우 driver 는 null 이어도 된다.
 */
export async function runRound(
  cfg: AppConfig,
  driver: ChatGPTDriver | null,
  ctx: PRContext,
  opts: RunRoundOptions = {},
): Promise<RoundOutcome> {
  const round = ctx.round + 1;
  const instructions = loadInstructions(cfg, opts.instructionsFile);

  console.log(chalk.bold(`\n  📋 ${ctx.title}`));
  console.log(chalk.dim(`     ${ctx.prUrl}  (${round}차 리뷰${opts.dryRun ? ' · dry-run' : ''})`));

  // ── dry-run: 상태 전이 없이 결과만 ──
  if (opts.dryRun) {
    try {
      const raw = await obtainRaw(cfg, driver, ctx, round, instructions, opts);
      progress.phase('parsing');
      const result = parseGPTResponse(raw);
      if (!assertReviewable(result)) return 'failed';
      console.log(chalk.dim(`  approval=${result.approval}  comments=${result.comments.length}`));
      progress.phase('posting');
      await postReviewToGitHub(ctx.owner, ctx.repo, ctx.prNumber, result, {
        dryRun: true,
        isSelfReview: resolveSelfReview(ctx),
      });
      console.log(chalk.dim('  (dry-run — 상태 변화 없음)'));
      return 'dry';
    } catch (e) {
      if (e instanceof QuotaLimitError) {
        console.log(chalk.yellow(`  ⚠ 쿼터 한도 — ${e.message}`));
        return 'quota';
      }
      const msg = (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 300);
      console.error(chalk.red('  ✗ 리뷰 실패:'), msg);
      return 'failed';
    }
  }

  // ── 실제 라운드 ──
  fire(ctx, 'START_REVIEW', { note: `${round}차 리뷰 시작` });
  saveContext(cfg, ctx);

  try {
    const raw = await obtainRaw(cfg, driver, ctx, round, instructions, opts);
    progress.phase('parsing');
    const result = parseGPTResponse(raw);

    // 리뷰가 아닌 응답을 PR 에 게시하지 않는다.
    if (!assertReviewable(result)) {
      throw new ReviewRejectedError(
        result.parsed ? 'GPT 가 PR 에 접근하지 못했습니다' : 'GPT 응답에서 리뷰 JSON 을 찾지 못했습니다',
      );
    }
    console.log(chalk.dim(`  approval=${result.approval}  comments=${result.comments.length}`));

    progress.phase('posting');
    await postReviewToGitHub(ctx.owner, ctx.repo, ctx.prNumber, result, {
      isSelfReview: resolveSelfReview(ctx),
    });

    // 게시 직후 head SHA · 새 스레드 동기화
    progress.phase('syncing');
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
    // 수렴하면 대화를 놓아준다 — 새 커밋으로 재개될 때는 새 대화에서 시작한다
    if (converged) releaseConversation(ctx);
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

    const msg = (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 300);
    fire(ctx, 'REVIEW_FAILED', { note: msg, patch: { lastError: msg } });
    saveContext(cfg, ctx);
    console.error(chalk.red('  ✗ 리뷰 실패:'), msg);
    return 'failed';
  }
}
