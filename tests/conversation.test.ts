import test from 'node:test';
import assert from 'node:assert/strict';
import { planConversation, reconcileCachedOrigin } from '../src/reviewer.js';
import { loadConfig } from '../src/config.js';
import { chatgptProjectId, validateProjectUrl } from '../src/config.js';
import { ChatGPTDriver, sameConversationUrl } from '../src/chatgpt.js';
import type { ResponseMeta } from '../src/cache.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import type { AppConfig, PRContext } from '../src/types.js';

/**
 * 대화 회전 상한 — 몇 차 리뷰까지 **한 대화에서** 이어 가는가.
 *
 * 회전은 공짜가 아니다. 새 대화는 이전 지적을 스니펫으로만 받으므로 같은 곳을
 * 다시 집거나, 이미 고친 맥락을 놓친다. 그래서 이 값은 "성능 튜닝 상수" 가
 * 아니라 리뷰 품질을 정하는 약속이고, 조용히 낮아지면 사용자가 5차부터
 * 대화가 끊기는 것을 겪는다 — 실제로 그 신고를 받고 10 으로 올렸다.
 */

const URL = 'https://chatgpt.com/c/0000-1111';

function ctx(turns: number): PRContext {
  return {
    prUrl: 'https://github.com/o/r/pull/1',
    owner: 'o',
    repo: 'r',
    prNumber: 1,
    title: 't',
    state: 'REVIEW_DUE',
    round: turns,
    requestedCount: 0,
    retryCount: 0,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
    threads: [],
    history: [],
    conversationUrl: URL,
    conversationStartRound: 1,
    conversationTurns: turns,
  } as PRContext;
}

// 설정 파일이 없는 경로를 준다 — 이 저장소의 pr-review.config.json 은
// 사용자별 파일이라 있으면 기본값 대신 그 값이 섞인다.
const cfg = (): AppConfig => loadConfig('tests/__no-such-config__.json');

test('기본 상한은 10 — 10차 리뷰까지는 한 대화에서 이어 간다', () => {
  assert.equal(cfg().maxTurnsPerConversation, 10);
});

test('10회 전송 전까지는 이전 대화를 이어 간다', () => {
  for (let turns = 1; turns < 10; turns++) {
    const plan = planConversation(cfg(), ctx(turns), turns + 1);
    assert.equal(plan.action, 'resume', `${turns}회 전송 뒤에는 이어 가야 한다`);
    assert.equal(plan.action === 'resume' && plan.url, URL);
  }
});

test('10회를 채우면 그때 회전한다 (11차부터 새 대화)', () => {
  const plan = planConversation(cfg(), ctx(10), 11);
  assert.equal(plan.action, 'new');
  assert.equal(plan.action === 'new' && plan.reason, 'rotate');
  assert.equal(plan.turnsUsed, 10);
});

test('설정으로 낮추면 그 값이 상한이다 — 상한은 설정이 정한다', () => {
  const low = { ...cfg(), maxTurnsPerConversation: 3 };
  assert.equal(planConversation(low, ctx(2), 3).action, 'resume');
  assert.equal(planConversation(low, ctx(3), 4).action, 'new');
});

test('구버전 컨텍스트(전송 횟수 없음)는 라운드 차이로 근사한다', () => {
  const old = ctx(0);
  delete old.conversationTurns;
  old.conversationStartRound = 1;
  // 11차 = 시작 라운드로부터 10 — 상한에 정확히 닿는다.
  assert.equal(planConversation(cfg(), old, 11).action, 'new');
  assert.equal(planConversation(cfg(), old, 10).action, 'resume');
});

const PROJECT = 'https://chatgpt.com/g/g-p-6aa1b62772a081919310c24aabc056a0/project';
test('프로젝트 변경·해제는 회전하고 같은 프로젝트의 대화만 이어 쓴다', () => {
  const config = { ...cfg(), chatgptProjectUrl: PROJECT };
  const context = ctx(1);
  assert.equal(planConversation(config, context, 2).action, 'new');
  context.conversationUrl = PROJECT.replace('/project', '-reviews/c/1234');
  assert.equal(planConversation(config, context, 2).action, 'resume');
  assert.equal(planConversation(cfg(), context, 2).action, 'new');
  assert.equal(planConversation({ ...config, chatgptProjectUrl: PROJECT.replace('6aa1', '7aa1') }, context, 2).action, 'new');
  assert.equal(chatgptProjectId(context.conversationUrl), chatgptProjectId(PROJECT));
  for (const bad of [null, 123, 'https://evil.com/g/g-p-123/project', PROJECT.replace('/project', '/c/123'), 'https://chatgpt.com/c/123']) {
    assert.throws(() => validateProjectUrl(bad), /chatgptProjectUrl/);
  }
  validateProjectUrl(PROJECT);
  validateProjectUrl('');
});

test('프로젝트 새 대화는 지정 URL로 진입하며 루트 리다이렉트 시 실패한다', async () => {
  const config = { ...cfg(), chatgptProjectUrl: PROJECT };
  const driver = new ChatGPTDriver(config) as any;
  let actual = PROJECT;
  let destination = '';
  driver.page = {
    goto: async (url: string) => { destination = url; },
    waitForSelector: async () => {}, keyboard: { press: async () => {} },
    waitForTimeout: async () => {}, url: () => actual,
  };
  await driver.startNewChat();
  assert.equal(destination, PROJECT);
  actual = 'https://chatgpt.com';
  await assert.rejects(driver.startNewChat(), /프로젝트에 진입/);
});

test('프로젝트 이름 변경 리다이렉트는 같은 대화와 캐시를 유지한다', async () => {
  const old = PROJECT.replace('/project', '/c/1234');
  const renamed = old.replace('/c/', '-pr-jadong-ribyu/c/');
  const driver = new ChatGPTDriver({ ...cfg(), chatgptProjectUrl: PROJECT }) as any;
  let actual = renamed;
  driver.page = {
    goto: async () => {}, waitForSelector: async () => {},
    keyboard: { press: async () => {} }, waitForTimeout: async () => {},
    url: () => actual, locator: () => ({ innerText: async () => '' }),
  };
  assert.equal(await driver.resumeChat(old, { requireAssistant: false }), true);
  const context = { ...ctx(1), conversationUrl: old };
  assert.equal(reconcileCachedOrigin(context, { conversationUrl: renamed, dryRun: false } as ResponseMeta), false);
  assert.equal(context.conversationUrl, old);
  for (actual of [renamed.replace('/c/1234', '/c/5678'), renamed.replace('6aa1', '7aa1'), 'https://chatgpt.com/c/1234']) {
    assert.equal(await driver.resumeChat(old, { requireAssistant: false }), false);
    assert.equal(sameConversationUrl(old, actual), false);
  }
  assert.equal(sameConversationUrl('invalid', 'invalid'), false);
  assert.equal(sameConversationUrl(URL, `${URL}?source=review`), true);
});

test('프로젝트 입력창 실패는 원인과 최신 URL 등록 방법을 함께 안내한다', async () => {
  const driver = new ChatGPTDriver({ ...cfg(), chatgptProjectUrl: PROJECT }) as any;
  driver.page = {
    goto: async () => {}, url: () => PROJECT,
    waitForSelector: async () => { throw new Error('selector timeout'); },
  };
  await assert.rejects(driver.startNewChat(), (error: Error) => {
    assert.match(error.message, /setup --project-url/);
    assert.match(error.message, /selector timeout/);
    assert.ok(error.message.includes(PROJECT));
    return true;
  });
});

test('설정 없는 최초 실행은 프로젝트 등록을 안내하고 실제 리뷰를 시작하지 않는다', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'project-setup-'));
  const cli = fileURLToPath(new globalThis.URL('../src/cli.ts', import.meta.url));
  const tsx = new globalThis.URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href;
  try {
    for (const args of [['setup'], ['setup', '--project-url', 'https://example.com'], ['watch', '--once']]) {
      const run = spawnSync(process.execPath, ['--import', tsx, cli, ...args], {
        cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 10_000,
      });
      assert.equal(run.status, 1, run.stderr);
      assert.match(run.stdout + run.stderr, /프로젝트|project-url/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('프로젝트가 빠진 드라이버도 일반 채팅으로 폴백하지 않는다', async () => {
  const driver = new ChatGPTDriver(cfg()) as any;
  let navigated = false;
  driver.page = { goto: async () => { navigated = true; } };
  await assert.rejects(driver.startNewChat(), /setup/);
  assert.equal(navigated, false);
  assert.throws(() => driver.assertProjectPage({ url: () => 'https://chatgpt.com/c/123' }), /setup/);
});
