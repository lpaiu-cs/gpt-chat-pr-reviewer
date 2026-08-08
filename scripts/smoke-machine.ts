/**
 * 상태 머신 스모크 테스트 — `npm run smoke`
 *
 * 대표 시나리오의 전이 경로와 불법 전이 차단을 검증한다.
 */

import { fire, canFire, IllegalTransitionError, toMermaid } from '../src/state/machine.js';
import { createContext } from '../src/state/store.js';
import { parseGPTResponse, isAccessFailure } from '../src/parser.js';
import { resolveEvent } from '../src/poster.js';
import { ghErrorMessage } from '../src/github.js';
import type { PRInfo, PRState } from '../src/types.js';

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

// ── 결과 ────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
