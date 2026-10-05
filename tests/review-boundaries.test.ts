import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createContext, saveContext, loadContext, listContexts } from '../src/state/store.js';
import { runRound, syncPR, applySyncEvents } from '../src/reviewer.js';
import { parseGPTResponse } from '../src/parser.js';
import type { AppConfig, PRContext } from '../src/types.js';
import type { ChatGPTDriver, PromptAttachment } from '../src/chatgpt.js';
import { findRoundBaseline, GenerationEndedError, ResponseTimeoutError } from '../src/chatgpt.js';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const diff = 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n';
const pr = { owner: 'o', repo: 'r', number: 1, url: 'https://github.com/o/r/pull/1', title: 'fixture', author: 'author', baseBranch: 'main', headBranch: 'topic', headSha: head };

async function fixture(fn: (f: {
  cfg: AppConfig; ctx: PRContext; driver: ChatGPTDriver; posts: any[];
  controls: { failSync: boolean; losePostResponse: boolean; wrongTarget: boolean; rejectPost: boolean; diff: string; prompts: string[]; attachments: (PromptAttachment | undefined)[] };
}) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'review-boundary-'));
  const cfg = { ...loadConfig(path.join(dir, 'absent.json')), dataDir: dir, customInstructionsFile: path.join(dir, 'instructions.md') };
  const ctx = createContext(pr);
  const posts: any[] = [];
  const controls = { failSync: false, losePostResponse: false, wrongTarget: false, rejectPost: false, diff, prompts: [] as string[], attachments: [] as (PromptAttachment | undefined)[] };
  const original = cp.execFile;
  const respond = (file: string, args: string[], opts: any) => {
    assert.equal(file, 'gh');
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ number: 1, url: pr.url, title: pr.title, author: { login: 'author' }, baseRefName: 'main', headRefName: 'topic', headRefOid: head });
    if (args[1] === 'user') return 'bot';
    if (args[1]?.includes('/reactions')) return '[]';
    if (args[1]?.includes('/compare/')) return args.includes('-q') ? base : controls.diff;
    if (args[1]?.includes('/reviews?')) return JSON.stringify([posts]);
    if (args[1]?.endsWith('/reviews')) {
      if (controls.rejectPost) throw Object.assign(new Error('Validation Failed'), {
        stdout: JSON.stringify({ status: '422', message: 'Validation Failed', errors: ['body is too long'] }),
        stderr: 'gh: Validation Failed (HTTP 422)',
      });
      const payload = JSON.parse(opts.input);
      const posted = { ...payload, id: posts.length + 1, state: payload.event };
      posts.push(posted);
      if (controls.losePostResponse) { controls.losePostResponse = false; throw new Error('response lost'); }
      return JSON.stringify(posted);
    }
    if (args[1] === 'graphql') {
      if (controls.failSync) throw new Error('sync unavailable');
      return JSON.stringify({ data: { repository: { pullRequest: {
        state: 'OPEN', headRefOid: head, baseRefName: 'main', reviewThreads: {
          pageInfo: { hasNextPage: false, endCursor: null }, nodes: posts.flatMap(p => (p.comments ?? []).map((c: any, i: number) => ({
            id: `T${p.id}-${i}`, path: c.path, line: c.line, isResolved: true,
            comments: { nodes: [{ author: { login: 'bot' }, body: c.body, pullRequestReview: { databaseId: p.id } }], pageInfo: { hasNextPage: false } },
          }))),
        },
      } } } });
    }
    throw new Error(`Unmocked external command blocked: ${args.join(' ')}`);
  };
  cp.execFile = ((file: string, args: string[], opts: any, callback: any) => ({
    stdin: { on() {}, end(input: string) { setImmediate(() => {
      try { callback(null, respond(file, args, { ...opts, input }), ''); }
      catch (error) { callback(error, (error as any).stdout ?? '', (error as any).stderr ?? ''); }
    }); } },
  })) as any;
  syncBuiltinESMExports();
  const driver = {
    ensureAlive: async () => false, startNewChat: async () => {}, withTurn: (fn: () => Promise<unknown>) => fn(),
    sendAndCollect: async (prompt: string, onSent: (url: string, reasoning: string) => void, attachment?: PromptAttachment) => {
      controls.prompts.push(prompt);
      controls.attachments.push(attachment);
      onSent('https://chatgpt.com/c/fixture', 'Latest · Pro (5/5)');
      return JSON.stringify({ summary: 'issue', approval: 'request_changes',
        reviewedHeadSha: controls.wrongTarget ? 'c'.repeat(40) : head, reviewedBaseSha: base,
        comments: [{ path: 'x.ts', line: 1, body: 'fix this' }] });
    },
  } as unknown as ChatGPTDriver;
  try { await fn({ cfg, ctx, driver, posts, controls }); }
  finally { cp.execFile = original; syncBuiltinESMExports(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('고정 diff를 실제 전송하고 같은 head에만 게시한다', async () => await fixture(async f => {
  assert.equal(await runRound(f.cfg, f.driver, f.ctx), 'posted');
  assert(f.controls.prompts[0].includes(diff));
  assert(f.controls.prompts[0].includes(head));
  assert(f.controls.prompts[0].includes(base));
  assert.equal(f.posts[0].commit_id, head);
  assert.match(f.posts[0].body, /추론 모델: Latest · Pro \(5\/5\)/);
  assert.equal(f.controls.attachments[0], undefined);
}));

test('재시도 소진 후 25분 타임아웃도 재시작/완료 판정 가능한 회수 확인을 거쳐 재전송 없이 한 번 게시한다', async () => fixture(async f => {
  f.cfg.responseTimeoutMs = 25 * 60_000;
  f.ctx.retryCount = f.cfg.maxAutoRetries;
  const send = f.driver.sendAndCollect.bind(f.driver);
  let answer = '';
  f.driver.sendAndCollect = async (...args) => {
    answer = await send(...args);
    throw new ResponseTimeoutError('25분 동안 응답을 받지 못했습니다.');
  };
  assert.equal(await runRound(f.cfg, f.driver, f.ctx), 'failed');
  assert(f.ctx.pendingSend?.recoverAfter);
  let ctx = loadContext(f.cfg, 'o', 'r', 1)!;
  const snapshot = { status: 'OPEN' as const, headSha: head, baseRef: 'main' };
  applySyncEvents(f.cfg, ctx, snapshot);
  assert.equal(ctx.state, 'ERROR', '1분 간격 전에 일반 재시도로 우회하면 안 된다');
  assert.equal(ctx.retryCount, f.cfg.maxAutoRetries);
  f.driver.resumeChat = async () => true;
  f.driver.findRound = async () => 2;
  let checks = 0;
  f.driver.collectFrom = async (baseline, timeoutMs) => {
    assert.equal(baseline, 2);
    assert.equal(timeoutMs, 150_000, '중지 버튼 고장 판정의 120초 관측 시간을 확보한다');
    if (++checks === 1) throw new ResponseTimeoutError('아직 생성 중');
    return answer;
  };
  for (const expected of ['failed', 'posted']) {
    ctx.pendingSend!.recoverAfter = new Date(Date.now() - 1).toISOString();
    applySyncEvents(f.cfg, ctx, snapshot);
    assert.equal(ctx.state, 'REVIEW_DUE');
    assert.equal(ctx.retryCount, f.cfg.maxAutoRetries);
    assert.equal(await runRound(f.cfg, f.driver, ctx), expected);
    ctx = loadContext(f.cfg, 'o', 'r', 1)!;
  }
  assert.equal(f.controls.prompts.length, 1);
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].commit_id, head);
  assert.match(f.posts[0].body, /추론 모델: Latest · Pro \(5\/5\)/, '회수한 답도 전송 때의 추론 설정을 표기한다');
  assert.equal(ctx.round, 1);
  assert.equal(ctx.pendingSend, undefined);
  assert.equal(ctx.lastError, undefined);
}));

test('사용자 템플릿에 라운드 마커가 없어도 실제 전송한 식별자로 회수한다', async () => fixture(async f => {
  f.cfg.promptTemplate = 'PR {{url}} {{instructions}}\n리뷰를 진행하세요.';
  f.ctx.retryCount = f.cfg.maxAutoRetries;
  const send = f.driver.sendAndCollect.bind(f.driver);
  let answer = '';
  f.driver.sendAndCollect = async (...args) => {
    answer = await send(...args);
    throw new ResponseTimeoutError('25분 동안 응답을 받지 못했습니다.');
  };
  assert.equal(await runRound(f.cfg, f.driver, f.ctx), 'failed');
  const marker = f.ctx.pendingSend?.marker;
  assert(marker && f.controls.prompts[0].includes(marker));
  f.cfg.promptTemplate = '템플릿이 전송 이후 바뀌었습니다.';
  f.ctx.pendingSend!.recoverAfter = new Date(Date.now() - 1).toISOString();
  applySyncEvents(f.cfg, f.ctx, { status: 'OPEN', headSha: head, baseRef: 'main' });
  f.driver.resumeChat = async () => true;
  f.driver.findRound = async found => { assert.equal(found, marker); return 0; };
  f.driver.collectFrom = async () => answer;
  assert.equal(await runRound(f.cfg, f.driver, f.ctx), 'posted');
  assert.equal(f.controls.prompts.length, 1);
  assert.equal(f.posts.length, 1);
}));

test('답 없는 종료 뒤 자연어로 이어받은 리뷰는 재시작 후에도 재전송 없이 원래 대상에 게시한다', async () => fixture(async f => {
  const send = f.driver.sendAndCollect.bind(f.driver);
  let answer = '';
  f.driver.sendAndCollect = async (...args) => {
    answer = await send(...args);
    throw new GenerationEndedError('생성이 답 없이 끝났습니다');
  };
  assert.equal(await runRound(f.cfg, f.driver, f.ctx), 'failed');
  const ctx = loadContext(f.cfg, 'o', 'r', 1)!;
  assert.equal(ctx.pendingSend?.ended, true);
  assert.equal(ctx.pendingSend?.recoverAfter, undefined, '무기한 회수로 승격하지 않는다');
  applySyncEvents(f.cfg, ctx, { status: 'OPEN', headSha: head, baseRef: 'main' });
  assert.equal(ctx.retryCount, 1, '일반 재시도 예산을 소비한다');
  f.driver.resumeChat = async () => true;
  f.driver.findRound = async (marker, requireResponse, acceptFollowup) => {
    assert.equal(requireResponse, true);
    assert.equal(typeof acceptFollowup, 'function');
    return findRoundBaseline([
      { role: 'user', text: f.controls.prompts[0] },
      { role: 'assistant', text: '' },
      { role: 'user', text: '중단된 리뷰를 이어서 마무리해줘' },
      { role: 'assistant', text: answer },
    ], marker, requireResponse, acceptFollowup);
  };
  f.driver.collectFrom = async baseline => { assert.equal(baseline, 1); return answer; };
  assert.equal(await runRound(f.cfg, f.driver, ctx), 'posted');
  assert.equal(f.controls.prompts.length, 1);
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].commit_id, head);
  assert.equal(ctx.pendingSend, undefined);
}));

test('후속 답의 형식·대상이 틀리거나 ACCESS_FAILED이면 회수하지 않고 새로 묻는다', async () => {
  const review = { summary: 'ok', approval: 'approve', comments: [], reviewedHeadSha: head, reviewedBaseSha: base };
  for (const raw of [
    '일반 대화 답변', '{"summary":',
    JSON.stringify({ ...review, comments: [{ path: 'x.ts', line: 0, body: 'bad' }] }),
    JSON.stringify({ ...review, reviewedHeadSha: 'c'.repeat(40) }),
    JSON.stringify({ ...review, reviewedBaseSha: 'c'.repeat(40) }),
    JSON.stringify({ summary: 'ok', approval: 'approve', comments: [] }),
    JSON.stringify({ ...review, summary: 'ACCESS_FAILED: 첨부 — 읽기 실패' }),
  ]) await fixture(async f => {
    const send = f.driver.sendAndCollect.bind(f.driver);
    f.driver.sendAndCollect = async (...args) => {
      const answer = await send(...args);
      if (f.controls.prompts.length === 1) throw new GenerationEndedError('생성이 답 없이 끝났습니다');
      return answer;
    };
    assert.equal(await runRound(f.cfg, f.driver, f.ctx), 'failed');
    applySyncEvents(f.cfg, f.ctx, { status: 'OPEN', headSha: head, baseRef: 'main' });
    f.driver.resumeChat = async () => true;
    f.driver.findRound = async (marker, requireResponse, acceptFollowup) => findRoundBaseline([
      { role: 'user', text: f.controls.prompts[0] },
      { role: 'assistant', text: '' },
      { role: 'user', text: '계속해줘' },
      { role: 'assistant', text: raw },
    ], marker, requireResponse, acceptFollowup);
    f.driver.collectFrom = async () => { assert.fail('검증되지 않은 후속 답을 회수하면 안 된다'); };
    assert.equal(await runRound(f.cfg, f.driver, f.ctx), 'posted');
    assert.equal(f.controls.prompts.length, 2);
    assert.equal(f.posts.length, 1);
    assert.equal(f.posts[0].commit_id, head);
    assert.equal(f.posts[0].event, 'REQUEST_CHANGES', '후속 답의 approve가 게시되면 안 된다');
  });
});

test('답 없는 종료 뒤에도 빈 자리만 남으면 새 질문을 보내고 재시도 상한에서 멈춘다', async () => fixture(async f => {
  const send = f.driver.sendAndCollect.bind(f.driver);
  f.driver.sendAndCollect = async (...args) => {
    await send(...args);
    throw new GenerationEndedError('생성이 답 없이 끝났습니다');
  };
  f.driver.resumeChat = async () => true;
  f.driver.findRound = async (marker, requireResponse) => findRoundBaseline([
    { role: 'user', text: f.controls.prompts.at(-1)! },
  ], marker, requireResponse);
  f.driver.collectFrom = async () => { assert.fail('끝난 빈 자리를 다시 기다리면 안 된다'); };
  const snapshot = { status: 'OPEN' as const, headSha: head, baseRef: 'main' };
  assert.equal(await runRound(f.cfg, f.driver, f.ctx), 'failed');
  for (let i = 0; i < f.cfg.maxAutoRetries; i++) {
    applySyncEvents(f.cfg, f.ctx, snapshot);
    assert.equal(f.ctx.state, 'REVIEW_DUE');
    assert.equal(await runRound(f.cfg, f.driver, f.ctx), 'failed');
  }
  applySyncEvents(f.cfg, f.ctx, snapshot);
  assert.equal(f.ctx.state, 'ERROR');
  assert.equal(f.controls.prompts.length, f.cfg.maxAutoRetries + 1);
  assert.equal(f.ctx.pendingSend?.recoverAfter, undefined);
  assert.equal(f.posts.length, 0);
}));

test('타임아웃 회수 중 답 없는 종료가 확인되면 무기한 회수를 해제한다', async () => fixture(async f => {
  const send = f.driver.sendAndCollect.bind(f.driver);
  f.driver.sendAndCollect = async (...args) => {
    await send(...args);
    throw new ResponseTimeoutError('아직 응답 없음');
  };
  assert.equal(await runRound(f.cfg, f.driver, f.ctx), 'failed');
  assert(f.ctx.pendingSend?.recoverAfter);
  f.ctx.pendingSend.recoverAfter = new Date(Date.now() - 1).toISOString();
  const snapshot = { status: 'OPEN' as const, headSha: head, baseRef: 'main' };
  applySyncEvents(f.cfg, f.ctx, snapshot);
  f.driver.resumeChat = async () => true;
  f.driver.findRound = async () => 0;
  f.driver.collectFrom = async () => { throw new GenerationEndedError('생성이 답 없이 끝났습니다'); };
  assert.equal(await runRound(f.cfg, f.driver, f.ctx), 'failed');
  assert.equal(f.ctx.pendingSend?.ended, true);
  assert.equal(f.ctx.pendingSend?.recoverAfter, undefined);
  applySyncEvents(f.cfg, f.ctx, snapshot);
  assert.equal(f.ctx.retryCount, 1);
  assert.equal(f.controls.prompts.length, 1);
}));

test('식별자 없는 구버전 사용자 템플릿 타임아웃은 무한 회수로 예약하지 않는다', async () => fixture(async f => {
  f.cfg.promptTemplate = 'PR {{url}} {{instructions}}';
  f.ctx.state = 'ERROR';
  f.ctx.retryCount = f.cfg.maxAutoRetries;
  f.ctx.lastError = '타임아웃 — 25분 동안 응답을 받지 못했습니다.';
  f.ctx.conversationUrl = 'https://chatgpt.com/c/fixture';
  f.ctx.pendingSend = { round: 1, headSha: head, baseRef: 'main', mergeBaseSha: base, at: new Date().toISOString() };
  applySyncEvents(f.cfg, f.ctx, { status: 'OPEN', headSha: head, baseRef: 'main' });
  assert.equal(f.ctx.state, 'ERROR');
  assert.equal(f.ctx.pendingSend.recoverAfter, undefined);
  f.ctx.pendingSend.recoverAfter = new Date(Date.now() - 1).toISOString();
  applySyncEvents(f.cfg, f.ctx, { status: 'OPEN', headSha: head, baseRef: 'main' });
  assert.equal(f.ctx.state, 'ERROR');
  assert.equal(f.ctx.pendingSend.recoverAfter, undefined);
}));

test('구버전 타임아웃과 복귀/마커/브라우저 오류는 새 질문 없이 회수를 예약한다', async () => fixture(async f => {
  f.ctx.state = 'ERROR';
  f.ctx.retryCount = f.cfg.maxAutoRetries;
  f.ctx.lastError = '타임아웃 — 25분 동안 응답을 받지 못했습니다.';
  f.ctx.conversationUrl = 'https://chatgpt.com/c/fixture';
  f.ctx.pendingSend = { round: 1, headSha: head, baseRef: 'main', mergeBaseSha: base, at: new Date().toISOString() };
  const snapshot = { status: 'OPEN' as const, headSha: head, baseRef: 'main' };
  for (const failure of ['resume', 'marker', 'browser']) {
    if (f.ctx.pendingSend?.recoverAfter) f.ctx.pendingSend.recoverAfter = new Date(Date.now() - 1).toISOString();
    applySyncEvents(f.cfg, f.ctx, snapshot);
    assert.equal(f.ctx.state, 'REVIEW_DUE');
    f.driver.resumeChat = async () => failure !== 'resume';
    f.driver.findRound = async () => null;
    f.driver.ensureAlive = async () => { if (failure === 'browser') throw new Error('browser unavailable'); return false; };
    assert.equal(await runRound(f.cfg, f.driver, f.ctx), 'failed');
    assert(f.ctx.pendingSend?.recoverAfter);
    assert.equal(f.ctx.retryCount, f.cfg.maxAutoRetries);
    assert.equal(f.controls.prompts.length, 0);
    assert.equal(f.posts.length, 0);
  }
}));

test('회수 대상이 변경되거나 완성 답의 SHA가 틀리면 게시하지 않는다', async () => fixture(async f => {
  for (const kind of ['head', 'base', 'answer']) {
    const ctx = createContext(pr);
    ctx.conversationUrl = 'https://chatgpt.com/c/fixture';
    ctx.pendingSend = { round: 1, headSha: kind === 'head' ? 'd'.repeat(40) : head,
      baseRef: kind === 'base' ? 'release' : 'main', mergeBaseSha: base,
      at: new Date().toISOString(), recoverAfter: new Date().toISOString() };
    f.driver.resumeChat = async () => true;
    f.driver.findRound = async () => 0;
    f.driver.collectFrom = async () => JSON.stringify({ summary: 'clean', approval: 'approve', comments: [],
      reviewedHeadSha: 'e'.repeat(40), reviewedBaseSha: base });
    assert.equal(await runRound(f.cfg, f.driver, ctx), 'failed');
    assert.equal(ctx.pendingSend?.recoverAfter, undefined);
    assert.equal(f.controls.prompts.length, 0);
    assert.equal(f.posts.length, 0);
  }
}));

test('전송 기록 없는 타임아웃/파싱 실패는 기존 재시도 한도를 따르고 닫힌 PR의 회수는 해제한다', async () => fixture(async f => {
  for (const message of ['타임아웃 — 응답 없음', 'GPT 가 PR 에 접근하지 못했습니다']) {
    f.ctx.state = 'ERROR';
    f.ctx.retryCount = f.cfg.maxAutoRetries;
    f.ctx.lastError = message;
    applySyncEvents(f.cfg, f.ctx, { status: 'OPEN', headSha: head, baseRef: 'main' });
    assert.equal(f.ctx.state, 'ERROR');
  }
  f.ctx.pendingSend = { round: 1, headSha: head, baseRef: 'main', mergeBaseSha: base,
    at: new Date().toISOString(), recoverAfter: new Date().toISOString() };
  f.ctx.conversationUrl = 'https://chatgpt.com/c/fixture';
  applySyncEvents(f.cfg, f.ctx, { status: 'CLOSED', headSha: head, baseRef: 'main' });
  assert.equal(f.ctx.pendingSend, undefined);
  assert.equal(f.ctx.state, 'CLOSED');
}));

test('큰 고정 diff는 잘리지 않은 UTF-8 첨부로 전송하고 대상 SHA를 유지한다', async () => fixture(async f => {
  f.controls.diff = diff + '+한글 evidence\n'.repeat(100_000);
  assert.equal(await runRound(f.cfg, f.driver, f.ctx), 'posted');
  const file = f.controls.attachments[0]!;
  assert(file.name.length < 64, '파일 이름은 짧게, 전체 대상 SHA는 프롬프트에 보존한다');
  assert.equal(file.buffer.toString('utf8'), f.controls.diff);
  const prompt = f.controls.prompts[0];
  assert(prompt.includes(file.name));
  assert(prompt.includes(head) && prompt.includes(base));
  assert(prompt.includes('리뷰 라운드: 1차'));
  assert(prompt.length < 10_000);
  assert.equal(f.posts[0].commit_id, head);
}));

test('다른 대상을 확인한 응답은 게시하지 않는다', async () => await fixture(async f => {
  f.controls.wrongTarget = true;
  assert.equal(await runRound(f.cfg, f.driver, f.ctx), 'failed');
  assert.equal(f.posts.length, 0);
}));

test('게시 후 조회 실패를 나중에 복구하고 이미 해결된 새 스레드도 인정한다', async () => await fixture(async f => {
  f.controls.failSync = true;
  assert.equal(await runRound(f.cfg, f.driver, f.ctx), 'posted');
  assert.equal(f.ctx.awaitedReview?.id, 1);
  f.controls.failSync = false;
  await syncPR(f.cfg, f.ctx);
  assert.deepEqual(f.ctx.awaitedThreadIds, ['T1-0']);
  assert.equal(f.ctx.awaitedReview, undefined);
  assert.equal(f.ctx.state, 'REVIEW_DUE');
}));

test('서버 저장 후 응답 유실: 재시작해도 새 질문과 중복 POST 없이 회수한다', async () => await fixture(async f => {
  f.controls.losePostResponse = true;
  assert.equal(await runRound(f.cfg, f.driver, f.ctx), 'failed');
  assert.equal(f.posts.length, 1);
  const restored = loadContext(f.cfg, 'o', 'r', 1)!;
  applySyncEvents(f.cfg, restored, { status: 'OPEN', headSha: head, baseRef: 'main' });
  assert.equal(await runRound(f.cfg, null, restored), 'posted');
  assert.equal(f.posts.length, 1);
  assert.equal(f.controls.prompts.length, 1);
  assert.equal(restored.pendingReview, undefined);
  assert.equal(restored.requestedCount, 1);
}));

test('확정된 POST 검증 거부는 저장된 payload를 버리고 새 응답으로 복구한다', async () => fixture(async f => {
  f.controls.rejectPost = true;
  assert.equal(await runRound(f.cfg, f.driver, f.ctx), 'failed');
  const restored = loadContext(f.cfg, 'o', 'r', 1)!;
  assert.equal(restored.pendingReview, undefined);
  assert.equal(f.posts.length, 0);
  f.controls.rejectPost = false;
  applySyncEvents(f.cfg, restored, { status: 'OPEN', headSha: head, baseRef: 'main' });
  // 이전 대화 복귀는 이 검증의 대상이 아니다.
  delete restored.conversationUrl;
  assert.equal(await runRound(f.cfg, f.driver, restored), 'posted');
  assert.equal(f.controls.prompts.length, 2);
  assert.equal(f.posts.length, 1);
}));

test('같은 대상을 다시 보내도 첨부 이름은 매번 다르다 (ChatGPT 가 중복 이름을 "(n)" 으로 바꾼다)', async () => fixture(async f => {
  f.controls.diff = diff + '+big\n'.repeat(30_000);
  f.controls.rejectPost = true;
  assert.equal(await runRound(f.cfg, f.driver, f.ctx), 'failed');
  f.controls.rejectPost = false;
  const restored = loadContext(f.cfg, 'o', 'r', 1)!;
  applySyncEvents(f.cfg, restored, { status: 'OPEN', headSha: head, baseRef: 'main' });
  delete restored.conversationUrl;
  assert.equal(await runRound(f.cfg, f.driver, restored), 'posted');
  const [first, second] = f.controls.attachments;
  assert(first && second);
  assert.notEqual(first.name, second.name);
  assert(f.controls.prompts[1].includes(second.name), '프롬프트는 실제 첨부 이름을 가리킨다');
}));

test('첨부 인용 표식이 JSON 문자열에 섞여도 파싱하고 본문에서 걷어낸다 (platelog#4)', () => {
  const raw = 'JSON\n{\n  "summary": "요약",\n  "approval": "request_changes",\n  "comments": [{ "path": "a.kt", "line": 37, ' +
    '"body": "수정해 주세요. :chatgpt-content-reference{index="0"} :chatgpt-content-reference{index="1"} " }],\n' +
    '  "reviewedHeadSha": "h", "reviewedBaseSha": "b"\n}';
  const r = parseGPTResponse(raw);
  assert.equal(r.parsed, true);
  assert.equal(r.comments[0].body.trim(), '수정해 주세요.');
  assert.equal(r.raw, raw, '원본은 그대로 남긴다');
});

test('정상 JSON 이 인용 표식을 코드 예제로 언급하면 그대로 보존한다 (#47 리뷰)', () => {
  for (const mention of ['`:chatgpt-content-reference{` 접두사를 보세요', '예: `:chatgpt-content-reference{index="0"}`']) {
    const review = { summary: '요약', approval: 'comment', comments: [{ path: 'src/parser.ts', line: 14, body: mention }],
      reviewedHeadSha: 'h', reviewedBaseSha: 'b' };
    for (const raw of [JSON.stringify(review), '```json\n' + JSON.stringify(review, null, 2) + '\n```']) {
      const r = parseGPTResponse(raw);
      assert.equal(r.parsed, true, raw);
      assert.equal(r.comments[0].body, mention);
    }
  }
  // 깨진 JSON 에서도 불완전한 표식은 JSON 구조까지 먹지 않는다 — 걷어낼 것은 완전한 표식뿐이다.
  const broken = '{"summary": "s", "approval": "comment", "comments": [{"path": "a", "line": 1, ' +
    '"body": "`:chatgpt-content-reference{` 참고 :chatgpt-content-reference{index="3"}"}]}';
  const r = parseGPTResponse(broken);
  assert.equal(r.parsed, true);
  assert.equal(r.comments[0].body, '`:chatgpt-content-reference{` 참고');
});

test('잘못된 판정/코멘트는 전체 리뷰를 거부한다', () => {
  for (const approval of ['disapprove', 'not approved', 'APPROVE', null, {}]) {
    assert.equal(parseGPTResponse(JSON.stringify({ summary: 'x', approval, comments: [] })).parsed, false);
  }
  for (const comments of [null, {}, [{ path: 'x', message: 'bug' }], [{ path: 'x', body: 'bug', line: '1' }], [{ path: 'x', body: 'bug', line: 0 }]]) {
    assert.equal(parseGPTResponse(JSON.stringify({ summary: 'x', approval: 'approve', comments })).parsed, false);
  }
  assert.equal(parseGPTResponse('{"summary":"ok","approval":"approve","comments":[]}').parsed, true);
});

test('닫힌 PR이 다시 열리면 새 커밋 없이도 리뷰를 재개한다', async () => fixture(async f => {
  applySyncEvents(f.cfg, f.ctx, { status: 'CLOSED', headSha: head, baseRef: 'main' });
  assert.equal(f.ctx.state, 'CLOSED');
  applySyncEvents(f.cfg, f.ctx, { status: 'OPEN', headSha: head, baseRef: 'main' });
  assert.equal(f.ctx.state, 'REVIEW_DUE');
  assert.equal(f.ctx.history.at(-1)?.event, 'PR_REOPENED');
}));

test('게시 완료 상태 저장 실패도 재시도에서 중복 게시하지 않는다', async () => fixture(async f => {
  const original = fs.renameSync;
  let failed = false;
  fs.renameSync = ((from: string, to: string) => {
    if (!failed && JSON.parse(fs.readFileSync(from, 'utf8')).state === 'AWAITING_AUTHOR') {
      failed = true; throw new Error('completion save failed');
    }
    return original(from, to);
  }) as any;
  syncBuiltinESMExports();
  try { assert.equal(await runRound(f.cfg, f.driver, f.ctx), 'failed'); }
  finally { fs.renameSync = original; syncBuiltinESMExports(); }
  assert.equal(f.ctx.state, 'ERROR');
  assert(f.ctx.pendingReview);
  applySyncEvents(f.cfg, f.ctx, { status: 'OPEN', headSha: head, baseRef: 'main' });
  assert.equal(await runRound(f.cfg, null, f.ctx), 'posted');
  assert.equal(f.posts.length, 1);
  assert.equal(f.ctx.round, 1);
}));

test('교체 실패 시 기존 상태를 보존하고 손상된 상태를 신규로 읽지 않는다', async () => await fixture(async f => {
  saveContext(f.cfg, f.ctx);
  const original = fs.renameSync;
  fs.renameSync = () => { throw new Error('injected rename failure'); };
  syncBuiltinESMExports();
  try { assert.throws(() => saveContext(f.cfg, { ...f.ctx, round: 9 }), /rename failure/); }
  finally { fs.renameSync = original; syncBuiltinESMExports(); }
  assert.equal(loadContext(f.cfg, 'o', 'r', 1)?.round, 0);
  assert.equal(fs.readdirSync(path.join(f.cfg.dataDir, 'state')).length, 1);
  fs.writeFileSync(path.join(f.cfg.dataDir, 'state/o__r__1.json'), '{"state":');
  assert.throws(() => loadContext(f.cfg, 'o', 'r', 1), /신규 PR로 덮어쓰지/);
  assert.throws(() => listContexts(f.cfg), /신규 PR로 덮어쓰지/);
}));

test('재시도를 다 쓴 ERROR 는 리뷰 대상이 바뀌면 재시도 횟수를 다시 받는다', async () => fixture(async f => {
  f.ctx.state = 'ERROR';
  f.ctx.retryCount = f.cfg.maxAutoRetries;
  // 실패한 시도가 보낸 대상 A — 스택 PR 의 옛 base. 베이스 PR 이 머지되며 base 가 main(B)으로 바뀌었다.
  f.ctx.pendingSend = { round: 1, headSha: head, baseRef: 'stack-base', mergeBaseSha: base, at: new Date().toISOString() };
  applySyncEvents(f.cfg, f.ctx, { status: 'OPEN', headSha: head, baseRef: 'main' });
  assert.equal(f.ctx.state, 'REVIEW_DUE');
  assert.equal(f.ctx.retryCount, 0);
  assert.deepEqual(f.ctx.retryTarget, { headSha: head, baseRef: 'main' }, '새 예산을 준 대상(B)을 적는다');

  // B 로의 재시도가 전송 전에 실패만 거듭해 pendingSend 가 A 에 남은 채 다시 소진됐다 (#52 리뷰).
  // A 를 기준으로 삼으면 같은 변경에 예산을 끝없이 다시 준다 — B 와 비교해 멈춰야 한다.
  f.ctx.state = 'ERROR';
  f.ctx.retryCount = f.cfg.maxAutoRetries;
  applySyncEvents(f.cfg, f.ctx, { status: 'OPEN', headSha: head, baseRef: 'main' });
  applySyncEvents(f.cfg, f.ctx, { status: 'OPEN', headSha: head, baseRef: 'main' });
  assert.equal(f.ctx.state, 'ERROR');
  assert.equal(f.ctx.retryCount, f.cfg.maxAutoRetries);

  // 실제로 대상이 또 바뀌면 그때 다시 받는다.
  applySyncEvents(f.cfg, f.ctx, { status: 'OPEN', headSha: 'c'.repeat(40), baseRef: 'main' });
  assert.equal(f.ctx.state, 'REVIEW_DUE');
  assert.match(f.ctx.history.at(-1)!.note ?? '', /새 커밋 감지 — 재시도 횟수 초기화/);

  // 기록이 하나도 없으면 처음 본 값이 기준이다 — 대상이 그대로면 사람이 부를 때까지 기다린다.
  f.ctx.state = 'ERROR';
  f.ctx.retryCount = f.cfg.maxAutoRetries;
  delete f.ctx.pendingSend;
  delete f.ctx.retryTarget;
  applySyncEvents(f.cfg, f.ctx, { status: 'OPEN', headSha: 'c'.repeat(40), baseRef: 'main' });
  applySyncEvents(f.cfg, f.ctx, { status: 'OPEN', headSha: 'c'.repeat(40), baseRef: 'main' });
  assert.equal(f.ctx.state, 'ERROR');
}));
