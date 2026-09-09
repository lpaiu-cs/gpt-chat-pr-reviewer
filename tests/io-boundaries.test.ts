import test from 'node:test';
import assert from 'node:assert/strict';
import cp, { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fetchPRSyncData, fetchRepoProbe, gh, pollDelay } from '../src/github.js';
import { intents } from '../src/intents.js';

test('스레드와 답글의 후속 페이지를 모두 읽고 불완전한 페이지는 거부한다', async () => {
  const original = cp.execFile;
  let broken = false;
  const connection = (nodes: any[], more = false) => ({ nodes, pageInfo: { hasNextPage: more, endCursor: more ? 'next' : null } });
  const comment = (body: string) => ({ author: { login: 'bot' }, body, pullRequestReview: { databaseId: 7 } });
  const thread = (id: number) => ({ id: `T${id}`, path: 'x', isResolved: id !== 100, comments: connection([comment('root')]) });
  cp.execFile = ((_file: string, args: string[], _opts: any, cb: any) => ({ stdin: { on() {}, end(query: string) {
    setImmediate(() => {
      try {
        const later = args.includes('after=next');
        if (later && broken) return cb(new Error('page failed'), '', '');
        let data: any;
        if (query.includes('node(id:')) data = { node: { comments: connection([comment('last reply')]) } };
        else if (query.includes('prs:')) data = { repository: {
          prs: { totalCount: 51, ...connection(later ? [{ number: 51, author: { login: 'a' } }] :
            Array.from({ length: 50 }, (_, i) => ({ number: i + 1, author: { login: 'a' } })), !later) },
          t1: { reviewThreads: connection(Array.from({ length: 100 }, (_, i) => thread(i)), true) },
        } };
        else {
          const first = Array.from({ length: 100 }, (_, i) => thread(i));
          first[0].comments = connection(Array.from({ length: 100 }, () => comment('reply')), true);
          data = { repository: { pullRequest: { state: 'OPEN', headRefOid: 'head', baseRefName: 'main',
            reviewThreads: connection(later ? [thread(100)] : first, !later),
          } } };
        }
        cb(null, JSON.stringify({ data }), '');
      } catch (e) { cb(e, '', ''); }
    });
  } } })) as any;
  syncBuiltinESMExports();
  try {
    const full = await fetchPRSyncData('o', 'r', 1);
    assert.equal(full.threads.length, 101);
    assert.equal(full.threads[0].comments.length, 101);
    assert.equal(full.threads[0].comments.at(-1)?.body, 'last reply');
    const probe = await fetchRepoProbe('o/r', [1]);
    assert.equal(probe.prs.length, 51);
    assert.equal(probe.truncated, false);
    assert.equal(probe.prs[0].threads?.length, 101);
    assert.equal(probe.prs[0].threads?.at(-1)?.isResolved, false);
    broken = true;
    await assert.rejects(fetchPRSyncData('o', 'r', 1), /page failed/);
    await assert.rejects(fetchRepoProbe('o/r', [1]), /page failed/);
  } finally { cp.execFile = original; syncBuiltinESMExports(); }
});

test('gh 대기 중 이벤트 루프가 진행하고 시간 제한 오류를 전파한다', async () => {
  const original = cp.execFile;
  let ticked = false;
  cp.execFile = ((_file: string, _args: string[], opts: any, cb: any) => {
    assert.equal(opts.windowsHide, true);
    assert.equal(opts.timeout, 20);
    setTimeout(() => cb(Object.assign(new Error('timeout'), { killed: true }), '', ''), opts.timeout);
    return { stdin: { on() {}, end() {} } };
  }) as any;
  syncBuiltinESMExports();
  try {
    setImmediate(() => { ticked = true; });
    await assert.rejects(gh(['fixture'], { timeoutMs: 20 }), /timeout/);
    assert(ticked);
  } finally { cp.execFile = original; syncBuiltinESMExports(); }
});

test('한도 갱신을 넘어 잠들지 않고 대기 중 의도는 즉시 알린다', () => {
  assert.equal(pollDelay(10000, 10, 0, 3600000, 0), 3600000);
  assert.equal(pollDelay(10000, 10, 0, 3600000, 3600001), 10000);
  assert.equal(pollDelay(10000, 10, 0, 0, 0), 60000);
  let woke = false;
  intents.onPending = () => { woke = true; };
  try { intents.push({ kind: 'stop' }); assert(woke); assert.equal(intents.drain()[0].kind, 'stop'); }
  finally { intents.onPending = undefined; intents.drain(); }
});

test('실제 notify 프로세스가 동시 리뷰 배열에서 대상 시작/게시를 한 번씩 알린다', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const cards = [{ key: 'o/r#1', state: 'REVIEW_DUE', round: 0 }];
    const send = (active: any[], contexts = cards) => res.write(`data: ${JSON.stringify({ type: 'snapshot', data: { session: 'fixture', contexts, active } })}\n\n`);
    send([]);
    const active = [1, 2].map(n => ({ key: `o/r#${n}`, round: 1, startedAt: 10, phase: 'waiting' }));
    send(active); send(active);
    send(active.map(a => ({ ...a, phase: 'posting' })));
    send([], [{ ...cards[0], state: 'AWAITING_AUTHOR', round: 1 }]);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as any).port;
  const child = spawn(process.execPath, ['scripts/notify.mjs', '--url', `http://127.0.0.1:${port}`, '--pr', 'o/r#1', '--porcelain', '--until', 'posted', '--timeout', '5'], { windowsHide: true });
  let out = ''; child.stdout.on('data', b => { out += b; });
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, out);
    assert.equal(out.split('\n').filter(s => s.startsWith('round-start  ')).length, 1, out);
    assert.equal(out.split('\n').filter(s => s.startsWith('posting  ')).length, 1, out);
    assert(!out.includes('o/r#2'), out);
  } finally { child.kill(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
