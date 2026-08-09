/**
 * 상태 머신 스모크 테스트 — `npm run smoke`
 *
 * 대표 시나리오의 전이 경로와 불법 전이 차단을 검증한다.
 */

import { fire, canFire, IllegalTransitionError, toMermaid } from '../src/state/machine.js';
import { createContext } from '../src/state/store.js';
import { parseGPTResponse, isAccessFailure } from '../src/parser.js';
import { resolveEvent } from '../src/poster.js';
import { ghErrorMessage, THREAD_ALIAS_CHUNK, type PRProbe } from '../src/github.js';
import {
  syncPRFromProbe,
  adoptThreads,
  applySyncEvents,
  planConversation,
  releaseConversation,
  reconcileCachedOrigin,
  countTurn,
  buildPreviousBlock,
} from '../src/reviewer.js';
import { parseConversationUrl } from '../src/chatgpt.js';
import { loadConfig } from '../src/config.js';
import {
  admitsNewPR,
  globToRegExp,
  matchesScope,
  nextRepoCache,
  passesFilters,
  resolveWatchScope,
} from '../src/watch-scope.js';
import {
  buildQueue,
  isQueueable,
  quotaGateUntil,
  TIER_AUTHOR_RESPONDED,
  TIER_FIRST_ROUND,
  TIER_OTHER,
} from '../src/queue.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
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
  releaseConversation(tracked);
  assert(
    tracked.conversationUrl === undefined &&
      tracked.conversationStartRound === undefined &&
      tracked.conversationTurns === undefined,
    'releaseConversation 이 대화 참조를 지운다',
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
  const pr = (over: Partial<{ author: string; isDraft: boolean; labels: string[] }> = {}) => ({
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

// ── 결과 ────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
