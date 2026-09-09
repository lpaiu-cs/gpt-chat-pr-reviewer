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
import type { ChatGPTDriver } from '../src/chatgpt.js';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const diff = 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n';
const pr = { owner: 'o', repo: 'r', number: 1, url: 'https://github.com/o/r/pull/1', title: 'fixture', author: 'author', baseBranch: 'main', headBranch: 'topic', headSha: head };

async function fixture(fn: (f: {
  cfg: AppConfig; ctx: PRContext; driver: ChatGPTDriver; posts: any[];
  controls: { failSync: boolean; losePostResponse: boolean; wrongTarget: boolean; rejectPost: boolean; prompts: string[] };
}) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'review-boundary-'));
  const cfg = { ...loadConfig(path.join(dir, 'absent.json')), dataDir: dir, customInstructionsFile: path.join(dir, 'instructions.md') };
  const ctx = createContext(pr);
  const posts: any[] = [];
  const controls = { failSync: false, losePostResponse: false, wrongTarget: false, rejectPost: false, prompts: [] as string[] };
  const original = cp.execFile;
  const respond = (file: string, args: string[], opts: any) => {
    assert.equal(file, 'gh');
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ number: 1, url: pr.url, title: pr.title, author: { login: 'author' }, baseRefName: 'main', headRefName: 'topic', headRefOid: head });
    if (args[1] === 'user') return 'bot';
    if (args[1]?.includes('/reactions')) return '[]';
    if (args[1]?.includes('/compare/')) return args.includes('-q') ? base : diff;
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
    ensureAlive: async () => false, startNewChat: async () => {},
    sendAndCollect: async (prompt: string, onSent: (url: string) => void) => {
      controls.prompts.push(prompt);
      onSent('https://chatgpt.com/c/fixture');
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
