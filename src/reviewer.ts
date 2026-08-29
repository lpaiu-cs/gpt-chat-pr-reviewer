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
import { listContexts, saveContext } from './state/store.js';
import {
  fetchPRSyncData,
  getViewerLogin,
  getPRInfo,
  addPullRequestReaction,
  removePullRequestReaction,
  ghErrorMessage,
  type PullRequestReaction,
  type SyncThread,
  type PRProbe,
  fetchCommitParents,
  fetchMergeCommit,
} from './github.js';
import { ChatGPTDriver, QuotaLimitError, ResponseTimeoutError } from './chatgpt.js';
import { parseGPTResponse, isAccessFailure } from './parser.js';
import { postReviewToGitHub, commentDigest, type LiveComment } from './poster.js';
import { loadInstructions } from './instructions.js';
import {
  saveResponse,
  loadLatestResponse,
  hasResponseSince,
  type ResponseMeta,
} from './cache.js';
import { progress } from './progress.js';

function addReactionToPullRequest(ctx: PRContext, content: PullRequestReaction): void {
  try {
    addPullRequestReaction(ctx.owner, ctx.repo, ctx.prNumber, content);
  } catch (e) {
    console.log(
      chalk.yellow(`  ⚠ PR 반응 ${content} 게시 실패 — 리뷰는 계속합니다: ${ghErrorMessage(e)}`),
    );
  }
}

function removeReactionFromPullRequest(ctx: PRContext, content: PullRequestReaction): void {
  try {
    removePullRequestReaction(ctx.owner, ctx.repo, ctx.prNumber, content);
  } catch (e) {
    console.log(
      chalk.yellow(`  ⚠ PR 반응 ${content} 제거 실패 — 리뷰는 계속합니다: ${ghErrorMessage(e)}`),
    );
  }
}

// ── 스레드 동기화 ───────────────────────────────────────────

/**
 * GraphQL 스레드 목록에서 우리(뷰어)가 시작한 스레드를 컨텍스트에 병합한다.
 * 새로 발견된 스레드는 roundForNew 라운드 소속으로 기록된다.
 *
 * 우리 것이 아닌 스레드도 id 만은 knownThreadIds 에 기록한다. 그렇게 하지 않으면
 * probe 가 매번 "미지의 스레드" 로 보고 전체 동기화를 무한 반복한다.
 *
 * **숨긴 스레드는 추적하지 않는다.** 사람이 duplicate 등으로 숨겼다는 것은 "이건
 * 없던 것으로 하라" 는 판정이다. 그대로 미해결로 세면 (1) 그 라운드는 전체 resolve
 * 가 영영 성립하지 않아 응답 대기에서 나오지 못하고 (2) 다음 라운드 프롬프트가
 * 취소된 지적을 계속 실어 나른다. id 는 knownThreadIds 에 남겨 probe 가 이걸
 * 매번 새 스레드로 보지 않게 한다.
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

  const hidden = new Set(threads.filter((t) => t.isHidden).map((t) => t.id));
  const dropped = ctx.threads.filter((r) => hidden.has(r.id));
  if (dropped.length > 0) {
    ctx.threads = ctx.threads.filter((r) => !hidden.has(r.id));
    console.log(
      chalk.dim(`  숨겨진 코멘트 ${dropped.length}건을 추적에서 제외합니다.`),
    );
  }

  for (const t of threads) {
    if (t.isHidden) continue;
    const first = t.comments[0];
    if (!first || first.author !== viewer) continue; // 우리가 시작한 스레드만

    // 숨긴 답글은 응답으로 세지 않는다 — 스레드 본체와 같은 이유다.
    const replied = t.comments.slice(1).some((c) => c.author !== viewer && !c.isHidden);
    const existing = ctx.threads.find((r) => r.id === t.id);
    if (existing) {
      existing.isResolved = t.isResolved;
      existing.authorReplied = replied;
      existing.digest ??= commentDigest(first.body); // 구버전 컨텍스트 보정
    } else {
      ctx.threads.push({
        id: t.id,
        path: t.path,
        line: t.line,
        isResolved: t.isResolved,
        authorReplied: replied,
        round: roundForNew,
        snippet: first.body.slice(0, 80).replace(/\s+/g, ' '),
        digest: commentDigest(first.body),
      });
    }
  }
}

// ── 동기화 (reconciliation) ─────────────────────────────────

/** 상태 전이 판정에 필요한 GitHub 현황의 최소 집합. */
export interface SyncSnapshot {
  status: 'OPEN' | 'CLOSED' | 'MERGED';
  headSha: string;
  /**
   * base ref. 리뷰 대상은 커밋 하나가 아니라 `base...head` 라서, base 가 바뀌면
   * head 가 그대로여도 **다른 코드**다. head 만 보면 그 변경이 영영 감지되지 않아
   * 검토한 적 없는 diff 가 CONVERGED 로 남는다. 구버전 경로는 없을 수 있다.
   */
  baseRef?: string;
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
  ctx.lastFullSyncAt = new Date().toISOString();
  saveContext(cfg, ctx);
}

/**
 * 전체 동기화를 한 번 돌 때가 됐는가.
 *
 * probe 는 스레드의 id·resolve 만 본다. 그래서 **본문 쪽에서 벌어지는 일**은
 * 영영 못 본다 — 사람이 코멘트를 숨겨도, 우리가 아는 스레드만 있으면 probe 는
 * "변화 없음" 이라 보고하고 숨김은 반영되지 않는다. 실제로 중복 리뷰를
 * duplicate 로 숨긴 뒤에도 도구는 14건을 그대로 세고 있었다.
 *
 * 그래서 주기적으로 한 번은 전체를 읽는다. PR 당 1 point 짜리 조회를 10분에
 * 한 번이므로 20개를 봐도 시간당 120 point 다 (한도 5,000).
 */
export function fullSyncDue(cfg: AppConfig, ctx: PRContext, now = Date.now()): boolean {
  if (!ctx.lastFullSyncAt) return true;
  const at = Date.parse(ctx.lastFullSyncAt);
  return !Number.isFinite(at) || now - at >= cfg.fullSyncIntervalMs;
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

  // 5. 작성자 응답 감지 (리뷰 대상 변경 or 게시 시점에 열려 있던 스레드 전체 resolve)
  if (ctx.state === 'AWAITING_AUTHOR') {
    const moved = targetChanged(ctx, data);
    if (moved || awaitedThreadsResolved(ctx)) {
      fire(ctx, 'AUTHOR_RESPONDED', { note: moved ?? '전체 스레드 resolve 확인' });
    }
  }

  // 6. 수렴 후 리뷰 대상 변경 → 리뷰 재개
  if (ctx.state === 'CONVERGED') {
    const moved = targetChanged(ctx, data);
    if (moved) fire(ctx, 'NEW_COMMITS', { note: `수렴 후 ${moved} — 리뷰 재개` });
  }
}

/**
 * **마지막으로 게시한 라운드**가 만든 지적들 (없으면 빈 배열).
 *
 * 예전에는 "스레드가 있는 가장 최근 라운드" 로 물러섰다. 마지막 라운드의 지적이
 * 전부 숨겨졌을 때 대상이 0건이 되는 것을 피하려던 것인데, 그 물러섬이 무한
 * 재리뷰의 원인이었다 — 인라인이 하나도 안 달린 라운드 뒤에는 **예전 라운드의
 * 이미 resolve 된 스레드**가 판정 대상이 되어 게시 직후 곧바로 "전체 resolve"
 * 가 성립했다. 오래된 resolve 는 이번 리뷰에 대한 응답이 아니다.
 *
 * 그 물러섬이 없어도 갇히지 않는다 — 판정의 기준은 이제 게시 시점 스냅샷
 * (`awaitedThreadIds`)이고, 이 함수는 그 스냅샷이 없는 구버전 컨텍스트의
 * 근사에만 쓰인다.
 */
export function latestRoundThreads(ctx: PRContext): PRContext['threads'] {
  return ctx.threads.filter((t) => t.round === ctx.round);
}

/**
 * 게시 시점에 열려 있던 스레드가 **전부** resolve 됐는가 = 작성자가 응답했는가.
 *
 * 기준은 라운드 번호가 아니라 **게시 시점의 스냅샷**이다. 그때 이미 resolve 되어
 * 있던 스레드는 이번 리뷰에 대한 응답이 아니므로 근거가 될 수 없다.
 *
 *  - 스냅샷이 비어 있다 = 기다릴 것이 없었다 (예: 지적이 전부 리뷰 본문으로 간
 *    라운드). resolve 로는 응답을 알 수 없으므로 **새 커밋만이 응답**이다.
 *  - 기다리던 스레드가 사라졌다 (사람이 숨김) = resolve 가 아니다. 응답으로
 *    보지 않는다 — 여기서 응답으로 세면 숨김 하나가 재리뷰를 부른다.
 *  - 스냅샷이 없다 = 구버전 컨텍스트. 마지막 라운드 스레드로 근사하고, 다음
 *    게시부터 스냅샷이 생긴다.
 */
export function awaitedThreadsResolved(ctx: PRContext): boolean {
  const awaited = ctx.awaitedThreadIds;
  if (awaited === undefined) {
    const mine = latestRoundThreads(ctx);
    return mine.length > 0 && mine.every((t) => t.isResolved);
  }
  if (awaited.length === 0) return false;
  const byId = new Map(ctx.threads.map((t) => [t.id, t]));
  return awaited.every((id) => byId.get(id)?.isResolved === true);
}

/**
 * 이 머지 커밋을 **이미 검토한 것만 합친 것**으로 볼 수 있는가 (순수 함수).
 *
 * 스택 PR 에서 베이스를 머지하면 그 위 PR 의 head 가 머지 커밋으로 옮겨간다.
 * head 가 달라졌으니 평소 판정은 "새 커밋" 으로 보고 라운드를 한 번 더 여는데,
 * 들어온 코드는 방금 그 베이스 PR 에서 우리가 리뷰하고 수렴시킨 바로 그것이다.
 * 실측: `sleep-management#2` 가 13:28 에 approve 로 수렴하고 13:30 에 `#1` 로
 * 머지되자, `#1` 이 13:35 에 자기가 7분 전 approve 한 코드를 다시 리뷰했다.
 *
 * 근거는 셋이고 **전부** 있어야 한다.
 *
 * 1. `parents[0] === lastReviewedHead` — 이 PR 쪽에 새 작업이 없다.
 * 2. `source` — 들어온 tip(`parents[1]`)을 검토하고 **수렴시킨** PR 이 있다.
 * 3. `source.mergeCommit === head` — 지금 head 가 **GitHub 이 그 PR 을 머지하며
 *    만든 바로 그 커밋**이다.
 *
 * 3번이 핵심이다. 부모 둘이 검토됐다는 것만으로는 머지 **결과**에 새 코드가
 * 없음을 증명하지 못한다 — 머지 커밋의 tree 는 두 부모의 합집합일 필요가 없어서,
 * 충돌을 손으로 해결하거나 `git merge --no-commit` 뒤에 손을 대면 부모가
 * `[검토한 P, 검토한 Q]` 여도 어느 리뷰에서도 본 적 없는 코드가 들어간다.
 * 그걸 흡수하면 그 변경은 **영구히** 리뷰를 건너뛴다. GitHub 이 머지 버튼으로
 * 만든 커밋은 충돌이 없을 때만 생성되고 사람이 내용을 바꿔 넣을 수 없으므로,
 * "그 커밋과 동일한가" 가 사람 손이 닿지 않았다는 증명이 된다.
 *
 * 어긋나는 모든 경우는 평소대로 재리뷰로 떨어진다:
 *
 *  - `main` 을 브랜치에 머지 → 그 tip 을 검토·수렴시킨 PR 이 없다
 *  - 충돌을 손으로 해결해 push → GitHub 이 만든 커밋이 아니다 (3번 불일치)
 *  - 머지 후 커밋을 더 얹음 → head 가 그 머지 커밋이 아니다
 *  - 리뷰 도중 머지가 들어옴 → `parents[0]` 이 검토 head 와 다르다
 *  - 조회 실패 → 근거가 없다
 *
 * 즉 틀리는 방향이 언제나 **"한 번 더 리뷰한다"** 쪽이다. 미검토 코드를 검토
 * 완료로 기록하는 방향으로는 틀리지 않는다 — 이 판정이 지켜야 할 것이 그것이다.
 */
export function absorbsReviewedMerge(m: {
  /** 지금 head (= 머지 커밋이어야 한다) */
  head: string;
  /** head 의 부모들 (머지가 아니면 1개, 모르면 null) */
  parents: string[] | null;
  /** 이 PR 이 마지막으로 검토한 head */
  lastReviewedHead: string | null;
  /** 들어온 tip 을 검토하고 수렴시킨 PR (없으면 null) */
  source: {
    /** 그 PR 이 검토한 head — `parents[1]` 과 같아야 한다 */
    reviewedHead: string;
    /** GitHub 이 그 PR 을 머지하며 만든 커밋 (머지 전이면 null) */
    mergeCommit: string | null;
  } | null;
}): boolean {
  // 부모를 모르면(조회 실패) 판정하지 않는다 — 모를 때는 평소대로 재리뷰한다.
  if (!m.parents || m.parents.length !== 2) return false;
  if (!m.lastReviewedHead || m.parents[0] !== m.lastReviewedHead) return false;
  if (!m.source || m.source.reviewedHead !== m.parents[1]) return false;
  // 사람 손이 닿지 않은 머지라는 증명.
  return m.source.mergeCommit !== null && m.source.mergeCommit === m.head;
}

/**
 * 이 PR 이 **수렴한 채로** 끝났는가 — 흡수의 근거가 될 자격.
 *
 * `CLOSED` 만으로는 안 된다. 상태 머신에서 `PR_CLOSED` 는 `AWAITING_AUTHOR` 를
 * 포함한 **어느 상태에서든** 도달하므로, request_changes 를 받은 채 그대로
 * 머지·종료한 PR 도 CLOSED 가 된다. 그 head 를 근거로 삼으면 미해결 지적이
 * 남은 코드가 상위 PR 에서 재검토 없이 통과한다. 닫히기 직전이 CONVERGED 였는지
 * 이력으로 확인한다.
 */
export function endedConverged(ctx: PRContext): boolean {
  if (ctx.state === 'CONVERGED') return true;
  if (ctx.state !== 'CLOSED') return false;
  for (let i = ctx.history.length - 1; i >= 0; i--) {
    const h = ctx.history[i];
    if (h.to === 'CLOSED') return h.from === 'CONVERGED';
  }
  return false; // 이력 없이 CLOSED 인 구버전 컨텍스트 — 근거로 쓰지 않는다
}

/**
 * 들어온 tip 을 검토하고 수렴시킨 **같은 레포의** 컨텍스트 (없으면 null).
 *
 * 레포를 맞추는 것은 안전 때문만이 아니다 — 찾은 PR 번호로 머지 커밋을
 * 조회해야 하므로 어느 레포의 몇 번인지가 확정돼야 한다.
 */
function findConvergedSource(cfg: AppConfig, ctx: PRContext, tip: string): PRContext | null {
  for (const c of listContexts(cfg)) {
    if (c.owner !== ctx.owner || c.repo !== ctx.repo) continue;
    if (c.prNumber === ctx.prNumber) continue;
    if (c.headShaAtLastReview !== tip) continue;
    if (!endedConverged(c)) continue;
    return c;
  }
  return null;
}

/**
 * head 가 **이미 검토한 것만 합친 머지 커밋**으로 옮겨갔으면, 라운드를 열지 않고
 * 검토 head 만 그 머지 커밋으로 당긴다.
 *
 * `applySyncEvents` 안에 두지 않는다 — 그 함수는 "GitHub API 를 호출하지 않는다"
 * 가 계약이고, 그래야 probe 경로와 전체 동기화 경로가 같은 판정을 공유한다.
 * 그래서 조회는 여기서 하고, 판정은 순수 함수(`absorbsReviewedMerge`)로 뺐다.
 *
 * 비싼 것부터 미룬다: 상태·head 비교(공짜) → 부모 조회(REST 1회) → 컨텍스트
 * 전체 읽기(디스크) → 머지 커밋 조회(REST 1회). 앞에서 걸러지면 뒤는 하지 않는다.
 *
 * @returns 흡수했으면 true (호출자는 그대로 진행하면 된다 — 이제 head 가 같다)
 */
export function absorbReviewedMerge(
  cfg: AppConfig,
  ctx: PRContext,
  headSha: string | null | undefined,
): boolean {
  // 재리뷰 트리거가 head 인 상태에서만 의미가 있다.
  if (ctx.state !== 'AWAITING_AUTHOR' && ctx.state !== 'CONVERGED') return false;
  if (!headSha || !ctx.headShaAtLastReview || headSha === ctx.headShaAtLastReview) return false;

  const parents = fetchCommitParents(ctx.owner, ctx.repo, headSha);
  // parents[0] 부터 본다 — 여기서 걸리면 컨텍스트를 통째로 읽지 않아도 된다.
  if (!parents || parents.length !== 2 || parents[0] !== ctx.headShaAtLastReview) return false;

  const src = findConvergedSource(cfg, ctx, parents[1]);
  if (!src) return false;

  const merged = fetchMergeCommit(src.owner, src.repo, src.prNumber);
  if (
    !absorbsReviewedMerge({
      head: headSha,
      parents,
      lastReviewedHead: ctx.headShaAtLastReview,
      source: { reviewedHead: parents[1], mergeCommit: merged },
    })
  ) {
    return false;
  }

  console.log(
    chalk.dim(
      `    ${ctx.owner}/${ctx.repo}#${ctx.prNumber} #${src.prNumber} 이 머지돼 들어왔습니다 ` +
        `(이미 수렴한 리뷰) — 재리뷰하지 않고 검토 지점만 옮깁니다.`,
    ),
  );
  // 상태 전이가 아니다 — "무엇을 검토했는가" 의 기록만 앞으로 당긴다.
  ctx.headShaAtLastReview = headSha;
  saveContext(cfg, ctx);
  return true;
}

/**
 * 마지막으로 검토한 대상과 달라졌는가 (달라졌으면 사유 문구, 아니면 null).
 *
 * **base 도 본다.** 리뷰 대상은 `base...head` 라서 base 를 main → release 로 바꾸면
 * head 가 그대로여도 다른 코드다. head 만 비교하면 그 변경을 영영 못 잡아, 검토한
 * 적 없는 diff 가 approve 하나로 CONVERGED 에 눌러앉는다. 대기 구간이 2~15분이라
 * 게시 직전에 한 번 더 확인하는 것으로는 못 막는다 — 상태로 추적해야 한다.
 *
 * base 브랜치가 앞으로 나가는 것(main 에 새 커밋)은 여기 안 들어온다: 3-dot 은
 * merge-base 기준이라 그때 리뷰 diff 가 바뀌지 않는다.
 */
function targetChanged(ctx: PRContext, data: SyncSnapshot): string | null {
  if (ctx.headShaAtLastReview && data.headSha !== ctx.headShaAtLastReview) {
    return '새 커밋 감지';
  }
  // 구버전 컨텍스트·구버전 스냅샷에는 base 가 없다 — 없으면 판정하지 않는다.
  if (ctx.baseRefAtLastReview && data.baseRef && data.baseRef !== ctx.baseRefAtLastReview) {
    return `base 변경 감지 (${ctx.baseRefAtLastReview} → ${data.baseRef})`;
  }
  return null;
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

  applySyncEvents(cfg, ctx, {
    status: probe.status,
    headSha: probe.headSha,
    baseRef: probe.baseBranch,
  });
  saveContext(cfg, ctx);
  // 숨김처럼 probe 가 볼 수 없는 변화는 주기적인 전체 조회로만 잡힌다.
  return needsFull || fullSyncDue(cfg, ctx);
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
  // 대기 기록은 그 대화 안의 질문을 가리킨다 — 대화를 놓으면 같이 버린다.
  delete ctx.pendingSend;
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
 * 프롬프트에서 라운드를 식별할 수 있는 한 줄. **실제로 전송되는 문자열과 같아야 한다.**
 *
 * 기본 템플릿의 `리뷰 라운드: {{round}}차` 를 그대로 쓴다. 사용자가 템플릿에서
 * `{{round}}` 를 없앴다면 판별할 수 없으므로 null 을 돌려주고, 호출부는 종전대로
 * 다시 묻는다 (판별 실패는 항상 "다시 묻기" 로 떨어져야 안전하다).
 *
 * 같은 줄에 다른 변수가 있으면 그것도 렌더링한다. `{{round}}` 만 치환하면
 * `PR {{url}} — 리뷰 라운드: {{round}}차` 같은 사용자 템플릿에서 마커가 실제
 * 메시지와 달라져 `findRound` 가 못 찾고, 멱등성이 조용히 깨진다.
 *
 * `{{previous}}` · `{{instructions}}` 는 여러 줄로 펼쳐지는 블록이라 한 줄 마커로
 * 재현할 수 없다. 같은 줄에 있으면 판별을 포기한다.
 */
export function roundMarker(cfg: AppConfig, ctx: PRContext, round: number): string | null {
  const line = cfg.promptTemplate.split(/\r?\n/).find((l) => l.includes('{{round}}'));
  if (!line) return null;
  if (/\{\{(previous|instructions)\}\}/.test(line)) return null;
  const marker = line
    .replace(/\{\{round\}\}/g, String(round))
    .replace(/\{\{url\}\}/g, ctx.prUrl)
    .trim();
  // 렌더링하지 못한 변수가 남았다 — 실제 전송 문자열과 다르다.
  if (/\{\{[^}]*\}\}/.test(marker)) return null;
  return marker.length > 0 ? marker : null;
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

/**
 * 아직 열려 있는 우리 지적 — 같은 것을 다시 올리지 않기 위한 대조 대상.
 *
 * 해결된 스레드는 뺀다. 작성자가 닫은 지적을 모델이 다시 든다면 그건 "아직 안
 * 고쳐졌다" 는 재지적이라 올라가야 한다. 숨겨진 스레드는 adoptThreads 가 이미
 * 추적에서 뺐으므로 여기 없다.
 */
function liveComments(ctx: PRContext): LiveComment[] {
  return ctx.threads
    .filter((t) => !t.isResolved)
    .map((t) => ({ path: t.path, line: t.line, digest: t.digest }));
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
/**
 * 이번 라운드 질문이 저장된 대화에 이미 있으면, 다시 묻지 않고 그 응답을 회수한다.
 *
 * 응답 대기는 2~15분이다. 그 사이에 죽으면 질문은 대화에 남았는데 우리는 응답을
 * 못 받은 상태다. 그대로 다시 보내면 같은 질문이 한 번 더 들어가 대화 한도를 버린다.
 *
 * 회수하지 않는 경우(전부 null → 평소 경로로 다시 묻는다):
 *  - dry-run          저장된 대화를 건드리지 않는 것이 목적이다
 *  - 마커 없음         템플릿에 {{round}} 가 없어 라운드를 식별할 수 없다
 *  - 대기 중인 전송 기록 없음  언제·무엇을 보고 물었는지 모른다
 *  - **이 전송이 이미 답을 받아봄**  받고도 실패했다는 뜻이라 같은 답을 다시 써도
 *    결과가 같다. 라운드가 아니라 **전송** 단위다 — 앞선 시도의 실패 응답이 새
 *    전송의 회수를 막으면 같은 질문이 또 나간다
 *  - **리뷰 대상이 달라짐**  새 커밋 또는 base 변경 — 낡은 diff 를 보고 만든 답이다
 *  - 복귀 실패          대화가 삭제·이동됐다
 *  - 그 라운드가 마지막 질문이 아님  어느 응답이 그 라운드 것인지 단정할 수 없다
 */
async function reclaimRound(
  cfg: AppConfig,
  driver: ChatGPTDriver,
  ctx: PRContext,
  round: number,
  opts: RunRoundOptions,
): Promise<RawResult | null> {
  if (opts.dryRun) return null;
  const url = ctx.conversationUrl;
  if (!url) return null;

  const marker = roundMarker(cfg, ctx, round);
  if (!marker) return null;

  // 대화 + 라운드 번호는 "무엇을 보고 만든 답인가" 를 말해주지 않는다. 죽어 있는
  // 동안 작성자가 push 하거나 base 를 바꿨다면 그 답은 이미 없는 diff 에 대한
  // 지적이고, 게시 후에는 현재 상태가 검토 완료로 기록돼 CONVERGED 까지 갈 수 있다.
  const sent: ReviewTarget = {
    headSha: ctx.pendingSend?.headSha ?? null,
    baseRef: ctx.pendingSend?.baseRef ?? null,
  };

  const verdict = judgeReclaim(ctx, round, currentTarget(ctx));
  if (verdict !== 'ok') {
    if (verdict !== 'no-record') {
      console.log(chalk.yellow(`  ⚠ ${RECLAIM_REFUSAL[verdict]} — 회수하지 않고 다시 묻습니다.`));
    }
    return null;
  }

  // **이 전송** 이후 저장된 응답이 있으면 이미 받아본 것이다. 라운드 단위로 보면
  // 앞선 시도의 실패 응답이 새 전송의 회수까지 막아 같은 질문이 또 나간다.
  const sentAt = ctx.pendingSend?.at ? Date.parse(ctx.pendingSend.at) : NaN;
  if (hasResponseSince(cfg, ctx, round, Number.isFinite(sentAt) ? sentAt : null)) return null;

  // 재전송하지 않으므로 어시스턴트 메시지가 없어도 된다 — 응답 전에 죽은 대화가
  // 정확히 그 모습이고, 여기서 실패로 보면 이 복구가 통째로 무의미해진다.
  if (!(await driver.resumeChat(url, { requireAssistant: false }))) return null;

  const baseline = await driver.findRound(marker);
  if (baseline === null) return null;

  console.log(chalk.dim('  이 라운드 질문이 대화에 이미 있습니다 — 재질문 없이 응답만 회수합니다.'));
  progress.phase('waiting');
  // 기준점을 findRound 가 준 값으로 넘긴다. 완료 판정(스트리밍 종료 + 안정)은
  // collectResponse 가 하므로, 이미 와 있는 답이면 즉시, 생성 중이면 끝까지 기다린다.
  const raw = await driver.collectFrom(baseline);
  const saved = saveResponse(cfg, ctx, round, raw, {
    conversationUrl: url,
    ...targetMeta(sent),
  });
  console.log(chalk.dim(`  응답 저장: ${saved}`));
  return { raw, target: sent };
}

/**
 * **리뷰 대상 diff 의 식별자.** 리뷰가 보는 건 커밋 하나가 아니라 `base...head` 다.
 *
 * head 만 보면 base 변경(main → release)을 놓친다 — head 는 그대로인데 diff 는
 * 완전히 달라지고, 그 답을 회수해 approve 로 게시하면 바뀐 diff 를 한 번도 검토하지
 * 않은 채 CONVERGED 로 남는다.
 *
 * base 브랜치가 앞으로 나가는 것(main 에 새 커밋)은 여기 안 들어온다 — 3-dot 은
 * merge-base 기준이라 그때 diff 가 바뀌지 않는다. 이름이 같은데 히스토리가
 * 재작성된 경우까지는 못 잡지만, 그건 회수 실패(= 다시 묻기) 쪽으로만 틀린다.
 */
export interface ReviewTarget {
  headSha: string | null;
  baseRef: string | null;
}

/**
 * 대기 중이던 응답을 회수해도 되는지 (순수 함수).
 *
 * 회수는 "이미 만들어진 답" 을 쓰는 일이라, 그 답이 **지금 코드**에 대한 것인지
 * 확인하지 않으면 없는 코드를 지적하고 검토한 적 없는 diff 를 검토 완료로 적는다.
 * 확신이 없으면 전부 거절한다 — 다시 묻는 비용은 대화 1회이고, 잘못 회수하면
 * 리뷰를 통째로 건너뛴다.
 */
export type ReclaimVerdict =
  | 'ok'
  | 'no-record'
  | 'unknown-sent'
  | 'unknown-current'
  | 'moved'
  | 'rebased';

const RECLAIM_REFUSAL: Record<Exclude<ReclaimVerdict, 'ok'>, string> = {
  'no-record': '이 라운드의 전송 기록이 없습니다',
  'unknown-sent': '질문 당시 리뷰 대상을 모릅니다',
  'unknown-current': '현재 리뷰 대상을 확인하지 못했습니다',
  moved: '대기 중이던 질문 이후 새 커밋이 있습니다',
  rebased: '대기 중이던 질문 이후 base 브랜치가 바뀌었습니다',
};

export function judgeReclaim(
  ctx: PRContext,
  round: number,
  current: ReviewTarget,
): ReclaimVerdict {
  const pending = ctx.pendingSend;
  if (!pending || pending.round !== round) return 'no-record';
  if (!pending.headSha || !pending.baseRef) return 'unknown-sent';
  if (!current.headSha || !current.baseRef) return 'unknown-current';
  if (current.headSha !== pending.headSha) return 'moved';
  return current.baseRef === pending.baseRef ? 'ok' : 'rebased';
}

/**
 * 지금 이 PR 의 리뷰 대상 (조회 실패 시 전부 null).
 *
 * 라운드당 한 번이라 비용은 무시할 만하다 — 라운드 자체가 2~15분이고 대화 한도를
 * 소비한다. 실패를 null 로 떨어뜨려 "판별 불가 → 회수하지 않음" 으로 흐르게 한다.
 */
function currentTarget(ctx: PRContext): ReviewTarget {
  try {
    const info = getPRInfo(ctx.owner, ctx.repo, ctx.prNumber);
    return { headSha: info.headSha || null, baseRef: info.baseBranch || null };
  } catch {
    return { headSha: null, baseRef: null };
  }
}

/** 원본 응답과, 그 응답이 **무엇을 보고 만들어졌는지**. */
interface RawResult {
  raw: string;
  target: ReviewTarget;
}

async function obtainRaw(
  cfg: AppConfig,
  driver: ChatGPTDriver | null,
  ctx: PRContext,
  round: number,
  instructions: string,
  opts: RunRoundOptions,
): Promise<RawResult> {
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
    // 캐시에 검토 대상이 남아 있으면 그대로 쓴다. 없으면(구버전 캐시) 알 수 없으므로
    // 종전대로 commit_id 없이 게시하고 동기화 값으로 기록한다 — --from-cache 는
    // 사용자가 "이 응답을 다시 써라" 고 명시한 경로라 여기서 막지는 않는다.
    return {
      raw: hit.raw,
      target: { headSha: hit.meta?.headSha ?? null, baseRef: hit.meta?.baseRef ?? null },
    };
  }

  if (!driver) throw new Error('브라우저 드라이버가 없습니다');

  // ── 이미 보낸 라운드 회수 ──
  // **enterConversation 보다 먼저** 해야 한다. 회전 판정이나 복귀 실패가 저장된
  // 대화를 놓아버리면 확인할 기회 자체가 사라진다. 특히 응답 대기 중에 죽으면
  // countTurn 때문에 회전 조건이 이미 충족돼 있어, 그대로 두면 매번 새 대화에
  // 같은 질문을 다시 보낸다.
  const reclaimed = await reclaimRound(cfg, driver, ctx, round, opts);
  if (reclaimed !== null) {
    clearPendingSend(cfg, ctx, opts);
    return reclaimed;
  }

  const continued = await enterConversation(cfg, driver, ctx, round, opts);
  const prompt = buildPrompt(cfg, ctx, round, instructions, continued);

  // 무엇을 보고 물었는지는 **묻기 전에** 확정한다. 게시 후에 조회하면 대기하는
  // 2~15분 사이에 들어온 커밋까지 "검토함" 으로 기록돼, 한 번도 보지 않은 코드가
  // CONVERGED 로 넘어간다. base 도 같이 잡는다 — 리뷰가 보는 건 `base...head` 다.
  const target: ReviewTarget = opts.dryRun
    ? { headSha: null, baseRef: null }
    : currentTarget(ctx);

  // 확정하지 못하면 **보내지 않는다.** 회수는 fail-closed 인데 전송만 fail-open 이면
  // 구멍은 그대로다: 대상 없이 보낸 라운드는 commit_id 없이 게시되고, 대기 중에
  // 들어온 커밋이 검토 완료로 기록돼 approve 하나로 CONVERGED 가 된다.
  // 여기서 던지면 countTurn 전이라 대화 한도도 쓰지 않고, ERROR → RETRY 로 돌아온다.
  if (!opts.dryRun && (!target.headSha || !target.baseRef)) {
    throw new Error('리뷰 대상(head·base)을 확인하지 못했습니다 — 전송하지 않고 재시도합니다.');
  }

  // 전송하는 순간 프롬프트는 대화에 남는다. 이후 파싱·게시가 실패해 ctx.round 가
  // 늘지 않아도 컨텍스트는 이미 소비된 상태이므로, 보내기 직전에 센다.
  if (!opts.dryRun) {
    countTurn(ctx);
    saveContext(cfg, ctx);
  }

  progress.phase('prompt'); // collectResponse 가 곧 'waiting' 으로 넘긴다
  let conversationUrl: string | undefined;
  const raw = await driver.sendAndCollect(prompt, (url) => {
    // **응답을 기다리기 전에** 저장한다. 여기가 이 변경의 핵심이다 — 대기 중에
    // 죽어도 다음 라운드가 그 대화로 복귀해 위의 중복 판별을 탈 수 있다.
    // 리뷰 대상도 같이 남긴다. 회수 판정은 "그때 그 diff 인가" 까지 봐야 한다.
    conversationUrl = url ?? undefined;
    if (!opts.dryRun) {
      rememberConversation(ctx, conversationUrl, round);
      ctx.pendingSend = { round, ...target, at: new Date().toISOString() };
      saveContext(cfg, ctx);
    }
  });

  const saved = saveResponse(cfg, ctx, round, raw, {
    conversationUrl,
    dryRun: opts.dryRun,
    ...targetMeta(target),
  });
  console.log(chalk.dim(`  응답 저장: ${saved}`));
  clearPendingSend(cfg, ctx, opts);
  return { raw, target };
}

/** 검토 대상을 캐시 사이드카에 남긴다 (--from-cache 가 다시 알아낼 방법이 없다). */
function targetMeta(t: ReviewTarget): { headSha?: string; baseRef?: string } {
  return {
    ...(t.headSha ? { headSha: t.headSha } : {}),
    ...(t.baseRef ? { baseRef: t.baseRef } : {}),
  };
}

/** 응답을 확보했으면 대기 기록을 지운다 — 남겨두면 다음 라운드의 판정을 흐린다. */
function clearPendingSend(cfg: AppConfig, ctx: PRContext, opts: RunRoundOptions): void {
  if (opts.dryRun || !ctx.pendingSend) return;
  delete ctx.pendingSend;
  saveContext(cfg, ctx);
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

  // 창이 닫혔거나 크래시했으면 여기서 되살린다. 이 한 줄이 없으면 죽은 페이지
  // 핸들이 계속 재사용되어, 사람이 데몬을 재기동할 때까지 모든 라운드가
  // "Target page, context or browser has been closed" 로 실패한다 (#109).
  if (driver) await driver.ensureAlive();

  console.log(chalk.bold(`\n  📋 ${ctx.title}`));
  console.log(chalk.dim(`     ${ctx.prUrl}  (${round}차 리뷰${opts.dryRun ? ' · dry-run' : ''})`));

  // ── dry-run: 상태 전이 없이 결과만 ──
  if (opts.dryRun) {
    try {
      const { raw } = await obtainRaw(cfg, driver, ctx, round, instructions, opts);
      progress.phase('parsing');
      const result = parseGPTResponse(raw);
      if (!assertReviewable(result)) return 'failed';
      console.log(chalk.dim(`  approval=${result.approval}  comments=${result.comments.length}`));
      progress.phase('posting');
      await postReviewToGitHub(ctx.owner, ctx.repo, ctx.prNumber, result, {
        dryRun: true,
        isSelfReview: resolveSelfReview(ctx),
        round,
        live: liveComments(ctx),
      });
      console.log(chalk.dim('  (dry-run — 상태 변화 없음)'));
      return 'dry';
    } catch (e) {
      if (e instanceof QuotaLimitError) {
        console.log(chalk.yellow(`  ⚠ 쿼터 한도 — ${e.message}`));
        return 'quota';
      }
      const msg = (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 300);
      if (e instanceof ResponseTimeoutError) console.log(chalk.yellow('  ⏱ 응답 타임아웃:'), msg);
      else console.error(chalk.red('  ✗ 리뷰 실패:'), msg);
      return 'failed';
    }
  }

  // ── 실제 라운드 ──
  fire(ctx, 'START_REVIEW', { note: `${round}차 리뷰 시작` });
  saveContext(cfg, ctx);
  removeReactionFromPullRequest(ctx, '+1');
  addReactionToPullRequest(ctx, 'eyes');

  try {
    const { raw, target: reviewed } = await obtainRaw(cfg, driver, ctx, round, instructions, opts);
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
    // 검토한 커밋에 고정한다. 빼면 GitHub 이 게시 시점의 최신 커밋에 리뷰를 붙여,
    // 대기하는 2~15분 사이의 push 에 **본 적 없는 APPROVE** 가 직접 달린다.
    const post = await postReviewToGitHub(ctx.owner, ctx.repo, ctx.prNumber, result, {
      isSelfReview: resolveSelfReview(ctx),
      commitId: reviewed.headSha,
      baseRef: reviewed.baseRef,
      round,
      live: liveComments(ctx),
    });

    // 게시 직후 head SHA · 새 스레드 동기화
    progress.phase('syncing');
    // **검토한** head 를 적는다. 게시 후 조회값이 아니다 — 대기하는 2~15분 사이에
    // 작성자가 push 하면 그 커밋을 한 번도 안 봤는데 검토 완료로 기록되고,
    // approve 였다면 그대로 CONVERGED 가 된다. 검토한 head 를 적으면 그 push 는
    // 다음 sync 에서 새 커밋으로 잡혀 라운드가 한 번 더 돈다.
    let headSha = reviewed.headSha ?? ctx.headShaAtLastReview;
    let baseRef = reviewed.baseRef ?? ctx.baseRefAtLastReview ?? null;
    try {
      const sync = fetchPRSyncData(ctx.owner, ctx.repo, ctx.prNumber);
      if (!reviewed.headSha) headSha = sync.headSha;
      if (!reviewed.baseRef) baseRef = sync.baseRef;
      adoptThreads(ctx, sync.threads, getViewerLogin(), round);
    } catch {
      console.log(chalk.yellow('  ⚠ 게시 후 스레드 동기화 실패 — 다음 sync 에서 보정됩니다.'));
    }

    // 게시한 것만 센다. 중복이라 빠진 코멘트는 화면에 이미 같은 스레드가 떠
    // 있으므로, 그것까지 세면 "지적 누적" 이 실제 스레드 수와 어긋난다.
    const n = post.posted ? post.inline + post.inBody : 0;
    // 전부 중복이면 새로 전할 말이 없다 — 게시하지 않았으므로 이 라운드는 그대로
    // 작성자 응답 대기로 돌아간다. 이미 열려 있는 지적이 그 대기의 근거다.
    const converged = result.approval === 'approve';
    fire(ctx, converged ? 'POSTED_CLEAN' : 'POSTED_COMMENTS', {
      note: post.posted
        ? `${round}차 완료: 코멘트 ${n}개, approval=${result.approval}` +
          (post.duplicates > 0 ? ` (중복 ${post.duplicates}개 제외)` : '')
        : `${round}차 완료: 전부 이미 지적한 내용(${post.duplicates}개) — 게시하지 않음`,
      patch: {
        round,
        requestedCount: ctx.requestedCount + n,
        headShaAtLastReview: headSha,
        baseRefAtLastReview: baseRef,
        retryCount: 0,
        lastError: undefined,
        // **지금 열려 있는 것**만 담는다 (adoptThreads 직후라 방금 만든 스레드도
        // 들어 있다). 이미 resolve 된 것은 이번 리뷰에 대한 응답이 아니므로
        // 제외한다 — 그걸 세던 것이 무한 재리뷰의 원인이었다.
        awaitedThreadIds: ctx.threads.filter((t) => !t.isResolved).map((t) => t.id),
      },
    });
    // 수렴하면 대화를 놓아준다 — 새 커밋으로 재개될 때는 새 대화에서 시작한다
    if (converged) releaseConversation(ctx);
    saveContext(cfg, ctx);
    removeReactionFromPullRequest(ctx, 'eyes');
    if (converged) addReactionToPullRequest(ctx, '+1');
    return converged ? 'clean' : 'posted';
  } catch (e) {
    if (e instanceof QuotaLimitError) {
      const retryAt = new Date(Date.now() + cfg.quotaCooldownMs).toISOString();
      fire(ctx, 'QUOTA_EXCEEDED', {
        note: e.message,
        patch: { quotaRetryAt: retryAt },
      });
      saveContext(cfg, ctx);
      removeReactionFromPullRequest(ctx, 'eyes');
      console.log(
        chalk.yellow(
          `  ⚠ 쿼터 한도 — ${new Date(retryAt).toLocaleString('ko-KR')} 이후 자동 재시도`,
        ),
      );
      return 'quota';
    }

    // 타임아웃은 **환경 사정**이라 다시 시도하면 대개 풀린다. 파싱 실패·리뷰 거부
    // (같은 답을 다시 써도 결과가 같다)와 같은 붉은 "리뷰 실패" 로 뭉치면, 로그만
    // 보고는 무엇이 잘못됐는지 구분할 수 없다. 상태 전이는 같지만 표기를 나눈다.
    const timedOut = e instanceof ResponseTimeoutError;
    const raw = (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 280);
    const msg = timedOut ? `타임아웃 — ${raw}` : raw;
    fire(ctx, 'REVIEW_FAILED', { note: msg, patch: { lastError: msg } });
    saveContext(cfg, ctx);
    removeReactionFromPullRequest(ctx, 'eyes');
    if (timedOut) {
      console.log(chalk.yellow('  ⏱ 응답 타임아웃:'), raw);
    } else {
      console.error(chalk.red('  ✗ 리뷰 실패:'), raw);
    }
    return 'failed';
  }
}
