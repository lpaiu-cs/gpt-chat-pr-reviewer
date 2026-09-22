import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { AccountSwitch } from '../src/account-switch.js';
import { loadConfig } from '../src/config.js';
import type { ChatGPTDriver } from '../src/chatgpt.js';
import { intents } from '../src/intents.js';
import { progress } from '../src/progress.js';
import { createContext, saveContext, listContexts } from '../src/state/store.js';
import { runRound } from '../src/reviewer.js';
import { parseIntent, startUIServer } from '../src/ui/server.js';

test('계정 전환은 안전 지점에서 실행하고 새 로그인·프로젝트 확인 후에만 저장/재개한다', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'review-account-'));
  const cwd = process.cwd();
  process.chdir(dir);
  progress.enabled = true;
  let opened = 0;
  let user: { id: string; email: string } | null = { id: 'old-id', email: 'old@example.test' };
  const oldProject = { url: 'https://chatgpt.com/g/g-p-1234-old/project', name: 'Old project' };
  const nextProject = { url: 'https://chatgpt.com/g/g-p-5678-new/project', name: 'New project' };
  writeFileSync('pr-review.config.json', JSON.stringify({ chatgptProjectUrl: oldProject.url, chatgptProjectName: oldProject.name, watch: { include: ['keep/*'] } }));
  const cfg = { ...loadConfig(), dataDir: path.join(dir, 'data') };
  let projectFailure = true;
  const driver = {
    getSessionUser: async () => user,
    openAccountBrowser: async () => { opened++; },
    registerProject: async () => {
      cfg.chatgptProjectUrl = nextProject.url;
      cfg.chatgptProjectName = nextProject.name;
      if (projectFailure) throw new Error('프로젝트 접근 실패');
    },
    projectEntry: async () => nextProject,
  } as unknown as ChatGPTDriver;
  const ctx = createContext({ owner: 'o', repo: 'r', number: 1, url: 'https://github.com/o/r/pull/1', title: 'PR', author: 'o' });
  ctx.state = 'QUOTA_BLOCKED';
  ctx.quotaRetryAt = new Date(Date.now() + 3600000).toISOString();
  ctx.conversationUrl = 'https://chatgpt.com/c/old-chat';
  ctx.pendingSend = { conversationUrl: ctx.conversationUrl } as any;
  ctx.round = 3;
  saveContext(cfg, ctx);
  saveContext(cfg, { ...ctx, prNumber: 2, state: 'AWAITING_AUTHOR' });
  try {
    let flow = new AccountSwitch(cfg, () => driver);
    flow.request('start');
    assert.equal(flow.blocked, true);
    assert.equal(opened, 0, 'HTTP 예약 시에는 진행 중인 브라우저를 조작하지 않는다');
    assert.equal(cfg.accountSwitchPending, undefined);
    assert.throws(() => flow.request('start'), /처리/);
    assert.deepEqual(intents.drain(), [{ kind: 'account-switch', action: 'start' }]);
    await flow.apply('start');
    assert.equal(opened, 1);
    assert.equal(progress.state().snapshot.ready, false);
    assert.equal(loadConfig().accountSwitchPending?.previousUser, 'old-id');
    await assert.rejects(runRound(cfg, null, ctx), /계정 변경 중/);
    assert.equal(await flow.apply('complete'), false);
    assert.match(flow.state.error!, /이전 계정/);
    user = null;
    assert.equal(await flow.apply('complete'), false);
    assert.match(flow.state.error!, /로그인/);
    user = { id: 'new-id', email: 'new@example.test' };
    assert.equal(await flow.apply('complete'), false);
    assert.equal(cfg.chatgptProjectUrl, oldProject.url);
    assert.equal(listContexts(cfg)[0].conversationUrl, ctx.conversationUrl);
    assert.equal(loadConfig().chatgptProjectUrl, oldProject.url);
    // 프로세스가 재시작해도 실패 중인 설정을 준비 완료로 읽지 않는다.
    assert.equal(new AccountSwitch(loadConfig(), () => driver).blocked, true);
    flow = new AccountSwitch(cfg, () => driver);
    assert.equal(flow.blocked, true);
    assert.equal(flow.state.phase, 'login');
    projectFailure = false;
    const getUser = driver.getSessionUser;
    let checks = 0;
    driver.getSessionUser = async () => ++checks === 1 ? user : { id: 'changed-during-check' };
    assert.equal(await flow.apply('complete'), false);
    assert.match(flow.state.error!, /확인 중 계정이 바뀌/);
    assert.equal(listContexts(cfg)[0].conversationUrl, ctx.conversationUrl);
    driver.getSessionUser = getUser;
    const saved = readFileSync('pr-review.config.json', 'utf8');
    writeFileSync('pr-review.config.json', '{broken');
    assert.equal(await flow.apply('complete'), false, '저장 실패면 재개 금지');
    assert.equal(flow.blocked, true);
    assert.equal(progress.state().snapshot.ready, false);
    writeFileSync('pr-review.config.json', saved);
    assert.equal(await flow.apply('complete'), true);
    assert.equal(flow.blocked, false);
    const config = loadConfig();
    assert.equal(config.accountSwitchPending, null);
    assert.equal(config.chatgptProjectUrl, nextProject.url);
    assert.equal(config.chatgptProjectName, nextProject.name);
    assert.deepEqual(config.watch?.include, ['keep/*']);
    assert.equal(progress.state().snapshot.account, user.email);
    assert.deepEqual(progress.state().snapshot.project, nextProject);
    for (const row of listContexts(cfg)) {
      assert.equal(row.conversationUrl, undefined);
      assert.equal(row.pendingSend, undefined);
      assert.equal(row.quotaRetryAt, undefined);
      assert.equal(row.round, 3);
      assert.equal(row.state, row.prNumber === 1 ? 'REVIEW_DUE' : 'AWAITING_AUTHOR');
    }
  } finally {
    progress.enabled = false;
    intents.drain();
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('실제 Chrome 대시보드: 전환 안내·대기·오류·프로젝트 URL 표시와 전용 API', async () => {
  const actions: string[] = [];
  const ui = await startUIServer(26000 + process.pid % 10000, {
    readInstructions: () => '', writeInstructions: () => '', validate: () => null,
    requestAccountSwitch: action => {
      actions.push(action);
      progress.patch({ accountSwitch: { phase: action === 'start' ? 'queued' : 'checking' } });
    },
  });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const post = (body: unknown, headers = {}) => fetch(`${ui.url}/api/account`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await post({ action: 'start' }, { Origin: 'https://example.com' })).status, 403);
    assert.equal((await post({ action: 'unknown' })).status, 400);
    assert.equal((await post(null)).status, 400);
    assert.equal(typeof parseIntent({ kind: 'account-switch', action: 'start' }), 'string');
    assert.deepEqual(actions, []);
    progress.patch({ ready: true, mode: 'review', accountSwitch: { phase: 'idle' } });
    await page.goto(ui.url);
    await page.getByRole('button', { name: '계정 변경', exact: true }).click();
    await page.getByRole('button', { name: '계정 변경 시작', exact: true }).click();
    await page.getByText('진행 중인 리뷰가 끝나기를 기다리고 있습니다.').waitFor();
    assert.deepEqual(actions, ['start']);
    assert.equal(await page.locator('#btn-account-complete').isDisabled(), true);
    progress.patch({ ready: false, accountSwitch: { phase: 'login', error: '이전 계정이 그대로 로그인되어 있습니다.' } });
    await page.getByText('이전 계정이 그대로 로그인되어 있습니다.', { exact: true }).waitFor();
    await page.getByRole('button', { name: '로그인·프로젝트 확인', exact: true }).click();
    await page.getByText('새 계정과 프로젝트 접근을 확인하고 저장하는 중입니다.').waitFor();
    assert.deepEqual(actions, ['start', 'complete']);
    const project = { name: '리뷰 <프로젝트>', url: 'https://chatgpt.com/g/g-p-5678-new/project' };
    progress.patch({ ready: true, account: 'new@example.test', project, accountSwitch: { phase: 'complete' } });
    await page.getByText('계정과 프로젝트 URL을 저장했습니다. 리뷰를 재개합니다.').waitFor();
    const link = page.locator('#account-project a');
    assert.equal(await link.getAttribute('href'), project.url);
    assert.equal(await link.textContent(), `${project.name} — ${project.url}`);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await ui.close(); }
});
