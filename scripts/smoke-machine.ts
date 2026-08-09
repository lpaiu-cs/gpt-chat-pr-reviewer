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
import { syncPRFromProbe, adoptThreads } from '../src/reviewer.js';
import { loadConfig } from '../src/config.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PRInfo, PRState, PRContext, AppConfig } from '../src/types.js';

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

// ── 결과 ────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
