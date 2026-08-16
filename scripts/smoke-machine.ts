/**
 * 상태 머신 스모크 테스트 — `npm run smoke`
 *
 * 대표 시나리오의 전이 경로와 불법 전이 차단을 검증한다.
 */

import chalk from 'chalk';
import { fire, canFire, IllegalTransitionError, toMermaid } from '../src/state/machine.js';
import { createContext } from '../src/state/store.js';
import { parseGPTResponse, isAccessFailure } from '../src/parser.js';
import { resolveEvent } from '../src/poster.js';
import {
  ghErrorMessage,
  buildReviewPayload,
  buildPullRequestReactionPayload,
  viewerReactionIds,
  THREAD_ALIAS_CHUNK,
  type PRProbe,
} from '../src/github.js';
import {
  roundMarker,
  syncPRFromProbe,
  adoptThreads,
  applySyncEvents,
  planConversation,
  releaseConversation,
  reconcileCachedOrigin,
  countTurn,
  buildPreviousBlock,
  judgeReclaim,
} from '../src/reviewer.js';
import { parseConversationUrl, findRoundBaseline, classifyStall } from '../src/chatgpt.js';
import { loadConfig } from '../src/config.js';
import {
  acquireLock,
  readLock,
  readLockPort,
  lockPort,
  LockHeldError,
  LockPortBusyError,
} from '../src/lock.js';
import { progress, inferLevel, stripAnsi } from '../src/progress.js';
import { parseIntent } from '../src/ui/server.js';
import {
  publishDaemonFile,
  readDaemonFile,
  clearDaemonFile,
  instanceId,
} from '../src/daemon-file.js';
import { createHash } from 'node:crypto';
import {
  admitsNewPR,
  createRepoSource,
  discoverRepos,
  globToRegExp,
  unsupportedPatterns,
  invalidPRRefs,
  isRefFilterReason,
  parsePRRef,
  passesRefFilters,
  matchesScope,
  nextRepoCache,
  passesFilters,
  resolveWatchScope,
  type FilterablePR,
} from '../src/watch-scope.js';
import {
  buildQueue,
  isQueueable,
  quotaGateUntil,
  TIER_AUTHOR_RESPONDED,
  TIER_FIRST_ROUND,
  TIER_OTHER,
} from '../src/queue.js';
import {
  saveResponse,
  loadLatestResponse,
  hasResponseForRound,
  hasResponseSince,
} from '../src/cache.js';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AppConfig, PRInfo, PRState, PRContext } from '../src/types.js';

let passed = 0;
let failed = 0;

function assert(cond: boolean, name: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
  }
}

const fakePR: PRInfo = {
  owner: 'o',
  repo: 'r',
  number: 1,
  url: 'https://github.com/o/r/pull/1',
  title: 'test',
  author: 'a',
  baseBranch: 'main',
  headBranch: 'feat',
  headSha: 'abc123',
};

// ── 시나리오 1: 정상 2-라운드 수렴 흐름 ────────────────────

{
  const ctx = createContext(fakePR);
  assert(ctx.state === 'REVIEW_DUE', '초기 상태 REVIEW_DUE');

  fire(ctx, 'START_REVIEW');
  assert(ctx.state === 'REVIEWING', 'START_REVIEW → REVIEWING');

  fire(ctx, 'POSTED_COMMENTS', { patch: { round: 1, requestedCount: 3 } });
  assert(ctx.state === 'AWAITING_AUTHOR', 'POSTED_COMMENTS → AWAITING_AUTHOR');
  assert(ctx.round === 1 && ctx.requestedCount === 3, 'patch 적용 (round=1, 요청 3개)');

  fire(ctx, 'AUTHOR_RESPONDED');
  assert(ctx.state === 'REVIEW_DUE', 'AUTHOR_RESPONDED → REVIEW_DUE');

  fire(ctx, 'START_REVIEW');
  fire(ctx, 'POSTED_CLEAN', { patch: { round: 2 } });
  assert(ctx.state === 'CONVERGED', 'POSTED_CLEAN → CONVERGED (수렴)');

  fire(ctx, 'NEW_COMMITS');
  assert(ctx.state === 'REVIEW_DUE', '수렴 후 NEW_COMMITS → REVIEW_DUE (재개)');

  fire(ctx, 'PR_CLOSED');
  assert(ctx.state === 'CLOSED', 'PR_CLOSED → CLOSED');
  assert(ctx.history.length === 7, `히스토리 7건 기록 (실제 ${ctx.history.length})`);
}

// ── 시나리오 2: 쿼터 → 쿨다운 → 재개 ───────────────────────

{
  const ctx = createContext(fakePR);
  fire(ctx, 'START_REVIEW');
  fire(ctx, 'QUOTA_EXCEEDED', { patch: { quotaRetryAt: '2026-01-01T00:00:00Z' } });
  assert(ctx.state === 'QUOTA_BLOCKED', 'QUOTA_EXCEEDED → QUOTA_BLOCKED');

  fire(ctx, 'COOLDOWN_ELAPSED');
  assert(ctx.state === 'REVIEW_DUE', 'COOLDOWN_ELAPSED → REVIEW_DUE');
}

// ── 시나리오 3: 오류 → 재시도 ──────────────────────────────

{
  const ctx = createContext(fakePR);
  fire(ctx, 'START_REVIEW');
  fire(ctx, 'REVIEW_FAILED', { patch: { lastError: 'boom' } });
  assert(ctx.state === 'ERROR', 'REVIEW_FAILED → ERROR');

  fire(ctx, 'RETRY', { patch: { retryCount: 1 } });
  assert(ctx.state === 'REVIEW_DUE', 'RETRY → REVIEW_DUE');
}

// ── 시나리오 4: 불법 전이 차단 ─────────────────────────────

{
  const ctx = createContext(fakePR);
  assert(!canFire('REVIEW_DUE', 'POSTED_COMMENTS'), 'REVIEW_DUE 에서 POSTED_COMMENTS 불가');
  assert(!canFire('CLOSED', 'START_REVIEW'), 'CLOSED 는 terminal (START_REVIEW 불가)');

  let threw = false;
  try {
    fire(ctx, 'AUTHOR_RESPONDED'); // REVIEW_DUE 에서 불법
  } catch (e) {
    threw = e instanceof IllegalTransitionError;
  }
  assert(threw, '불법 전이 시 IllegalTransitionError');
}

// ── 시나리오 5: mermaid 생성 ───────────────────────────────

{
  const m = toMermaid('AWAITING_AUTHOR' as PRState);
  assert(m.includes('stateDiagram-v2'), 'mermaid 다이어그램 생성');
  assert(m.includes('class AWAITING_AUTHOR current'), '현재 상태 강조 포함');
  assert(m.includes('REVIEWING --> QUOTA_BLOCKED: QUOTA_EXCEEDED'), '전이 테이블 반영');
}

// ── 시나리오 6: 파서 — 리뷰 아닌 응답 거부 ─────────────────

{
  const good = parseGPTResponse('```json\n{"summary":"ok","approval":"approve","comments":[]}\n```');
  assert(good.parsed && good.approval === 'approve', '정상 JSON 파싱');

  // 실제로 관측된 오작동: GPT 가 지침 문서를 다듬어 답한 경우
  const prose = parseGPTResponse('코드 리뷰 지침\n\n[P1] 버그·보안\n원하시면 더 짧게 바꿀 수 있습니다.');
  assert(!prose.parsed, '산문 응답은 parsed=false (게시 거부)');

  // JSON 이지만 리뷰 스키마가 아닌 경우
  const wrong = parseGPTResponse('```json\n{"title":"something"}\n```');
  assert(!wrong.parsed, '리뷰 스키마가 아닌 JSON 은 parsed=false');

  const denied = parseGPTResponse('{"summary":"ACCESS_FAILED","approval":"comment","comments":[]}');
  assert(denied.parsed && isAccessFailure(denied), 'ACCESS_FAILED 감지');
  assert(!isAccessFailure(good), '정상 응답은 ACCESS_FAILED 아님');
}

// ── 시나리오 7: 셀프 리뷰 이벤트 하향 ──────────────────────

{
  // GitHub 은 본인 PR 에 APPROVE / REQUEST_CHANGES 를 허용하지 않는다 (422)
  const selfChanges = resolveEvent('request_changes', true);
  assert(selfChanges.event === 'COMMENT' && selfChanges.downgraded, '셀프: request_changes → COMMENT');

  const selfApprove = resolveEvent('approve', true);
  assert(selfApprove.event === 'COMMENT' && selfApprove.downgraded, '셀프: approve → COMMENT');

  const selfComment = resolveEvent('comment', true);
  assert(selfComment.event === 'COMMENT' && !selfComment.downgraded, '셀프: comment 는 그대로');

  const otherChanges = resolveEvent('request_changes', false);
  assert(
    otherChanges.event === 'REQUEST_CHANGES' && !otherChanges.downgraded,
    '타인 PR: request_changes 유지',
  );
  assert(resolveEvent('approve', false).event === 'APPROVE', '타인 PR: approve 유지');

  // 리뷰 지적 [P1]: commit_id 를 빼면 GitHub 이 **게시 시점의 최신 커밋**에 리뷰를
  // 붙인다. 대기하는 2~15분 사이에 push 가 들어오면 모델이 본 적 없는 커밋에
  // APPROVE 가 직접 달려 branch protection 승인 조건까지 만족시킨다.
  const c1 = [{ path: 'src/a.ts', line: 3, body: '지적' }];
  const pinned = JSON.parse(buildReviewPayload('본문', 'approve', c1, 'abc123'));
  assert(pinned.commit_id === 'abc123', '검토한 커밋에 리뷰를 고정한다');
  assert(pinned.event === 'APPROVE', 'event 는 대문자로 정규화된다');
  assert(pinned.comments.length === 1, '인라인 코멘트가 실린다');

  const loose = JSON.parse(buildReviewPayload('본문', 'COMMENT', [], null));
  assert(!('commit_id' in loose), '커밋을 모르면 넣지 않는다 (기존 동작)');
  assert(!('comments' in loose), '코멘트가 없으면 빈 배열을 보내지 않는다');
  assert(
    buildPullRequestReactionPayload('eyes') === '{"content":"eyes"}',
    '리뷰 시작 반응은 eyes',
  );
  assert(
    buildPullRequestReactionPayload('+1') === '{"content":"+1"}',
    '리뷰 수렴 반응은 +1',
  );
  assert(
    viewerReactionIds(
      [
        { id: 1, content: 'eyes', user: { login: 'review-bot' } },
        { id: 2, content: 'eyes', user: { login: 'someone-else' } },
        { id: 3, content: '+1', user: { login: 'review-bot' } },
      ],
      'eyes',
      'Review-Bot',
    ).join(',') === '1',
    '현재 사용자의 지정 반응만 제거 대상으로 고른다',
  );
}

// ── 시나리오 8: gh 오류 메시지 추출 ────────────────────────

{
  const e = Object.assign(new Error('Command failed: gh api ...\ngh: Unprocessable Entity'), {
    stdout:
      '{"message":"Unprocessable Entity","errors":["Review Can not request changes on your own pull request"],"status":"422"}',
  });
  const msg = ghErrorMessage(e);
  assert(msg.includes('own pull request'), 'gh 오류에서 실제 사유 추출');
  assert(!msg.includes('at genericNodeError'), '스택 트레이스 미포함');

  assert(ghErrorMessage(new Error('plain failure')) === 'plain failure', '일반 Error 는 첫 줄');
}

// ── 시나리오 9: probe 기반 동기화 ──────────────────────────

{
  // syncPRFromProbe 는 항상 saveContext 를 호출한다. 실제 dataDir 을 쓰면
  // npm run smoke 가 가짜 PR(o/r#1)을 사용자 상태 저장소에 남기고 status 에 노출된다.
  const cfg: AppConfig = {
    ...loadConfig(),
    dataDir: mkdtempSync(path.join(tmpdir(), 'pr-review-smoke-')),
  };

  const awaiting = (): PRContext => {
    const c = createContext(fakePR);
    fire(c, 'START_REVIEW');
    fire(c, 'POSTED_COMMENTS', {
      patch: { round: 1, headShaAtLastReview: 'abc123' },
    });
    c.threads = [
      { id: 'T1', path: 'a.ts', line: 1, isResolved: false, authorReplied: false, round: 1, snippet: 'x' },
      { id: 'T2', path: 'b.ts', line: 2, isResolved: false, authorReplied: false, round: 1, snippet: 'y' },
    ];
    // 방금 전체 동기화를 마친 상태로 둔다. 그러지 않으면 아래 판정들이 probe 가
    // 아니라 **주기 만료**(fullSyncIntervalMs) 때문에 전체 동기화를 요구하게 되어,
    // 정작 보려던 "probe 만으로 충분한가" 를 못 본다.
    c.lastFullSyncAt = new Date().toISOString();
    return c;
  };

  const probeOf = (c: PRContext, over: Partial<PRProbe>): PRProbe =>
    ({
      owner: c.owner, repo: c.repo, number: c.prNumber, url: c.prUrl, title: c.title,
      author: 'a', baseBranch: 'main', headBranch: 'feat',
      headSha: 'abc123', status: 'OPEN', updatedAt: '2026-01-01T00:00:00Z',
      ...over,
    }) as PRProbe;

  // Phase 0 핵심: resolve 는 updatedAt 을 갱신하지 않으므로 스레드 상태를 직접 봐야 한다
  const c1 = awaiting();
  syncPRFromProbe(cfg, c1, probeOf(c1, {
    threads: [{ id: 'T1', isResolved: true }, { id: 'T2', isResolved: true }],
  }));
  assert(c1.state === 'REVIEW_DUE', 'probe: 전체 resolve → AUTHOR_RESPONDED (updatedAt 무관)');

  // 일부만 resolve 면 아직 대기
  const c2 = awaiting();
  syncPRFromProbe(cfg, c2, probeOf(c2, {
    threads: [{ id: 'T1', isResolved: true }, { id: 'T2', isResolved: false }],
  }));
  assert(c2.state === 'AWAITING_AUTHOR', 'probe: 일부 resolve 는 전이하지 않음');

  // 새 커밋 감지
  const c3 = awaiting();
  syncPRFromProbe(cfg, c3, probeOf(c3, { headSha: 'def456' }));
  assert(c3.state === 'REVIEW_DUE', 'probe: head SHA 변경 → AUTHOR_RESPONDED');

  // PR 닫힘
  const c4 = awaiting();
  syncPRFromProbe(cfg, c4, probeOf(c4, { status: 'MERGED' }));
  assert(c4.state === 'CLOSED', 'probe: 머지 → CLOSED');

  // 모르는 스레드가 보이면 전체 동기화를 요구한다
  const c5 = awaiting();
  const needsFull = syncPRFromProbe(cfg, c5, probeOf(c5, {
    threads: [{ id: 'T1', isResolved: false }, { id: 'T9', isResolved: false }],
  }));
  assert(needsFull, 'probe: 미지의 스레드 발견 시 전체 동기화 요구');

  const c6 = awaiting();
  const noFull = syncPRFromProbe(cfg, c6, probeOf(c6, {
    threads: [{ id: 'T1', isResolved: false }, { id: 'T2', isResolved: false }],
  }));
  assert(!noFull, 'probe: 알던 스레드만 있으면 전체 동기화 불필요');

  // 다만 **주기가 지나면** 알던 스레드만 있어도 전체 동기화를 요구해야 한다 —
  // 코멘트 숨김처럼 probe 가 볼 수 없는 변화를 잡는 유일한 경로다.
  const c6b = awaiting();
  c6b.lastFullSyncAt = new Date(Date.now() - cfg.fullSyncIntervalMs - 1_000).toISOString();
  const dueFull = syncPRFromProbe(cfg, c6b, probeOf(c6b, {
    threads: [{ id: 'T1', isResolved: false }, { id: 'T2', isResolved: false }],
  }));
  assert(dueFull, 'probe: 전체 동기화 주기가 지나면 알던 스레드만 있어도 요구');

  // 리뷰 지적 [P1]: 남의 스레드가 매 tick 전체 동기화를 유발하면 안 된다.
  // adoptThreads 가 소유자와 무관하게 id 를 기록하므로 두 번째 tick 부터는 조용해야 한다.
  const c7 = awaiting();
  const foreign = [
    { id: 'T1', isResolved: false, path: 'a.ts', line: 1, comments: [{ author: 'me', body: 'x' }] },
    { id: 'T2', isResolved: false, path: 'b.ts', line: 2, comments: [{ author: 'me', body: 'y' }] },
    { id: 'TX', isResolved: false, path: 'c.ts', line: 3, comments: [{ author: 'someone-else', body: 'z' }] },
  ];
  const probeThreads = foreign.map((t) => ({ id: t.id, isResolved: t.isResolved }));

  const first = syncPRFromProbe(cfg, c7, probeOf(c7, { threads: probeThreads }));
  assert(first, 'probe: 남의 스레드 최초 발견 시 전체 동기화 요구');

  adoptThreads(c7, foreign, 'me', 1); // 전체 동기화가 일어난 것과 동일한 효과
  assert(!c7.threads.some((t) => t.id === 'TX'), '남의 스레드는 ctx.threads 에 담기지 않는다');
  assert((c7.knownThreadIds ?? []).includes('TX'), '남의 스레드도 knownThreadIds 에는 기록된다');

  const second = syncPRFromProbe(cfg, c7, probeOf(c7, { threads: probeThreads }));
  assert(!second, 'probe: 두 번째 tick 부터 남의 스레드는 전체 동기화를 유발하지 않는다');

  // 쓰기가 임시 dataDir 로 갔음을 확인한다.
  // 실제 dataDir 에 파일이 "없는지" 를 보면, 과거 구현이 남긴 잔여 파일 때문에
  // 올바른 구현이 실패한다. 이 실행이 어디에 썼는지만 보면 충분하다.
  assert(
    existsSync(path.join(cfg.dataDir, 'state', 'o__r__1.json')),
    '테스트 쓰기가 임시 dataDir 로 격리된다',
  );
  rmSync(cfg.dataDir, { recursive: true, force: true });
}

// ── 시나리오 10: alias 청크 분할 (조용한 누락 방지) ────────

{
  // 리뷰 지적 [P2]: 20건을 넘는 awaiting PR 이 조용히 버려지면 그 PR 들은
  // resolve 를 영영 감지하지 못한다. 상한이 아니라 청크로 나눠야 한다.
  const ids = Array.from({ length: 45 }, (_, i) => i + 1);
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += THREAD_ALIAS_CHUNK) {
    chunks.push(ids.slice(i, i + THREAD_ALIAS_CHUNK));
  }
  assert(chunks.length === 3, `45건은 ${THREAD_ALIAS_CHUNK}개씩 3청크 (실제 ${chunks.length})`);
  assert(chunks.flat().length === 45, '청크 분할에서 누락 없음');
  assert(chunks.every((c) => c.length <= THREAD_ALIAS_CHUNK), '각 청크가 상한 이하');
}

// ── 시나리오 11: 대화 URL 파싱 ─────────────────────────────

{
  const uuid = '68c1f0aa-1111-2222-3333-444455556666';
  assert(
    parseConversationUrl(`https://chatgpt.com/c/${uuid}`) === `https://chatgpt.com/c/${uuid}`,
    '대화 URL 인식',
  );
  assert(
    parseConversationUrl(`https://chatgpt.com/c/${uuid}?model=gpt-5#x`) ===
      `https://chatgpt.com/c/${uuid}`,
    '쿼리·프래그먼트는 제거하고 정규화',
  );
  assert(
    parseConversationUrl(`https://chatgpt.com/g/g-abc123/c/${uuid}`) ===
      `https://chatgpt.com/g/g-abc123/c/${uuid}`,
    'GPTs 안의 대화 URL 도 인식',
  );
  // 첫 메시지 전송 전에는 아직 루트다 — 여기서 URL 을 확보하면 안 된다
  assert(parseConversationUrl('https://chatgpt.com/') === null, '루트는 대화 URL 아님');
  assert(parseConversationUrl('https://chatgpt.com/codex') === null, '다른 경로는 대화 URL 아님');
  assert(parseConversationUrl(`https://evil.example/c/${uuid}`) === null, '다른 오리진 거부');
  assert(parseConversationUrl('about:blank') === null, 'URL 이 아니면 null');
}

// ── 시나리오 12: 대화 세션 유지·회전·해제 ──────────────────

{
  const cfg = { ...loadConfig(), maxTurnsPerConversation: 3 };
  const CONV = 'https://chatgpt.com/c/68c1f0aa-1111-2222-3333-444455556666';

  // 1차는 대화가 없으니 새로 연다
  const fresh = createContext(fakePR);
  const p1 = planConversation(cfg, fresh, 1);
  assert(p1.action === 'new' && p1.reason === 'first', '1차 라운드는 새 대화');

  // 2차부터는 저장된 대화로 복귀
  const tracked = createContext(fakePR);
  tracked.conversationUrl = CONV;
  tracked.conversationStartRound = 1;
  tracked.conversationTurns = 1;
  const p2 = planConversation(cfg, tracked, 2);
  assert(p2.action === 'resume' && p2.url === CONV, '2차 라운드는 저장된 대화로 복귀');
  assert(p2.action === 'resume' && p2.turnsUsed === 1, '누적 전송 횟수 계산');

  // 상한(3)에 닿으면 새 대화로 회전한다 — 대화 1개에 diff 가 무한히 쌓이면 안 된다
  tracked.conversationTurns = 2;
  assert(planConversation(cfg, tracked, 3).action === 'resume', '상한 직전까지는 이어서 진행');
  tracked.conversationTurns = 3;
  const rot = planConversation(cfg, tracked, 4);
  assert(rot.action === 'new' && rot.reason === 'rotate', '상한 도달 시 새 대화로 회전');

  // 리뷰 지적 [P2]: 파싱·게시가 실패하면 ctx.round 는 늘지 않지만 프롬프트와 응답은
  // 이미 대화에 쌓인다. 라운드로 세면 자동 재시도가 상한을 그대로 우회한다.
  const retried = createContext(fakePR);
  retried.conversationUrl = CONV;
  retried.conversationStartRound = 1;
  retried.round = 0; // 한 라운드도 완료하지 못했다
  retried.conversationTurns = 3; // 그러나 3회 전송했다 (최초 + 자동 재시도 2회)
  const pr2 = planConversation(cfg, retried, 1);
  assert(
    pr2.action === 'new' && pr2.reason === 'rotate',
    '실패한 재시도도 전송으로 세어 회전시킨다 (라운드 기준이면 우회됨)',
  );
  tracked.conversationTurns = 1;

  // 리뷰 지적 [P2]: URL 은 전송이 정상 반환된 뒤에야 기록된다. 전송·수집 중 예외가
  // 나면 "누적은 있는데 URL 은 없는" 상태가 남는데, 그 대화는 주소를 몰라 다시
  // 갈 수도 없다. 물려받으면 살아남은 새 대화가 상한에 일찍 걸려 조기 회전한다.
  const orphan = createContext(fakePR);
  orphan.conversationTurns = 4; // 앞선 시도들이 URL 확보 전에 죽어 남긴 값
  assert(countTurn(orphan) === 1, 'URL 없는 잔여 누적은 물려받지 않는다');

  const alive = createContext(fakePR);
  alive.conversationUrl = CONV;
  alive.conversationTurns = 2;
  assert(countTurn(alive) === 3, 'URL 이 있으면 그 대화의 누적을 이어서 센다');

  const firstEver = createContext(fakePR);
  assert(countTurn(firstEver) === 1, '첫 전송은 1회');

  // 리뷰 지적 [P1]: dry-run 이 저장된 대화에 프롬프트를 끼워 넣으면, 라운드도 상태도
  // 남지 않은 채 다음 실제 라운드가 같은 회차의 dry-run 응답이 섞인 대화를 물려받는다.
  const pd = planConversation(cfg, tracked, 2, { dryRun: true });
  assert(pd.action === 'new' && pd.reason === 'dry-run', 'dry-run 은 일회성 새 대화를 쓴다');
  assert(
    tracked.conversationUrl === CONV && tracked.conversationStartRound === 1,
    'dry-run 계획은 저장된 대화 참조를 건드리지 않는다',
  );
  assert(
    planConversation(cfg, tracked, 2).action === 'resume',
    'dry-run 이후에도 실제 라운드는 그대로 복귀한다',
  );

  // conversationStartRound·conversationTurns 가 없는 구버전 컨텍스트도 안전하게 이어 쓴다
  const legacy = createContext(fakePR);
  legacy.conversationUrl = CONV;
  const pl = planConversation(cfg, legacy, 7);
  assert(pl.action === 'resume' && pl.turnsUsed === 0, '구버전 컨텍스트는 이번 라운드가 첫 사용');

  // 해제
  tracked.pendingSend = { round: 2, headSha: 'aaa' };
  releaseConversation(tracked);
  assert(
    tracked.conversationUrl === undefined &&
      tracked.conversationStartRound === undefined &&
      tracked.conversationTurns === undefined,
    'releaseConversation 이 대화 참조를 지운다',
  );
  assert(
    tracked.pendingSend === undefined,
    '대기 기록은 그 대화 안의 질문을 가리키므로 함께 버린다',
  );
  assert(
    planConversation(cfg, tracked, 5).action === 'new',
    '해제 후에는 다시 새 대화',
  );
  assert(
    !('conversationUrl' in JSON.parse(JSON.stringify(tracked))),
    '해제된 대화 URL 은 저장 파일에 남지 않는다',
  );
}

// ── 시나리오 13: 수렴·PR 종료 시 대화 해제 ─────────────────

{
  const cfg = loadConfig();
  const CONV = 'https://chatgpt.com/c/68c1f0aa-aaaa-bbbb-cccc-ddddeeeeffff';

  // 수렴하면 놓는다 — 새 커밋으로 재개될 때는 새 대화에서 시작해야 한다
  const conv = createContext(fakePR);
  conv.conversationUrl = CONV;
  conv.conversationStartRound = 1;
  fire(conv, 'START_REVIEW');
  fire(conv, 'POSTED_CLEAN', { patch: { round: 1 } });
  releaseConversation(conv); // runRound 의 수렴 경로와 동일
  assert(conv.state === 'CONVERGED' && !conv.conversationUrl, 'CONVERGED 시 대화 참조 해제');

  // PR 이 닫히면 applySyncEvents 가 놓는다
  const closed = createContext(fakePR);
  closed.conversationUrl = CONV;
  closed.conversationStartRound = 1;
  fire(closed, 'START_REVIEW');
  fire(closed, 'POSTED_COMMENTS', { patch: { round: 1, headShaAtLastReview: 'abc123' } });
  applySyncEvents(cfg, closed, { status: 'MERGED', headSha: 'abc123' });
  assert(closed.state === 'CLOSED' && !closed.conversationUrl, 'PR_CLOSED 시 대화 참조 해제');

  // 미수렴 상태에서는 유지된다 (이슈 #2 의 대상 상태들)
  const awaiting = createContext(fakePR);
  awaiting.conversationUrl = CONV;
  awaiting.conversationStartRound = 1;
  fire(awaiting, 'START_REVIEW');
  fire(awaiting, 'POSTED_COMMENTS', { patch: { round: 1, headShaAtLastReview: 'abc123' } });
  applySyncEvents(cfg, awaiting, { status: 'OPEN', headSha: 'def456' });
  assert(
    awaiting.state === 'REVIEW_DUE' && awaiting.conversationUrl === CONV,
    '미수렴 PR 은 새 커밋이 와도 대화를 유지',
  );
}

// ── 시나리오 14: 이전 라운드 블록 (대화 유지 여부에 따른 모양) ──

{
  const ctx = createContext(fakePR);
  ctx.round = 2;
  ctx.conversationStartRound = 1;
  ctx.threads = [
    { id: 'T0', path: 'old.ts', line: 5, isResolved: true, authorReplied: false, round: 1, snippet: '이미 반영됨' },
    { id: 'T1', path: 'a.ts', line: 10, isResolved: false, authorReplied: false, round: 1, snippet: '널 체크 누락' },
    { id: 'T2', path: 'b.ts', line: 20, isResolved: false, authorReplied: true, round: 2, snippet: '경계값 처리' },
  ];

  // 1차 라운드에는 이전 현황이 없다
  assert(buildPreviousBlock(ctx, 1, false).text === '', '1차 라운드는 이전 블록 없음');

  // 새 대화 — 스니펫까지 실어 맥락을 이월한다
  const fresh = buildPreviousBlock(ctx, 3, false);
  assert(fresh.text.includes('널 체크 누락') && fresh.text.includes('경계값 처리'), '새 대화면 스니펫 포함');
  assert(fresh.shown === 2 && fresh.total === 2, '직전 라운드 + 미해결 과거 항목만 싣는다');
  assert(!fresh.text.includes('이미 반영됨'), '해결된 과거 라운드 항목은 제외');

  // 같은 대화 — 본문은 대화에 있으니 생략하고, 대화에 없는 처리 결과만 싣는다
  const cont = buildPreviousBlock(ctx, 3, true);
  assert(!cont.text.includes('널 체크 누락'), '대화를 이어가면 스니펫 생략');
  assert(cont.text.includes('a.ts:10') && cont.text.includes('b.ts:20'), '경로·라인은 유지');
  assert(
    cont.text.includes('[미해결]') && cont.text.includes('[답변만 있음]'),
    'resolve·답글 여부는 대화에 없는 정보이므로 반드시 싣는다',
  );

  // 회전한 대화 — 그 대화에 없는 과거 라운드는 스니펫을 남긴다
  const rotated = { ...ctx, conversationStartRound: 2 };
  const mixed = buildPreviousBlock(rotated, 3, true);
  assert(mixed.text.includes('널 체크 누락'), '회전 이전 라운드(1차)는 스니펫 유지');
  assert(!mixed.text.includes('경계값 처리'), '회전 이후 라운드(2차)는 스니펫 생략');

  // 상한 초과 시 조용히 버리지 않고 생략 건수를 알린다
  const many = createContext(fakePR);
  many.round = 1;
  many.threads = Array.from({ length: 42 }, (_, i) => ({
    id: `T${i}`, path: `f${i}.ts`, line: i, isResolved: false,
    authorReplied: false, round: 1, snippet: `s${i}`,
  }));
  const capped = buildPreviousBlock(many, 2, false);
  assert(capped.shown === 30 && capped.total === 42, '이전 현황은 30건까지만 싣는다');
  assert(capped.text.includes('그 외 12건 생략'), '생략 건수를 프롬프트에 명시');
}

// ── 시나리오 15: 캐시 응답의 대화 출처 대조 ────────────────

{
  // 리뷰 지적 [P1]: --from-cache 는 아무것도 전송하지 않는다. 캐시가 다른 대화
  // (특히 dry-run 의 일회성 대화)에서 나온 것이면 그 코멘트는 저장된 대화에 없다.
  // 그대로 두면 다음 라운드가 "이 대화에 본문이 있다" 고 오판해 스니펫을 생략한다.
  const CONV = 'https://chatgpt.com/c/68c1f0aa-1111-2222-3333-444455556666';
  const OTHER = 'https://chatgpt.com/c/99999999-0000-0000-0000-000000000000';

  const bound = (): PRContext => {
    const c = createContext(fakePR);
    c.conversationUrl = CONV;
    c.conversationStartRound = 1;
    c.conversationTurns = 1;
    return c;
  };

  // 같은 대화에서 나온 응답 — 유지 (게시 실패 후 --from-cache 재시도의 정상 경로)
  const same = bound();
  assert(
    !reconcileCachedOrigin(same, { round: 2, conversationUrl: CONV }) &&
      same.conversationUrl === CONV,
    '같은 대화에서 나온 캐시는 대화를 유지한다',
  );

  // dry-run 의 일회성 대화에서 나온 응답 — 해제
  const fromDry = bound();
  assert(
    reconcileCachedOrigin(fromDry, { round: 2, conversationUrl: OTHER, dryRun: true }) &&
      !fromDry.conversationUrl,
    'dry-run 대화에서 나온 캐시는 대화를 해제한다',
  );

  // URL 이 같더라도 dry-run 표식이 있으면 믿지 않는다
  const dryButSame = bound();
  assert(
    reconcileCachedOrigin(dryButSame, { round: 2, conversationUrl: CONV, dryRun: true }),
    'dry-run 표식이 있으면 URL 이 같아도 해제한다',
  );

  // 출처를 모르는 구버전 캐시 — 증명할 수 없으므로 해제 (보수적)
  const noMeta = bound();
  assert(
    reconcileCachedOrigin(noMeta, null) && !noMeta.conversationUrl,
    '출처 없는 구버전 캐시는 해제한다',
  );

  // 묶인 대화가 없으면 할 일이 없다
  assert(
    !reconcileCachedOrigin(createContext(fakePR), { round: 1, conversationUrl: OTHER }),
    '대화가 없으면 아무것도 하지 않는다',
  );

  // 해제 후 다음 라운드는 새 대화 + 스니펫까지 실은 프롬프트로 복구된다
  const recovered = bound();
  recovered.round = 2;
  recovered.threads = [
    { id: 'T1', path: 'a.ts', line: 1, isResolved: false, authorReplied: false, round: 2, snippet: '널 체크 누락' },
  ];
  reconcileCachedOrigin(recovered, { round: 2, conversationUrl: OTHER, dryRun: true });
  assert(planConversation(loadConfig(), recovered, 3).action === 'new', '해제 후 새 대화로 시작');
  assert(
    buildPreviousBlock(recovered, 3, false).text.includes('널 체크 누락'),
    '해제 후 프롬프트는 스니펫을 다시 실어 맥락을 이월한다',
  );
}

// ── 시나리오 16: 감시 범위 글롭 ────────────────────────────

{
  assert(globToRegExp('lpaiu-cs/*').test('lpaiu-cs/anything'), '글롭: owner/* 는 그 계정을 매치');
  assert(!globToRegExp('lpaiu-cs/*').test('other/anything'), '글롭: 다른 계정은 매치하지 않음');
  assert(globToRegExp('lpaiu-cs').test('lpaiu-cs/repo'), '글롭: 슬래시 없는 패턴은 owner/* 로 해석');
  assert(globToRegExp('LPAIU-CS/*').test('lpaiu-cs/repo'), '글롭: 대소문자 무시');
  assert(globToRegExp('*/archived-*').test('any/archived-old'), '글롭: 접두/접미 혼합');

  // `*` 가 슬래시를 넘으면 'a/*' 가 'a/b/c' 같은 값까지 삼킨다. 넘지 않아야 한다.
  assert(!globToRegExp('a/*').test('a/b/c'), '글롭: * 는 슬래시를 넘지 않음');

  assert(matchesScope('lpaiu-cs/tool', ['lpaiu-cs/*'], []), 'include 매치');
  assert(
    !matchesScope('lpaiu-cs/archived-x', ['lpaiu-cs/*'], ['*/archived-*']),
    'exclude 가 include 를 이긴다',
  );
  assert(matchesScope('any/repo', [], []), 'include 가 비면 전부 통과 (review-requested 용)');
}

// ── 시나리오 17: 대상 필터 ─────────────────────────────────

{
  const pr = (over: Partial<FilterablePR> = {}): FilterablePR => ({
    owner: 'lpaiu-cs',
    repo: 'osk-system',
    number: 12,
    author: 'lpaiu-cs',
    isDraft: false,
    labels: ['needs-review'],
    ...over,
  });

  assert(passesFilters(pr()).ok, '필터 없음: 통과');

  // draft 는 기본 제외 — 초안까지 대화 한도를 먹으면 안 된다
  assert(!passesFilters(pr({ isDraft: true })).ok, 'draft 는 기본 제외');
  assert(passesFilters(pr({ isDraft: true }), { draft: true }).ok, 'draft: true 면 초안도 통과');

  assert(passesFilters(pr(), { authors: ['LPAIU-CS'] }).ok, '작성자 필터는 대소문자 무시');
  assert(!passesFilters(pr(), { authors: ['someone'] }).ok, '작성자 불일치 시 제외');

  assert(passesFilters(pr(), { labels: ['needs-review'] }).ok, '라벨 하나라도 맞으면 통과');
  assert(!passesFilters(pr({ labels: [] }), { labels: ['needs-review'] }).ok, '라벨 없으면 제외');

  // 조건이 여러 개면 AND
  assert(
    !passesFilters(pr(), { authors: ['lpaiu-cs'], labels: ['nope'] }).ok,
    '조건이 여러 개면 AND 로 적용',
  );

  const verdict = passesFilters(pr({ isDraft: true }));
  assert(!!verdict.reason, '제외 사유가 붙는다');

  // ── skip: 개별 PR 제외 ──
  const skip = ['LPAIU-CS/OSK-System#12'];
  assert(!passesFilters(pr(), { skip }).ok, 'skip 목록의 PR 은 제외 (대소문자 무시)');
  assert(passesFilters(pr({ number: 13 }), { skip }).ok, '번호가 다르면 통과');
  assert(passesFilters(pr({ repo: 'other' }), { skip }).ok, '레포가 다르면 통과');
  assert(passesFilters(pr({ owner: 'other' }), { skip }).ok, '소유자가 다르면 통과');
  assert(passesFilters(pr(), { skip: [] }).ok, '빈 skip 은 아무것도 막지 않는다');
  assert(
    passesFilters(pr({ number: 121 }), { skip: ['lpaiu-cs/osk-system#12'] }).ok,
    '번호는 접두 일치가 아니라 완전 일치 (#12 가 #121 을 막지 않는다)',
  );
  assert(
    passesFilters(pr(), { skip: [' lpaiu-cs/osk-system#12 '] }).ok === false,
    'skip 항목의 앞뒤 여백은 무시',
  );

  // skip 은 가장 먼저 판정된다 — 다른 조건이 명시적 제외를 뒤집으면 안 된다.
  assert(
    !passesFilters(pr({ isDraft: true }), { skip, draft: true }).ok,
    'draft: true 여도 skip 이 이긴다',
  );
  assert(
    passesFilters(pr(), { skip }).reason === 'skip 목록',
    'skip 제외 사유가 다른 조건에 가려지지 않는다',
  );

  // ── only: 리뷰 대상 한정 (skip 의 반대) ──
  const only = ['LPAIU-CS/OSK-System#12'];
  assert(passesFilters(pr(), { only }).ok, 'only 목록의 PR 은 통과 (대소문자 무시)');
  assert(!passesFilters(pr({ number: 13 }), { only }).ok, 'only 목록 밖은 제외');
  assert(passesFilters(pr({ number: 13 }), { only: [] }).ok, '빈 only 는 제한하지 않는다');
  assert(passesFilters(pr({ number: 13 }), {}).ok, 'only 가 없으면 제한하지 않는다');
  assert(
    passesFilters(pr({ number: 13 }), { only }).reason === 'only 목록 밖',
    'only 제외 사유가 붙는다',
  );

  // skip 이 only 를 이긴다 — "확실히 하지 말 것" 이 "이것만 할 것" 보다 강하다.
  assert(
    !passesFilters(pr(), { only, skip }).ok &&
      passesFilters(pr(), { only, skip }).reason === 'skip 목록',
    '같은 PR 이 양쪽에 있으면 skip 이 이긴다',
  );

  // only 를 통과한 뒤에는 나머지 조건이 그대로 적용된다 (only 는 면제권이 아니다).
  assert(
    !passesFilters(pr({ isDraft: true }), { only }).ok,
    'only 를 통과해도 draft 제외는 그대로 적용된다',
  );
  assert(
    !passesFilters(pr({ number: 13 }), { only, authors: ['lpaiu-cs'] }).ok,
    '작성자가 맞아도 only 밖이면 제외',
  );

  // 형식이 틀리면 아무것도 매치하지 않아 조용히 무효가 된다 — 시작 시 잡아야 한다.
  // 결과는 정반대로 갈린다: skip 오타는 리뷰돼 버리고, only 오타는 전부 멈춘다.
  assert(invalidPRRefs({ skip: ['owner/repo#12'] }).length === 0, '정상 형식은 통과');
  assert(
    invalidPRRefs({ skip: ['owner/repo', '#12', 'owner/repo#', 'owner#12'] }).length === 4,
    '번호·소유자가 빠진 항목은 형식 오류',
  );
  assert(invalidPRRefs(undefined).length === 0, 'skip 이 없으면 오류도 없다');
  assert(
    invalidPRRefs({ skip: [' owner/repo#12 '] }).length === 0,
    '여백만 있는 차이는 오류가 아니다 (판정과 같은 기준)',
  );
  assert(invalidPRRefs({ only: ['owner/repo'] }).length === 1, 'only 도 형식을 검사한다');

  // ── 리뷰 지적 [P2]: 검증과 대조가 갈라지면 검증이 무의미해진다 ──
  // 예전 정규식은 아래 셋을 정상으로 통과시켰는데, prKey 는 그런 키를 만들지
  // 않으므로 절대 매치되지 않았다. skip 이면 제외한 줄 알았던 PR 이 리뷰된다.
  assert(
    invalidPRRefs({ skip: ['owner/repo/extra#12'] }).length === 1,
    '레포 이름에 슬래시가 든 참조는 형식 오류 (매치될 수 없다)',
  );
  assert(
    invalidPRRefs({ skip: ['owner/repo#0'] }).length === 1,
    'PR 번호 0 은 형식 오류 (1부터 시작한다)',
  );
  assert(parsePRRef('owner/repo/extra#12') === null, 'parsePRRef: 슬래시 낀 레포 거부');
  assert(parsePRRef('owner/repo#0') === null, 'parsePRRef: 0번 거부');
  assert(parsePRRef('owner/repo#-1') === null, 'parsePRRef: 음수 거부');
  assert(parsePRRef('owner/repo#1e3') === null, 'parsePRRef: 지수 표기 거부');

  // 선행 0 은 사람이 적은 표기 차이일 뿐이므로 같은 키로 접는다.
  assert(parsePRRef('Owner/Repo#007') === 'owner/repo#7', 'parsePRRef: 선행 0 과 대소문자 정규화');
  assert(invalidPRRefs({ skip: ['owner/repo#007'] }).length === 0, '선행 0 은 오류가 아니다');
  assert(
    !passesFilters(pr({ owner: 'lpaiu-cs', repo: 'osk-system', number: 7 }), {
      skip: ['lpaiu-cs/osk-system#007'],
    }).ok,
    '#007 로 적어도 7번 PR 이 실제로 제외된다 (검증 통과 = 대조 성립)',
  );

  // 불변식: 형식 검증을 통과한 참조는 반드시 어떤 PR 과 대조될 수 있어야 한다.
  const probes = ['owner/repo#12', ' Owner/Repo#007 ', 'a-b.c/d_e#1'];
  assert(
    probes.every((p) => {
      const key = parsePRRef(p);
      if (!key) return false;
      const [slug, num] = key.split('#');
      const [owner, repo] = slug.split('/');
      return !passesFilters(pr({ owner, repo, number: Number(num) }), { skip: [p] }).ok;
    }),
    '통과한 참조는 예외 없이 실제 매치로 이어진다',
  );
  assert(
    invalidPRRefs({ skip: ['bad1'], only: ['bad2'] }).join(' ') === 'skip: "bad1" only: "bad2"',
    '어느 목록의 어떤 항목이 틀렸는지 알려준다',
  );
}

// ── 시나리오 18: 감시 범위 해석 (구버전 설정 호환) ─────────

{
  const base = loadConfig();

  const legacy: AppConfig = { ...base, watch: undefined, watchRepos: ['o/r'] };
  const s1 = resolveWatchScope(legacy);
  assert(s1?.mode === 'repos' && s1.include[0] === 'o/r', 'watchRepos 만 있으면 repos 모드로 폴백');

  const both: AppConfig = {
    ...base,
    watch: { mode: 'account', include: ['org/*'], filters: { draft: true } },
    watchRepos: ['o/r'],
  };
  const s2 = resolveWatchScope(both);
  assert(s2?.mode === 'account' && s2.include[0] === 'org/*', 'watch.include 가 watchRepos 를 이긴다');

  // include 가 비어 있으면 watchRepos 로 내려가되 필터는 watch 것을 이어받는다
  const emptyInclude: AppConfig = {
    ...base,
    watch: { mode: 'account', include: [], filters: { draft: true }, exclude: ['*/x-*'] },
    watchRepos: ['o/r'],
  };
  const s3 = resolveWatchScope(emptyInclude);
  assert(s3?.mode === 'repos' && s3.include[0] === 'o/r', 'include 가 비면 watchRepos 로 폴백');
  assert(s3?.filters?.draft === true && s3.exclude?.[0] === '*/x-*', '폴백 시에도 필터·exclude 유지');

  // review-requested 는 검색 자체가 범위라 include 없이도 성립한다
  const rr: AppConfig = { ...base, watch: { mode: 'review-requested', include: [] }, watchRepos: [] };
  assert(resolveWatchScope(rr)?.mode === 'review-requested', 'review-requested 는 include 없이 성립');

  const nothing: AppConfig = { ...base, watch: undefined, watchRepos: [] };
  assert(resolveWatchScope(nothing) === null, '대상이 없으면 null');
}

// ── 시나리오 19: 리뷰 큐 우선순위 ──────────────────────────

{
  /** REVIEW_DUE 진입 시각을 고정해 정렬을 결정적으로 만든다. */
  const stamp = (ctx: PRContext, at: string): PRContext => {
    for (let i = ctx.history.length - 1; i >= 0; i--) {
      if (ctx.history[i].to === 'REVIEW_DUE') {
        ctx.history[i].at = at;
        return ctx;
      }
    }
    ctx.createdAt = at;
    return ctx;
  };

  const at = (n: number) => `2026-01-0${n}T00:00:00.000Z`;

  // 라운드 미진행 — 오래된 쪽이 먼저
  const fresh = (num: number, when: string) =>
    stamp(createContext({ ...fakePR, number: num }), when);

  const a = fresh(1, at(1));
  const d = fresh(2, at(3));

  // 작성자 응답 완료
  const b = createContext({ ...fakePR, number: 3 });
  fire(b, 'START_REVIEW');
  fire(b, 'POSTED_COMMENTS', { patch: { round: 1 } });
  fire(b, 'AUTHOR_RESPONDED');
  stamp(b, at(2));

  // 그 외 (실패 후 재시도) — round 를 올려 "라운드 미진행" 과 구분한다
  const c = createContext({ ...fakePR, number: 4 });
  fire(c, 'START_REVIEW');
  fire(c, 'POSTED_COMMENTS', { patch: { round: 1 } });
  fire(c, 'AUTHOR_RESPONDED');
  fire(c, 'START_REVIEW');
  fire(c, 'REVIEW_FAILED');
  fire(c, 'RETRY', { patch: { retryCount: 1 } });
  stamp(c, at(1));

  // REVIEW_DUE 가 아닌 것은 큐에 오르지 않는다
  const waiting = createContext({ ...fakePR, number: 5 });
  fire(waiting, 'START_REVIEW');
  fire(waiting, 'POSTED_COMMENTS', { patch: { round: 1 } });

  const q = buildQueue([d, c, b, waiting, a]);
  assert(q.length === 4, `REVIEW_DUE 4건만 큐에 오름 (실제 ${q.length})`);
  assert(!q.some((e) => e.ctx.prNumber === 5), 'AWAITING_AUTHOR 는 큐에서 제외');

  assert(
    q.map((e) => e.ctx.prNumber).join(',') === '1,2,3,4',
    `우선순위: 라운드 미진행 > 작성자 응답 > 그 외, 동순위는 오래 기다린 순 (실제 ${q.map((e) => e.ctx.prNumber).join(',')})`,
  );
  assert(q[0].tier === TIER_FIRST_ROUND && q[0].reason === 'first-round', '1순위 티어/사유');
  assert(q[2].tier === TIER_AUTHOR_RESPONDED && q[2].reason === 'author-responded', '2순위 티어/사유');
  assert(q[3].tier === TIER_OTHER && q[3].reason === 'retry', '3순위 티어/사유');
  assert(q[0].waitingMs >= q[1].waitingMs, '오래 기다린 항목의 대기 시간이 더 길다');

  // 같은 입력이면 순서가 항상 같아야 한다 (재스캔마다 큐를 다시 만들기 때문)
  const again = buildQueue([a, b, c, d]);
  assert(
    again.map((e) => e.ctx.prNumber).join(',') === q.map((e) => e.ctx.prNumber).join(','),
    '입력 순서가 달라도 큐 순서는 동일 (결정적)',
  );
}

// ── 시나리오 20: 쿼터 게이트 — 큐 보존 ─────────────────────

{
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  const blocked = createContext({ ...fakePR, number: 9 });
  fire(blocked, 'START_REVIEW');
  fire(blocked, 'QUOTA_EXCEEDED', { patch: { quotaRetryAt: '2026-01-01T03:00:00.000Z' } });

  const pending = createContext({ ...fakePR, number: 10 });

  const gate = quotaGateUntil([blocked, pending], now);
  assert(gate === Date.parse('2026-01-01T03:00:00.000Z'), '쿨다운이 남으면 해제 시각을 반환');

  // 핵심: 한도에 걸려도 나머지 대상은 큐에 그대로 남는다 (사이클 중단이 아니라 보류)
  assert(buildQueue([blocked, pending], now).length === 1, '쿼터 중에도 대기 항목은 큐에 보존');

  const after = Date.parse('2026-01-01T04:00:00.000Z');
  assert(quotaGateUntil([blocked, pending], after) === null, '쿨다운 경과 후에는 게이트 해제');

  // 여러 건이 막혔으면 가장 늦게 풀리는 시각을 따른다
  const later = createContext({ ...fakePR, number: 11 });
  fire(later, 'START_REVIEW');
  fire(later, 'QUOTA_EXCEEDED', { patch: { quotaRetryAt: '2026-01-01T05:00:00.000Z' } });
  assert(
    quotaGateUntil([blocked, later], now) === Date.parse('2026-01-01T05:00:00.000Z'),
    '가장 늦은 해제 시각을 따른다',
  );

  assert(quotaGateUntil([pending], now) === null, '막힌 PR 이 없으면 게이트 없음');
}

// ── 시나리오 21: 큐 자격 — 필터에 걸린 컨텍스트 제외 ───────

{
  // 리뷰 지적 [P2]: queue 명령이 watch 와 다른 답을 내면 안 된다. 스캔이 남긴
  // excludedReason 을 buildQueue 가 읽어 둘이 같은 규칙을 쓴다.
  const plain = createContext({ ...fakePR, number: 20 });
  const excluded = createContext({ ...fakePR, number: 21 });
  excluded.excludedReason = '초안(draft)';

  assert(isQueueable(plain), '필터를 통과한 REVIEW_DUE 는 큐 자격 있음');
  assert(!isQueueable(excluded), 'excludedReason 이 붙으면 큐 자격 없음');

  const q = buildQueue([plain, excluded]);
  assert(q.length === 1 && q[0].ctx.prNumber === 20, '큐에서 필터 제외 항목이 빠진다');

  // 필터를 다시 통과하면 되살아나야 한다 (draft 해제·라벨 재부착)
  delete excluded.excludedReason;
  assert(buildQueue([plain, excluded]).length === 2, '필터를 다시 통과하면 큐에 복귀');
}

// ── 시나리오 22: review-requested 는 PR 단위로 제한 ────────

{
  // 리뷰 지적 [P1]: 검색 결과를 레포로 축약하면 "리뷰 요청받은 PR 1건" 때문에
  // 그 레포의 열린 PR 전부가 대상이 된다.
  //
  // 2차 리뷰 지적 [P1]: 판정을 테스트에서 복제하면 실제 경계를 놓친다.
  // scan() 이 쓰는 admitsNewPR 을 그대로 부른다.
  const targets = new Map<string, Set<number>>([['o/r', new Set([7])]]);

  assert(admitsNewPR(targets, 'o/r', 7), '요청받은 PR 은 새로 추적한다');
  assert(!admitsNewPR(targets, 'o/r', 9), '요청받지 않은 같은 레포의 PR 은 추적하지 않는다');

  // 핵심 경계: Map 은 있지만 그 레포 키가 없는 경우.
  // 리뷰를 게시하면 요청이 해제되어 레포가 targets 에서 통째로 빠지는데,
  // 기존 컨텍스트 때문에 레포는 계속 스캔된다. 이때 무제한으로 넘기면
  // 그 레포의 요청받지 않은 다른 PR 이 전부 자동 리뷰된다.
  assert(
    !admitsNewPR(targets, 'o/other', 1),
    '제한 모드에서 목록에 없는 레포는 전부 거부 (빈 목록 ≠ 무제한)',
  );

  // account/repos 모드 (targets 자체가 없음) 는 제한이 없다
  assert(admitsNewPR(undefined, 'o/r', 9), '제한이 없으면 모든 PR 이 대상');

  // 이미 추적 중인 PR 은 이 판정과 무관하게 계속 간다 (scan 의 `!existing &&` 조건).
  // 리뷰 게시로 요청이 해제되면 2차 라운드가 영영 오지 않기 때문이다.
  const existing = true;
  assert(!(!existing && !admitsNewPR(targets, 'o/r', 9)), '이미 추적 중이면 계속 추적한다');
}

// ── 시나리오 23: 탐색 캐시 갱신 규칙 ───────────────────────

{
  // 부분 실패면 아무것도 빼지 않는다 (실패한 범위의 레포 보존)
  assert(
    nextRepoCache(['a/one', 'b/two'], { repos: ['a/one'], partial: true }).includes('b/two'),
    '부분 실패 시 실패한 범위의 레포가 유지된다',
  );

  // 2차 리뷰 지적 [P2]: 완전히 성공한 빈 결과는 유효한 답이다.
  // 과거 목록을 되살리면 이미 정리된 레포를 10초마다 계속 probe 한다.
  assert(
    nextRepoCache(['a/one', 'b/two'], { repos: [], partial: false }).length === 0,
    '완전 성공한 빈 결과는 캐시를 비운다',
  );
  assert(
    nextRepoCache(['a/one', 'b/two'], { repos: [], partial: true }).length === 2,
    '부분 실패의 빈 결과는 캐시를 유지한다',
  );

  const shrunk = nextRepoCache(['a/one', 'b/two'], { repos: ['a/one'], partial: false });
  assert(!shrunk.includes('b/two'), '완전 성공 시 사라진 레포는 정상적으로 빠진다');
}

// ── 시나리오 24: 라벨 목록이 잘리면 제외하지 않는다 ────────

{
  // 2차 리뷰 지적 [P2]: first:100 은 페이지 크기이지 완결 보장이 아니다.
  // 잘린 목록으로 "라벨이 없다" 를 단정해 제외하면 그 PR 은 조용히 영영
  // 리뷰되지 않는다. 불완전한 근거로는 제외하지 않는다.
  const base = { author: 'a', isDraft: false };
  const filters = { labels: ['needs-review'] };

  assert(
    !passesFilters({ ...base, labels: ['other'], labelsTruncated: false }, filters).ok,
    '목록이 완전하면 라벨 없는 PR 은 제외한다',
  );
  assert(
    passesFilters({ ...base, labels: ['other'], labelsTruncated: true }, filters).ok,
    '목록이 잘렸으면 제외하지 않는다 (거짓 음성 방지)',
  );
  assert(
    passesFilters({ ...base, labels: ['needs-review'], labelsTruncated: true }, filters).ok,
    '잘렸어도 대상 라벨이 이미 보이면 그대로 통과',
  );

  // 잘림은 라벨 조건에만 영향을 준다 — draft 는 그대로 제외
  assert(
    !passesFilters({ ...base, isDraft: true, labels: [], labelsTruncated: true }, filters).ok,
    '라벨 잘림이 draft 제외까지 무력화하지는 않는다',
  );
}

// ── 시나리오 25: 열린 PR 이 없어진 레포도 계속 훑는다 ──────

{
  // 리뷰 지적 [P2]: 검색은 열린 PR 이 있는 레포만 준다. 마지막 PR 이 닫히면
  // 레포가 목록에서 빠져 추적 중이던 컨텍스트가 PR_CLOSED 를 못 받는다.
  const discovered = ['o/alive'];
  const contexts = [
    { owner: 'o', repo: 'alive', state: 'REVIEW_DUE' as PRState },
    { owner: 'o', repo: 'gone', state: 'AWAITING_AUTHOR' as PRState }, // 마지막 PR 이 닫힌 레포
    { owner: 'o', repo: 'done', state: 'CLOSED' as PRState }, // 이미 정리됨
    { owner: 'x', repo: 'other', state: 'REVIEW_DUE' as PRState }, // 범위 밖
  ];

  const include = ['o/*'];
  const lingering = [
    ...new Set(contexts.filter((c) => c.state !== 'CLOSED').map((c) => `${c.owner}/${c.repo}`)),
  ].filter((s) => !discovered.includes(s) && matchesScope(s, include, []));

  assert(lingering.includes('o/gone'), '살아있는 컨텍스트가 있는 레포는 계속 훑는다');
  assert(!lingering.includes('o/done'), 'CLOSED 만 남은 레포는 다시 훑지 않는다');
  assert(!lingering.includes('o/alive'), '이미 발견된 레포는 중복되지 않는다');
  assert(!lingering.includes('x/other'), '감시 범위 밖 레포는 되살리지 않는다');
}

// ── 시나리오 35: 회수 전 리뷰 대상 검증 ────────────────────

{
  // 대화 + 라운드 번호만으로 회수하면, 죽어 있는 동안 들어온 커밋을 못 본다.
  // 낡은 diff 를 보고 만든 답을 게시한 뒤 **현재** 상태를 검토 완료로 적으면
  // 한 번도 보지 않은 코드가 approve 하나로 CONVERGED 가 된다.
  const c = createContext(fakePR);
  const at = (headSha: string | null, baseRef: string | null = 'main') => ({ headSha, baseRef });

  assert(judgeReclaim(c, 2, at('A')) === 'no-record', '전송 기록이 없으면 회수하지 않는다');

  c.pendingSend = { round: 2, headSha: 'A', baseRef: 'main' };
  assert(judgeReclaim(c, 3, at('A')) === 'no-record', '다른 라운드의 기록은 쓰지 않는다');
  assert(judgeReclaim(c, 2, at('A')) === 'ok', '같은 라운드 · 같은 대상이면 회수한다');
  assert(judgeReclaim(c, 2, at('B')) === 'moved', 'head 가 달라졌으면 다시 묻는다');

  // 리뷰가 보는 건 커밋 하나가 아니라 `base...head` 다. base 가 바뀌면 head 가
  // 그대로여도 완전히 다른 diff 이고, 그 답으로 approve 하면 바뀐 diff 를 한 번도
  // 검토하지 않은 채 CONVERGED 로 남는다.
  assert(judgeReclaim(c, 2, at('A', 'release')) === 'rebased', 'base 가 바뀌었으면 다시 묻는다');

  // 판별 불가는 전부 "다시 묻기" 로 떨어진다. 다시 묻는 비용은 대화 1회지만
  // 잘못 회수하면 리뷰를 통째로 건너뛴다 — 방향이 다르다.
  assert(judgeReclaim(c, 2, at(null)) === 'unknown-current', '현재 대상을 모르면 다시 묻는다');
  assert(judgeReclaim(c, 2, at('A', null)) === 'unknown-current', '현재 base 를 모르면 다시 묻는다');
  c.pendingSend = { round: 2, headSha: null, baseRef: 'main' };
  assert(judgeReclaim(c, 2, at('A')) === 'unknown-sent', '질문 당시 head 를 모르면 다시 묻는다');
  // base 를 안 남기던 구버전 컨텍스트도 같은 길로 떨어진다 — 조용히 회수하면 안 된다.
  c.pendingSend = { round: 2, headSha: 'A' };
  assert(judgeReclaim(c, 2, at('A')) === 'unknown-sent', '구버전 기록(base 없음)은 회수하지 않는다');
}

// ── 시나리오 36: base 변경도 리뷰 대상 변경이다 ────────────

{
  // 회수 직전에 한 번 대조하는 것만으로는 못 막는다. 판정과 응답 확보 사이가
  // 2~15분이고, 정상 경로(전송 → 대기 → 게시)에도 같은 창이 있다. base 를 상태로
  // 추적해야 그 사이의 변경이 다음 sync 에서 잡힌다.
  const cfg = loadConfig();

  const conv = createContext(fakePR);
  fire(conv, 'START_REVIEW');
  fire(conv, 'POSTED_CLEAN', {
    patch: { round: 1, headShaAtLastReview: 'A', baseRefAtLastReview: 'main' },
  });
  applySyncEvents(cfg, conv, { status: 'OPEN', headSha: 'A', baseRef: 'main' });
  assert(conv.state === 'CONVERGED', '같은 대상이면 수렴 유지');
  applySyncEvents(cfg, conv, { status: 'OPEN', headSha: 'A', baseRef: 'release' });
  assert(conv.state === 'REVIEW_DUE', 'head 가 같아도 base 가 바뀌면 리뷰를 재개한다');

  const waiting = createContext(fakePR);
  fire(waiting, 'START_REVIEW');
  fire(waiting, 'POSTED_COMMENTS', {
    patch: { round: 1, headShaAtLastReview: 'A', baseRefAtLastReview: 'main' },
  });
  applySyncEvents(cfg, waiting, { status: 'OPEN', headSha: 'A', baseRef: 'release' });
  assert(waiting.state === 'REVIEW_DUE', 'AWAITING_AUTHOR 에서도 base 변경은 작성자 응답');

  // 구버전 컨텍스트(base 기록 없음)나 base 를 안 싣는 스냅샷은 판정하지 않는다 —
  // 모르는 값으로 전이시키면 매 tick 리뷰가 재개된다.
  const legacy = createContext(fakePR);
  fire(legacy, 'START_REVIEW');
  fire(legacy, 'POSTED_CLEAN', { patch: { round: 1, headShaAtLastReview: 'A' } });
  applySyncEvents(cfg, legacy, { status: 'OPEN', headSha: 'A', baseRef: 'release' });
  assert(legacy.state === 'CONVERGED', 'base 기록이 없으면 base 로 전이시키지 않는다');
  applySyncEvents(cfg, legacy, { status: 'OPEN', headSha: 'A' });
  assert(legacy.state === 'CONVERGED', 'base 를 안 싣는 스냅샷도 그대로 둔다');
}

// ── 시나리오 38: 정체 구간의 성격 분류 (이슈 #1) ───────────

{
  // 이슈 #1 은 (a)스트림 사망 / (b)셀렉터 오탐 / (c)실제 생성 중을 가리기 전에는
  // 고치지 말라고 못박고 있다. 이 분류는 **판정이 아니라 관측**이다 — 이 값으로
  // 대기를 끊지 않는다. 무트래픽 시간은 종료의 근거가 못 되기 때문이다:
  // 생성 POST 가 먼저 끝나고 결과가 비동기로 오는 구조면 조용한 게 정상이고,
  // 그때 끊으면 안정돼 보이는 부분 응답을 완성본으로 게시한다.
  const LIMIT = 180_000;
  const at = (o: Partial<Parameters<typeof classifyStall>[0]>) =>
    classifyStall({ button: true, sawGeneration: true, inFlight: 0, quietMs: 0, ...o }, LIMIT);

  assert(at({ button: false }) === 'idle', '버튼이 없으면 생성 중이 아니다');
  assert(at({ inFlight: 1, quietMs: 10 * LIMIT }) === 'generating', '요청이 진행 중이면 (c)');
  assert(at({ quietMs: LIMIT - 1 }) === 'generating', '조용해도 한계 전이면 (c) 로 본다');
  assert(at({ quietMs: LIMIT + 1 }) === 'network-quiet', '오래 조용하면 (a) 후보로 기록');

  // 추적이 한 번도 안 걸렸으면 근거 자체가 없다 — 그렇게 기록한다.
  assert(at({ sawGeneration: false, quietMs: 10 * LIMIT }) === 'untracked', '관측 불가는 untracked');
  assert(at({ sawGeneration: false, button: false }) === 'idle', '추적 불가여도 버튼이 없으면 idle');
}

// ── 시나리오 34: 대화에서 라운드 기준점 찾기 ───────────────

{
  const M = '리뷰 라운드: 3차';
  const u = (t: string) => ({ role: 'user', text: t });
  const a = (t: string) => ({ role: 'assistant', text: t });

  assert(findRoundBaseline([], M) === null, '빈 대화는 null');
  assert(findRoundBaseline([u('리뷰 라운드: 2차'), a('r2')], M) === null, '다른 라운드만 있으면 null');

  // 응답 대기 중 죽은 경우 — 질문만 있다
  assert(findRoundBaseline([u(M)], M) === 0, '첫 질문이면 기준점 0');
  assert(
    findRoundBaseline([u('리뷰 라운드: 2차'), a('r2'), u(M)], M) === 1,
    '앞선 응답 1건이 있으면 기준점 1',
  );

  // **기준점은 대상 노드를 포함하지 않아야 한다.** 포함하면 collectResponse 가
  // 오지 않을 다음 메시지를 기다리다 60초 뒤 실패한다.
  assert(
    findRoundBaseline([u('리뷰 라운드: 2차'), a('r2'), u(M), a('생성 중…')], M) === 1,
    '대상 응답이 이미 떠 있어도 기준점은 그대로 1 (다시 세면 안 된다)',
  );

  // 뒤에 다른 질문이 이어지면 어느 응답이 그 라운드 것인지 단정할 수 없다
  assert(
    findRoundBaseline([u(M), a('r3'), u('리뷰 라운드: 4차')], M) === null,
    '그 라운드가 마지막 질문이 아니면 null (평소 경로로 다시 묻는다)',
  );
  assert(
    findRoundBaseline([u(M), a('r3'), u('리뷰 라운드: 4차')], '리뷰 라운드: 4차') === 1,
    '마지막 질문이면 그 기준점을 준다',
  );

  // 같은 라운드를 두 번 물어본 대화(이 버그가 만들어낸 상태)
  assert(
    findRoundBaseline([u(M), a('낡은 답'), u(M)], M) === 1,
    '중복 질문이면 나중 질문 기준으로 센다',
  );
}

// ── 시나리오 37: 응답 존재 판정은 라운드가 아니라 전송 단위 ─

{
  // 2차 첫 응답이 파싱 실패로 저장된 뒤 자동 재시도가 2차 질문을 **다시** 보내고,
  // 그 응답을 기다리다 죽으면 — 두 번째 전송은 답을 받은 적이 없는데 첫 응답
  // 파일 때문에 회수가 막힌다. 그러면 같은 질문이 또 나가서, 이 PR 이 막으려는
  // 낭비가 그대로 재발한다.
  const dir = mkdtempSync(path.join(tmpdir(), 'pr-review-cache-'));
  const cfg = { ...loadConfig(), dataDir: dir };
  const ctx = createContext(fakePR);

  const first = saveResponse(cfg, ctx, 2, '첫 응답 (파싱 실패)');
  const T1 = Date.parse('2026-08-09T10:00:00Z');
  utimesSync(first, new Date(T1), new Date(T1));

  assert(hasResponseForRound(cfg, ctx, 2), '라운드 단위로는 응답이 있다');
  assert(hasResponseSince(cfg, ctx, 2, T1), '그 전송 시점 이후로도 있다');
  assert(
    !hasResponseSince(cfg, ctx, 2, T1 + 1_000),
    '이후 재전송은 아직 답을 받은 적이 없다 — 회수를 막지 않는다',
  );

  const second = saveResponse(cfg, ctx, 2, '두 번째 응답');
  utimesSync(second, new Date(T1 + 2_000), new Date(T1 + 2_000));
  assert(hasResponseSince(cfg, ctx, 2, T1 + 1_000), '두 번째 전송이 답을 받으면 그때는 막는다');

  // 전송 시각을 모르는 구버전 기록은 라운드 단위로 물러선다 — 회수를 놓치는 쪽이
  // 낡은 응답을 게시하는 쪽보다 낫다.
  assert(hasResponseSince(cfg, ctx, 2, null), '전송 시각을 모르면 라운드 단위로 판정');
  assert(!hasResponseSince(cfg, ctx, 3, null), '응답이 없는 라운드는 그대로 false');

  // 검토 대상은 사이드카에 남는다. --from-cache 는 아무것도 전송하지 않으므로
  // 여기 없으면 게시 시점의 최신 커밋에 리뷰가 붙고 그게 검토 완료로 기록된다.
  saveResponse(cfg, ctx, 4, '4차 응답', { headSha: 'sha4', baseRef: 'main' });
  const hit = loadLatestResponse(cfg, ctx);
  assert(hit?.meta?.headSha === 'sha4' && hit?.meta?.baseRef === 'main', '캐시가 검토 대상을 남긴다');

  rmSync(dir, { recursive: true, force: true });
}

// ── 시나리오 33: 라운드 마커 (중복 질문 방지) ─────────────

{
  // 응답 대기(2~15분) 중에 죽으면 질문은 대화에 남고 우리 기록은 없다. 그대로 다시
  // 보내면 같은 질문이 한 번 더 들어가 대화 한도를 버린다. 대화에서 그 라운드를
  // 식별하는 기준이 이 마커다.
  const base = loadConfig();
  const mk = createContext(fakePR);
  assert(roundMarker(base, mk, 3) === '리뷰 라운드: 3차', '기본 템플릿에서 마커 추출');
  assert(roundMarker(base, mk, 12) === '리뷰 라운드: 12차', '두 자리 라운드');

  // 부분 일치로 오판하면 안 된다 — 1차 마커가 12차 메시지에 걸리면 재질문을
  // 건너뛰고 엉뚱한 라운드의 응답을 쓰게 된다.
  const m1 = roundMarker(base, mk, 1) as string;
  assert(!'리뷰 라운드: 12차'.includes(m1), '1차 마커가 12차 메시지에 걸리지 않는다');
  assert(!'리뷰 라운드: 21차'.includes(m1), '1차 마커가 21차 메시지에 걸리지 않는다');
  assert('리뷰 라운드: 1차 리뷰 요청'.includes(m1), '같은 라운드 메시지에는 걸린다');

  // 마커는 **실제로 전송되는 문자열**과 같아야 한다. {{round}} 만 치환하면 같은 줄의
  // 다른 변수가 남아 findRound 가 못 찾고, 멱등성이 조용히 깨진다.
  assert(
    roundMarker({ ...base, promptTemplate: 'PR {{url}} — 리뷰 라운드: {{round}}차' }, mk, 3) ===
      `PR ${mk.prUrl} — 리뷰 라운드: 3차`,
    '같은 줄의 {{url}} 도 렌더링한다',
  );

  // 판별 불가는 항상 "다시 묻기" 로 떨어져야 한다 (null → 호출부가 종전대로 전송).
  assert(
    roundMarker({ ...base, promptTemplate: ['PR: {{url}}', '리뷰해줘'].join('\n') }, mk, 3) === null,
    '{{round}} 가 없는 템플릿이면 판별하지 않는다',
  );
  assert(roundMarker({ ...base, promptTemplate: '' }, mk, 3) === null, '빈 템플릿도 null');
  assert(
    roundMarker({ ...base, promptTemplate: '{{round}}차 {{previous}}' }, mk, 3) === null,
    '여러 줄로 펼쳐지는 블록이 같은 줄에 있으면 재현할 수 없다',
  );
  assert(
    roundMarker({ ...base, promptTemplate: '{{round}}차 {{unknown}}' }, mk, 3) === null,
    '렌더링하지 못한 변수가 남으면 판별하지 않는다',
  );
}

// ── 시나리오 32: probe 를 건너뛴 주기의 제외 판정 ──────────

{
  // 리뷰 지적 [P2]: probe 를 생략하면 excludedReason 이 갱신되지 않는다. 그 사이
  // 사용자가 건너뛰기를 누르면 낡은 값 때문에 **방금 제외한 PR 이 리뷰된다.**
  // effectiveExclusion 이 하는 판정을 그대로 재현한다 (cli.ts 는 import 불가).
  const KEY = 'lpaiu-cs/osk-system#12';
  const effective = (cached: string | undefined, filters: any): string | undefined => {
    const live = passesRefFilters(KEY, filters);
    if (!live.ok) return live.reason;
    return cached && !isRefFilterReason(cached) ? cached : undefined;
  };

  // 직전 probe 때는 통과였고(캐시 없음) 그 뒤 skip 이 걸린 상황
  assert(effective(undefined, { skip: [KEY] }) === 'skip 목록', '캐시가 비어도 지금 skip 이면 제외된다');
  assert(effective(undefined, { only: ['other/x#1'] }) === 'only 목록 밖', 'only 도 즉시 반영된다');

  // 반대로 직전 probe 때 skip 이었는데 그 뒤 해제된 상황
  assert(effective('skip 목록', {}) === undefined, '지금 해제됐으면 낡은 캐시를 무시한다');

  // 설정만으로 다시 계산할 수 없는 사유는 캐시가 유효하다
  assert(effective('초안(draft)', {}) === '초안(draft)', 'draft 캐시는 유지된다');
  assert(effective('작성자 bot 는 대상 아님', {}) === '작성자 bot 는 대상 아님', 'authors 캐시도 유지');

  // skip 이 only 를 이긴다는 규칙이 여기서도 유지되는지
  assert(
    effective(undefined, { skip: [KEY], only: [KEY] }) === 'skip 목록',
    'probe 생략 경로에서도 skip 이 only 를 이긴다',
  );
}

// ── 시나리오 31: 의도 배치 안에서의 필터 판정 ──────────────

{
  // 리뷰 지적 [P2]: 캐시된 excludedReason 은 **직전 스캔** 값이라, 같은 배치에서
  // 앞서 적용된 skip/only 변경을 반영하지 못한다. 그래서 판정을 두 갈래로 나눈다.
  const KEY = 'lpaiu-cs/osk-system#12';

  // (1) 배치에서 방금 skip 에 들어갔다 → 캐시는 비어 있어도 막아야 한다
  assert(
    !passesRefFilters(KEY, { skip: [KEY] }).ok,
    '지금 설정 기준으로 skip 이면 캐시가 비어 있어도 막힌다',
  );
  // (2) 배치에서 방금 skip 에서 빠졌다 → 캐시가 'skip 목록' 이어도 통과해야 한다
  assert(passesRefFilters(KEY, { skip: [] }).ok, '지금 설정에서 빠졌으면 통과한다');
  assert(
    isRefFilterReason('skip 목록') && isRefFilterReason('only 목록 밖'),
    'skip/only 사유는 다시 계산 가능하므로 캐시를 무시해도 된다',
  );
  // (3) 반대로 draft/authors/labels 는 설정만으로 못 고치므로 캐시가 유효하다
  assert(!isRefFilterReason('초안(draft)'), 'draft 는 재계산 불가 — 캐시가 유효하다');
  assert(!isRefFilterReason('작성자 bot 는 대상 아님'), 'authors 도 재계산 불가');
  assert(!isRefFilterReason(undefined), '사유가 없으면 ref 사유가 아니다');

  // ── 대소문자 (2차 리뷰 [P2]) ──
  // ctxKey 는 원래 casing 을 보존하고 skip 목록은 소문자로 저장된다. 조회 키를
  // 정규화하지 않으면 대문자가 든 실제 레포에서 제외가 통째로 무시된다.
  const MIXED = 'lpaiu-cs/ImageToEditablePPT#6';
  assert(
    !passesRefFilters(MIXED, { skip: ['lpaiu-cs/imagetoeditableppt#6'] }).ok,
    'ctxKey 형태(대문자 포함)를 넘겨도 소문자 skip 항목과 매치된다',
  );
  assert(
    !passesRefFilters('lpaiu-cs/imagetoeditableppt#6', { skip: [MIXED] }).ok,
    '반대 방향도 (목록이 대문자, 키가 소문자)',
  );
  assert(
    !passesRefFilters(MIXED, { only: ['lpaiu-cs/other#1'] }).ok,
    'only 도 대소문자를 넘어 판정한다',
  );
  assert(passesRefFilters(MIXED, { only: ['LPAIU-CS/imagetoeditableppt#006'] }).ok,
    'only: 대소문자 + 선행 0 이 섞여도 같은 PR 로 본다');

  // only 도 같은 규칙
  assert(!passesRefFilters(KEY, { only: ['other/repo#1'] }).ok, 'only 목록 밖이면 막힌다');
  assert(passesRefFilters(KEY, { only: [KEY] }).ok, 'only 목록 안이면 통과');
  assert(passesRefFilters(KEY, {}).ok, '조건이 없으면 통과');

  // passesFilters 가 같은 함수를 지나는지 (판정이 갈라지면 안 된다)
  const pr = {
    owner: 'lpaiu-cs', repo: 'osk-system', number: 12,
    author: 'lpaiu-cs', isDraft: false, labels: [],
  };
  assert(
    passesFilters(pr, { skip: [KEY] }).reason === passesRefFilters(KEY, { skip: [KEY] }).reason,
    'passesFilters 와 passesRefFilters 가 같은 사유를 낸다',
  );
}

// ── 시나리오 30: 필터에 걸린 PR 은 강제 전이시켜도 못 돈다 ──

{
  // 리뷰 지적 [P2]: '지금 리뷰' 가 필터를 확인하지 않고 먼저 상태를 바꿨다.
  // 스캔이 excludedReason 붙은 컨텍스트를 eligible 에 넣지 않으므로 리뷰는
  // 실행되지 않는데, **영속 상태만 REVIEW_DUE 로 바뀌어 남는다.** 나중에
  // 제외를 풀면 작성자 응답도 새 커밋도 없이 리뷰가 돈다.
  const ctx = createContext(fakePR);
  fire(ctx, 'START_REVIEW');
  fire(ctx, 'POSTED_COMMENTS', { patch: { round: 1 } });
  ctx.excludedReason = 'skip 목록';
  assert(ctx.state === 'AWAITING_AUTHOR', '전제: 작성자 응답 대기 상태');

  // '지금 리뷰' 가 하던 강제 전이를 그대로 재현한다.
  fire(ctx, 'AUTHOR_RESPONDED', { note: 'UI: 지금 리뷰' }); // = FORCE_EVENTS.AWAITING_AUTHOR
  assert(ctx.state === 'REVIEW_DUE', '강제 전이 자체는 성립한다');
  assert(!isQueueable(ctx), '그런데 필터에 걸려 있어 큐에는 오르지 않는다 (= 무동작)');
  assert(
    buildQueue([ctx]).length === 0,
    '큐가 비어 있다 — 상태만 바뀌고 리뷰는 영영 실행되지 않는 갈라짐',
  );

  // 제외를 풀면 그 잔여 상태 때문에 응답 없이도 리뷰가 돈다 — 이게 진짜 피해다.
  delete ctx.excludedReason;
  assert(
    buildQueue([ctx]).length === 1,
    '제외 해제 시 강제 전이 잔여물이 그대로 큐에 오른다 (그래서 전이 전에 막아야 한다)',
  );
}

// ── 시나리오 28: 범위 변경 시 탐색 캐시 폐기 ───────────────

{
  // 리뷰 지적 [P1]: lastAt = 0 은 "다시 탐색하라" 일 뿐이다. 그 탐색이 부분
  // 실패하면 nextRepoCache 가 이전 캐시를 **의도적으로 보존**하므로 옛 범위의
  // 레포가 살아남고, scan 이 그걸 그대로 probe 해 리뷰를 게시할 수 있다.
  const stale = ['oldorg/a', 'oldorg/b'];
  const partialFail = { repos: [], partial: true, truncated: false, cost: 0 };
  assert(
    nextRepoCache(stale, partialFail).length === 2,
    '부분 실패는 이전 캐시를 보존한다 (일시 오류로 감시가 끊기면 안 되므로)',
  );

  // 그래서 범위를 바꿀 때는 freshness 가 아니라 캐시 자체를 버려야 한다.
  const src = createRepoSource({ mode: 'repos', include: ['oldorg/a'], exclude: [] });
  assert(src.list().includes('oldorg/a'), '탐색 결과가 캐시에 담긴다');
  src.targets = new Map([['oldorg/a', new Set([1])]]);

  src.reset();
  assert(src.lastAt === 0, 'reset 은 freshness 를 되돌린다');
  assert(src.targets === undefined, 'reset 은 targets 도 버린다 (여기가 lastAt=0 과 다른 지점)');
  assert(src.truncated === false, 'reset 은 truncated 도 되돌린다');
}

// ── 시나리오 29: 탐색이 펼칠 수 없는 패턴 ──────────────────

{
  // 리뷰 지적 [P2]: UI 가 저장을 받아주는데 백엔드가 조용히 버리면,
  // lingering 컨텍스트가 남아 있는 동안 그 실패가 가려진다.
  assert(
    unsupportedPatterns('repos', ['owner/repo', 'owner/*']).join() === 'owner/*',
    'repos 모드는 글롭을 펼칠 수 없다',
  );
  assert(
    unsupportedPatterns('repos', ['owner/repo']).length === 0,
    'repos 모드에서 리터럴은 통과',
  );
  assert(
    unsupportedPatterns('account', ['myorg/*', '*/service-*']).join() === '*/service-*',
    'account 모드는 소유자 자리 글롭만 불가 (검색이 org:<owner> 단위)',
  );
  assert(
    unsupportedPatterns('account', ['myorg/*', 'other/repo']).length === 0,
    'account 모드에서 소유자가 특정되면 통과',
  );
  assert(
    unsupportedPatterns('review-requested', ['*/*', 'anything']).length === 0,
    'review-requested 는 include 가 결과 필터일 뿐이라 제약이 없다',
  );

  // discoverRepos 와 같은 판정을 쓰는지 — 갈라지면 이 검증이 무의미해진다.
  const r = discoverRepos({ mode: 'repos', include: ['owner/repo', 'owner/*'], exclude: [] });
  assert(
    r.repos.join() === 'owner/repo',
    'discoverRepos 가 버리는 패턴 = unsupportedPatterns 가 지목하는 패턴',
  );
}

// ── 시나리오 26: 대시보드 로그 심각도 추론 ─────────────────

{
  // 로깅 API 를 새로 만드는 대신 이미 있는 두 신호를 읽는다: chalk 의 SGR 코드와
  // 출력문 마커. 색이 꺼진 환경(파이프)에서는 앞이 사라지므로 둘 다 성립해야 한다.
  const prevLevel = chalk.level;
  chalk.level = 3; // SGR 경로

  assert(inferLevel(chalk.red('  ✗ 리뷰 실패:')) === 'error', 'SGR: red → error');
  assert(inferLevel(chalk.yellow('  ⚠ 쿼터 한도')) === 'warn', 'SGR: yellow → warn');
  assert(inferLevel(chalk.green('  ✓ 응답 수신 완료')) === 'ok', 'SGR: green → ok');
  assert(inferLevel(chalk.dim('    …30초 경과')) === 'dim', 'SGR: dim → dim');
  assert(
    inferLevel(chalk.bold('  🔍 o/r#8') + chalk.dim(' [1차]')) === 'info',
    'SGR: 첫 코드만 본다 (bold → info)',
  );

  chalk.level = 0; // 색 없음 — 마커 폴백 경로
  assert(inferLevel(chalk.red('  ✗ 리뷰 실패:')) === 'error', '폴백: ✗ → error');
  assert(inferLevel(chalk.yellow('  ⚠ 쿼터 한도')) === 'warn', '폴백: ⚠ → warn');
  assert(inferLevel(chalk.green('  ✓ 응답 수신 완료')) === 'ok', '폴백: ✓ → ok');
  assert(inferLevel('평문 로그') === 'info', '단서가 없으면 info');

  chalk.level = prevLevel;
  assert(stripAnsi('\x1b[31m✗ 실패\x1b[39m') === '✗ 실패', 'ANSI 제거');
}

// ── 시나리오 27: 대시보드 버스 — 세션·게이트·라운드 수명 ───

{
  // enabled 가 꺼져 있으면 아무것도 기록하지 않는다 (--ui 없이 도는 게 기본이다).
  progress.enabled = false;
  progress.log('버려질 로그');
  progress.patch({ scope: '버려질 범위' });
  assert(progress.state().logs.length === 0, 'UI 가 꺼져 있으면 로그를 쌓지 않는다');
  assert(progress.state().snapshot.scope === '', 'UI 가 꺼져 있으면 스냅샷도 그대로');

  progress.enabled = true;
  const session = progress.state().snapshot.session;
  assert(!!session, '세션 id 가 있다');

  // 세션 id 는 호출자가 덮어쓸 수 없어야 한다. 이게 뚫리면 watch 재시작 판정이
  // 무너져서 클라이언트가 새 로그를 전부 "이미 본 것" 으로 버린다.
  progress.patch({ session: 'spoofed' } as never);
  assert(progress.state().snapshot.session === session, '세션 id 는 patch 로 못 바꾼다');

  progress.log(chalk.green('  ✓ 첫 줄'));
  progress.log('');
  progress.log('   \t  ');
  const logs = progress.state().logs;
  assert(logs.length === 1, '공백뿐인 줄은 UI 로그에 쌓지 않는다');
  assert(logs[0].seq === 1 && logs[0].level === 'ok', 'seq 는 1부터, 레벨은 추론값');

  // 라운드 수명: runReview 안에서 phase → stream, 끝나면 스스로 걷힌다
  const one = (k: string) => progress.state().snapshot.active.find((a) => a.key === k);
  await progress.runReview(
    { key: 'o/r#8', title: 't', url: 'u', round: 3, reasonLabel: '작성자 응답', dryRun: false },
    async () => {
      assert(one('o/r#8')?.phase === 'conversation', '시작 단계는 conversation');

      progress.phase('waiting');
      const waitingSince = one('o/r#8')!.phaseSince;
      progress.stream('생성 중', 1200);
      assert(one('o/r#8')?.stream?.chars === 1200, '스트리밍 관측값 기록');

      progress.phase('waiting'); // 같은 단계 재진입
      assert(one('o/r#8')!.phaseSince === waitingSince, '같은 단계면 경과 타이머를 되감지 않는다');
      assert(one('o/r#8')?.stream?.chars === 1200, '같은 단계면 관측값도 유지');

      progress.phase('parsing');
      assert(
        one('o/r#8')?.stream === undefined,
        '단계가 바뀌면 이전 스트리밍 값은 버린다 (다음 단계의 수치로 오해된다)',
      );
      assert(progress.currentReview() === 'o/r#8', '실행 문맥이 어느 라운드인지 안다');
    },
  );
  assert(progress.state().snapshot.active.length === 0, 'runReview 가 끝나면 표시도 걷힌다');

  // 동시 실행: 두 라운드의 기록이 서로를 덮어쓰지 않아야 한다.
  await Promise.all([
    progress.runReview(
      { key: 'o/r#1', title: 'a', url: 'u', round: 1, reasonLabel: '신규', dryRun: false },
      async () => {
        progress.phase('waiting');
        progress.stream('생성 중', 10);
        await new Promise((r) => setTimeout(r, 20));
        assert(one('o/r#1')?.stream?.chars === 10, '내 관측값은 내 라운드에만 남는다');
        assert(one('o/r#2')?.phase === 'posting', '다른 라운드는 자기 단계를 유지한다');
        progress.log('  섞여 기록되는 줄');
      },
    ),
    progress.runReview(
      { key: 'o/r#2', title: 'b', url: 'u', round: 1, reasonLabel: '신규', dryRun: false },
      async () => {
        progress.phase('posting');
        await new Promise((r) => setTimeout(r, 30));
      },
    ),
  ]);
  assert(progress.state().snapshot.active.length === 0, '둘 다 끝나면 남지 않는다');

  // 꼬리표 판정은 **기록하는 순간**에 값으로 굳어야 한다. 보는 쪽이 "지금 몇 개
  // 도는가" 로 판단하면, 배치가 끝난 뒤(지금이 그 시점이다) 링 버퍼를 다시
  // 흘려보낼 때 그때의 섞임이 없던 일이 된다.
  const mixed = progress.state().logs.find((l) => l.text.includes('섞여 기록되는 줄'));
  assert(mixed?.key === 'o/r#1', '동시에 돌 때 찍힌 줄은 어느 라운드인지 남긴다');

  await progress.runReview(
    { key: 'o/r#3', title: 'c', url: 'u', round: 1, reasonLabel: '신규', dryRun: false },
    async () => progress.log('  혼자 도는 줄'),
  );
  const alone = progress.state().logs.find((l) => l.text.includes('혼자 도는 줄'));
  assert(alone && alone.key === undefined, '혼자 돌 때는 꼬리표를 붙이지 않는다');

  // phase/stream 은 라운드 밖에서 조용히 무시돼야 한다 — 스캔 중 호출될 수 있다.
  progress.phase('posting');
  progress.stream('생성 중', 5);
  assert(progress.state().snapshot.active.length === 0, '진행 중 라운드가 없으면 단계 기록은 무시');
  assert(progress.currentReview() === null, '라운드 밖에서는 문맥이 비어 있다');

  progress.enabled = false;
}

// ── 시나리오 33: 단일 인스턴스 잠금 ────────────────────────

{
  // 잠금은 **루프백 포트**로 잡는다. 파일이 아니라 커널이 "정확히 하나" 를
  // 보장하고, 프로세스가 어떻게 죽든 커널이 회수하므로 잔여 상태 자체가 없다.
  const dir = mkdtempSync(path.join(tmpdir(), 'pr-review-lock-'));
  const other = mkdtempSync(path.join(tmpdir(), 'pr-review-lock2-'));

  const release = await acquireLock(dir, 'watch');
  assert(readLock(dir)?.pid === process.pid, '잠금을 잡으면 정보 파일에 주인이 적힌다');

  let blocked = false;
  try {
    await acquireLock(dir, 'review');
  } catch (e) {
    blocked = e instanceof LockHeldError;
  }
  assert(blocked, '같은 dataDir 은 LockHeldError');

  // dataDir 이 다르면 상태를 공유하지 않으므로 동시에 돌아도 된다.
  const r2 = await acquireLock(other, 'watch');
  assert(readLock(dir)?.port !== readLock(other)?.port, 'dataDir 이 다르면 다른 포트를 잡는다');
  r2();

  release();
  const again = await acquireLock(dir, 'watch');
  assert(!!again, '해제 후 다시 잡을 수 있다');
  again();
  again(); // 멱등

  // 정보 파일은 안내용일 뿐 잠금 판정에 쓰이지 않는다 — 남아 있어도 획득을 막지 않는다.
  // (파일 기반이었다면 이런 잔여물이 인수 경쟁을 만들었다)
  writeFileSync(
    path.join(dir, 'watch.lock.json'),
    JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString(), command: 'watch' }),
  );
  const stale = await acquireLock(dir, 'watch');
  assert(readLock(dir)?.pid === process.pid, '잔여 정보 파일은 획득을 막지 않는다');
  stale();

  // 포트 선정은 `lock.port` 가 없을 때 한 번만 걷는다. 시작 후보가 막혀 있으면
  // 다음 후보로 넘어간다 — 고정 포트였다면 45000 대역이 통째로 예약된 머신에서
  // 도구가 아예 안 뜬다 (실제로 그런 머신이 있었다).
  const fresh = mkdtempSync(path.join(tmpdir(), 'pr-review-lock3-'));
  const squatter = createServer((s) => s.end('nope'));
  await new Promise<void>((r) => squatter.listen(lockPort(fresh, 0), '127.0.0.1', r));
  const walked = await acquireLock(fresh, 'watch');
  assert(readLockPort(fresh) === lockPort(fresh, 1), '막힌 시작 후보는 건너뛰고 다음을 정한다');
  walked();
  await new Promise<void>((r) => squatter.close(() => r()));

  // 한 번 정해진 포트는 못 박힌다. 획득 경로가 매번 다시 걸으면 경쟁 중에
  // "해제되는 중" 을 "예약" 으로 오인해 옆 포트로 새고, 잠금이 N 개로 분열한다.
  const pinned = readLockPort(fresh);
  const again2 = await acquireLock(fresh, 'watch');
  assert(readLock(fresh)?.port === pinned, '정해진 포트는 다음 실행에서도 그대로다');
  again2();
  rmSync(fresh, { recursive: true, force: true });

  // 리뷰 지적 [P2]: `wx` 는 **생성**만 배타적이다. 진 쪽이 EEXIST 를 받고 읽었을 때
  // 파일이 아직 비어 있을 수 있는데, 거기서 자기 후보로 진행하면 둘이 서로 다른
  // 포트를 잡아 잠금이 분열한다. 빈 파일은 자기 후보로 대체하지 않고 거절해야 한다.
  const broken = mkdtempSync(path.join(tmpdir(), 'pr-review-lock4-'));
  writeFileSync(path.join(broken, 'lock.port'), '');
  let refused = false;
  try {
    await acquireLock(broken, 'watch');
  } catch (e) {
    refused = e instanceof LockPortBusyError;
  }
  assert(refused, '빈 lock.port 는 자기 후보로 대체하지 않고 거절한다');

  // 유효한 값이 있으면 후보 계산을 건너뛰고 **그 값**을 따른다 (승자 추종).
  const followed = lockPort(broken, 7);
  writeFileSync(path.join(broken, 'lock.port'), String(followed));
  const follower = await acquireLock(broken, 'watch');
  assert(readLock(broken)?.port === followed, '기록된 포트를 그대로 따른다');
  follower();
  rmSync(broken, { recursive: true, force: true });

  rmSync(dir, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
}

// ── 시나리오 39: 제어 의도 어휘 (스킬이 여럿이라 문이 좁아야 한다) ──
{
  const bad = (b: unknown): boolean => typeof parseIntent(b) === 'string';

  // 종료는 /api/intent 로 들어올 수 없다. 이게 뚫리면 한 세션이 다른 세션들의
  // 리뷰를 통째로 끊을 수 있다 — 스킬 클라이언트에 동사를 안 넣은 의미가 사라진다.
  assert(bad({ kind: 'stop' }), 'stop 은 /api/intent 로 받지 않는다');

  // 범위를 **넓히는** 문은 클라이언트에게 열어주지 않는다. 범위는 레포 단위라
  // PR 하나를 부탁하는 요청이 그 레포의 다른 열린 PR 까지 리뷰 대상으로 만든다.
  assert(bad({ kind: 'scope-add', include: ['a/b'] }), 'scope-add 는 받지 않는다');
  assert(bad({ kind: 'scope-remove', include: ['a/b'] }), 'scope-remove 는 받지 않는다');

  // 좁히는 쪽(PR 단위 skip)과 사람이 쓰는 scope-set 은 그대로 열려 있다.
  const skip = parseIntent({ kind: 'skip-add', ref: 'o/r#1' });
  assert(typeof skip !== 'string' && skip.kind === 'skip-add', 'skip-add 는 받는다');
  const set = parseIntent({ kind: 'scope-set', include: ['a/*'], exclude: [] });
  assert(typeof set !== 'string' && set.kind === 'scope-set', 'scope-set 은 받는다');

  // review-now 의 조건부 적용 토큰. 대시보드(사람)는 안 보내므로 선택이다.
  const bare = parseIntent({ kind: 'review-now', ref: 'o/r#1' });
  assert(
    typeof bare !== 'string' && bare.kind === 'review-now' && bare.seq === undefined,
    'review-now 는 seq 없이도 받는다 (대시보드 버튼)',
  );
  const cond = parseIntent({ kind: 'review-now', ref: 'o/r#1', seq: 4 });
  assert(typeof cond !== 'string' && cond.kind === 'review-now' && cond.seq === 4, 'seq 를 실어 보낼 수 있다');
  assert(bad({ kind: 'review-now', ref: 'o/r#1', seq: -1 }), '음수 seq 는 거부한다');
  assert(bad({ kind: 'review-now', ref: 'o/r#1', seq: 'x' }), '숫자가 아닌 seq 는 거부한다');
}

// ── 시나리오 41: 신선도 토큰 (라운드로는 못 재는 것) ───────
{
  // `wait` 는 "내 요청 이후에 결과가 나왔나" 를 판정해야 한다. 그 기준이
  // 전이 횟수(history 길이)인 이유가 이 시나리오다 — 라운드로 재면 실패·쿼터·
  // 닫힘을 전부 "예전 것" 으로 버리고 타임아웃까지 기다린다.
  const ctx = createContext(fakePR);
  const seq = (): number => ctx.history.length;

  const atRequest = seq();
  fire(ctx, 'START_REVIEW');
  fire(ctx, 'REVIEW_FAILED', { note: '파싱 실패' });
  assert(ctx.state === 'ERROR', '실패는 ERROR 로 전이한다');
  assert(ctx.round === 0, '실패는 라운드를 올리지 않는다');
  assert(seq() > atRequest, '그래도 전이 횟수는 늘어난다 (판정 가능)');

  fire(ctx, 'RETRY');
  const beforeQuota = seq();
  const roundBeforeQuota = ctx.round;
  fire(ctx, 'START_REVIEW');
  fire(ctx, 'QUOTA_EXCEEDED');
  assert(ctx.state === 'QUOTA_BLOCKED', '쿼터 한도는 QUOTA_BLOCKED');
  assert(ctx.round === roundBeforeQuota, '쿼터도 라운드를 올리지 않는다');
  assert(seq() > beforeQuota, '쿼터도 전이 횟수로는 잡힌다');

  const beforeClose = seq();
  const roundBeforeClose = ctx.round;
  fire(ctx, 'PR_CLOSED');
  assert(ctx.state === 'CLOSED', 'PR_CLOSED → CLOSED');
  assert(ctx.round === roundBeforeClose, '닫힘도 라운드를 올리지 않는다');
  assert(seq() > beforeClose, '닫힘도 전이 횟수로는 잡힌다');
}

// ── 시나리오 40: 데몬 안내 파일 ────────────────────────────
{
  const dir = mkdtempSync(path.join(tmpdir(), 'pr-daemon-'));
  assert(readDaemonFile(dir) === null, '없으면 null (포트 폴백으로 넘어간다)');

  const info = {
    ui: 'http://127.0.0.1:4480',
    pid: process.pid,
    root: dir,
    startedAt: new Date().toISOString(),
    mode: 'review' as const,
  };
  publishDaemonFile(dir, info);
  assert(readDaemonFile(dir)?.ui === info.ui, '기록한 주소를 그대로 읽는다');

  // 남의 파일은 지우지 않는다 — 내가 죽는 사이 다음 주인이 덮어썼을 수 있고,
  // 그걸 지우면 살아 있는 데몬이 안내 파일 없이 남는다.
  publishDaemonFile(dir, { ...info, pid: process.pid + 1 });
  clearDaemonFile(dir);
  assert(readDaemonFile(dir) !== null, '남의 안내 파일은 지우지 않는다');

  publishDaemonFile(dir, info);
  clearDaemonFile(dir);
  assert(readDaemonFile(dir) === null, '내가 쓴 것은 지운다');

  // 설치본 식별자 — 포트만 보고 남의 데몬에 붙는 걸 막는 근거다.
  const other = mkdtempSync(path.join(tmpdir(), 'pr-daemon2-'));
  assert(instanceId(dir) === instanceId(dir), 'instance 는 같은 dataDir 에서 안정적이다');
  assert(instanceId(dir) !== instanceId(other), 'dataDir 이 다르면 instance 도 다르다');
  assert(
    instanceId(dir) === instanceId(path.join(dir, 'x', '..')),
    'instance 는 경로를 해석한 뒤 계산한다',
  );

  // scripts/daemon.mjs 는 의존성 없이 돌아야 해서 같은 계산을 JS 로 복제한다.
  // 갈라지면 클라이언트가 자기 데몬을 영영 못 알아본다 — 여기서 붙잡는다.
  const jsSide = createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 16);
  assert(jsSide === instanceId(dir), 'daemon.mjs 의 instance 계산과 일치한다');

  rmSync(dir, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
}

// ── 결과 ────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
