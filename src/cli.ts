#!/usr/bin/env node

/**
 * pr-review-by-gpt-chat CLI
 *
 * Commands
 *   setup             ChatGPT 최초 로그인 (브라우저 프로필 생성)
 *   init              설정 파일 + 맞춤 지침 파일 생성
 *   instructions      맞춤 지침 파일 열기/생성
 *   review <pr>       특정 PR 리뷰 라운드 실행
 *   watch             감시 범위 폴링 → 상태 머신 동기화 → 큐 순서대로 자동 리뷰
 *   queue             리뷰 대기열 조회 (--json)
 *   status [pr]       추적 중인 PR 상태 조회 (--json)
 *   graph [pr]        상태 머신 mermaid 다이어그램 출력
 *   rounds <pr>       특정 PR 의 리뷰 라운드 이력 조회
 */

import { spawn } from 'node:child_process';
import { Command } from 'commander';
import chalk from 'chalk';

import { loadConfig, initConfig, ensureDataDir } from './config.js';
import { ChatGPTDriver } from './chatgpt.js';
import { parsePRInput, getPRInfo, fetchRepoProbe, takeGraphQLUsage } from './github.js';
import { syncPR, syncPRFromProbe, runRound } from './reviewer.js';
import { fire, canFire, toMermaid, STATE_LABELS, NEXT_ACTION_HINTS } from './state/machine.js';
import { createContext, loadContext, saveContext, listContexts } from './state/store.js';
import { ensureInstructionsFile } from './instructions.js';
import {
  createRepoSource,
  describeScope,
  passesFilters,
  resolveWatchScope,
} from './watch-scope.js';
import {
  buildQueue,
  formatWaiting,
  quotaGateUntil,
  QUEUE_REASON_LABELS,
  type QueueEntry,
} from './queue.js';
import type { AppConfig, PRContext, PREvent, PRState } from './types.js';

// ── 배너 ────────────────────────────────────────────────────

function banner() {
  console.log(
    chalk.bold.cyan(`
  ┌─────────────────────────────────────────┐
  │  PR Review by GPT Chat                  │
  │  상태 머신 기반 ChatGPT PR 자동 리뷰    │
  └─────────────────────────────────────────┘
`),
  );
}

// ── 공용 헬퍼 ───────────────────────────────────────────────

/** 컨텍스트 로드 or 생성 (생성 시 저장까지). */
function loadOrCreateContext(cfg: AppConfig, prInput: string): PRContext {
  const { owner, repo, number } = parsePRInput(prInput);
  const existing = loadContext(cfg, owner, repo, number);
  if (existing) return existing;
  const info = getPRInfo(owner, repo, number);
  const ctx = createContext(info);
  saveContext(cfg, ctx);
  return ctx;
}

/** 드라이버 launch → 로그인 확인 → fn 실행 → close. */
async function withDriver(
  cfg: AppConfig,
  fn: (driver: ChatGPTDriver) => Promise<void>,
): Promise<void> {
  const driver = new ChatGPTDriver(cfg);
  try {
    await driver.launch();
    await driver.navigateToChatGPT();
    const user = await driver.getSessionUser();
    if (!user) {
      console.log(chalk.red('  ✗ ChatGPT 로그인이 필요합니다. 먼저 setup 을 실행하세요.'));
      return;
    }
    console.log(chalk.dim(`  계정: ${user.email ?? user.name}`));
    await fn(driver);
  } finally {
    await driver.close();
  }
}

/** REVIEW_DUE 가 아닌 상태를 --force 로 강제 해제하기 위한 이벤트 매핑. */
const FORCE_EVENTS: Partial<Record<PRState, PREvent>> = {
  AWAITING_AUTHOR: 'AUTHOR_RESPONDED',
  CONVERGED: 'NEW_COMMITS',
  QUOTA_BLOCKED: 'COOLDOWN_ELAPSED',
  ERROR: 'RETRY',
};

function stateBadge(state: PRState): string {
  const label = `${STATE_LABELS[state]} (${state})`;
  switch (state) {
    case 'REVIEW_DUE':
      return chalk.cyan(label);
    case 'REVIEWING':
      return chalk.blue(label);
    case 'AWAITING_AUTHOR':
      return chalk.yellow(label);
    case 'CONVERGED':
      return chalk.green(label);
    case 'QUOTA_BLOCKED':
      return chalk.magenta(label);
    case 'ERROR':
      return chalk.red(label);
    case 'CLOSED':
      return chalk.dim(label);
  }
}

/** 변화가 없어도 이 간격마다 한 줄 찍어 살아있음을 알린다. */
const HEARTBEAT_MS = 10 * 60_000;

/** 남은 GraphQL 한도 중 감시에 쓸 최대 비율 (나머지는 리뷰 게시·수동 조회 몫). */
const RATE_BUDGET_RATIO = 0.5;

/** 폴링 주기 하한 — 이보다 짧으면 secondary rate limit 위험. */
const MIN_INTERVAL_MS = 5_000;

/** ms 를 사람이 읽을 수 있는 간격 표기로 (초 단위 폴링도 표시 가능하게). */
function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}초`;
  const min = ms / 60_000;
  return Number.isInteger(min) ? `${min}분` : `${min.toFixed(1)}분`;
}

/** OS 기본 편집기로 파일 열기 (실패해도 무시). */
function openInEditor(file: string): void {
  try {
    const [cmd, args] =
      process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', file]]
        : process.platform === 'darwin'
          ? ['open', [file]]
          : ['xdg-open', [file]];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* 편집기 실행 실패 — 경로만 안내 */
  }
}

// ── CLI ─────────────────────────────────────────────────────

const program = new Command()
  .name('pr-review')
  .description('상태 머신 기반 ChatGPT PR 자동 리뷰')
  .version('0.2.0');

// ── setup ──

program
  .command('setup')
  .description('ChatGPT 최초 로그인 — 브라우저를 열어 수동 로그인')
  .action(async () => {
    banner();
    const cfg = loadConfig();
    const driver = new ChatGPTDriver(cfg);

    console.log(chalk.dim('  브라우저 프로필 경로:'), cfg.browserProfileDir);
    await driver.launch();
    await driver.navigateToChatGPT();

    const existing = await driver.getSessionUser();
    if (existing) {
      console.log(chalk.green(`  ✓ 이미 로그인되어 있습니다 — ${existing.email ?? existing.name}`));
    } else {
      await driver.waitForManualLogin();
    }

    console.log(chalk.green('\n  ✓ 설정 완료 — 브라우저 프로필이 저장되었습니다.'));
    console.log(chalk.dim('    이후 review / watch 명령에서 자동으로 이 세션을 재사용합니다.\n'));
    await driver.close();
  });

// ── whoami ──

program
  .command('whoami')
  .description('현재 브라우저 프로필의 ChatGPT 로그인 상태 확인')
  .option('--headless', '헤드리스 모드로 확인', false)
  .action(async (opts: { headless: boolean }) => {
    banner();
    const cfg = loadConfig();
    if (opts.headless) cfg.headless = true;

    const driver = new ChatGPTDriver(cfg);
    try {
      await driver.launch();
      await driver.navigateToChatGPT();
      const user = await driver.getSessionUser();

      if (user) {
        console.log(chalk.green(`  ✓ 로그인됨 — ${user.email ?? user.name}`));
        console.log(chalk.dim('    review / watch 를 실행할 수 있습니다.\n'));
      } else {
        console.log(chalk.red('  ✗ 로그아웃 상태입니다 (익명 세션).'));
        console.log(chalk.dim('    이 상태로는 비공개 레포를 읽을 수 없습니다.'));
        console.log(chalk.dim('    `npm run dev -- setup` 으로 로그인하세요.\n'));
      }
    } finally {
      await driver.close();
    }
  });

// ── init ──

program
  .command('init')
  .description('설정 파일 + 맞춤 지침 파일 초기 생성')
  .action(() => {
    banner();
    const configPath = initConfig();
    const cfg = loadConfig();
    const instrPath = ensureInstructionsFile(cfg);
    console.log(chalk.green(`  ✓ ${configPath} 생성 완료`));
    console.log(chalk.green(`  ✓ ${instrPath} 생성 완료 (맞춤 리뷰 지침)`));
    console.log(chalk.dim('    watch.include 에 감시 범위를 추가한 뒤 watch 를 실행하세요.'));
    console.log(chalk.dim('      예: "include": ["myorg/*"]  또는  ["owner/repo"]\n'));
  });

// ── instructions ──

program
  .command('instructions')
  .description('맞춤 리뷰 지침 파일 열기 (없으면 생성)')
  .action(() => {
    banner();
    const cfg = loadConfig();
    const f = ensureInstructionsFile(cfg);
    console.log(chalk.green(`  ✓ 지침 파일: ${f}`));
    console.log(chalk.dim('    이 파일의 내용이 매 리뷰 프롬프트에 주입됩니다.\n'));
    openInEditor(f);
  });

// ── review ──

program
  .command('review <pr>')
  .description('특정 PR 리뷰 라운드 실행 (URL · owner/repo#N · PR번호)')
  .option('--dry-run', '게시·상태 전이 없이 결과만 출력', false)
  .option('--force', 'REVIEW_DUE 가 아니어도 강제로 라운드 실행', false)
  .option('--headless', '헤드리스 모드로 실행', false)
  .option('--instructions <file>', '이번 실행에만 사용할 지침 파일')
  .option('--timeout <minutes>', '응답 대기 시간 (분)')
  .option('--from-cache', 'ChatGPT 재호출 없이 마지막 저장 응답으로 게시만 재시도', false)
  .action(
    async (
      pr: string,
      opts: {
        dryRun: boolean;
        force: boolean;
        headless: boolean;
        fromCache: boolean;
        instructions?: string;
        timeout?: string;
      },
    ) => {
      banner();
      const cfg = loadConfig();
      if (opts.headless) cfg.headless = true;
      if (opts.timeout) {
        const min = Number(opts.timeout);
        if (!Number.isFinite(min) || min <= 0) {
          console.log(chalk.red(`  ✗ --timeout 값이 올바르지 않습니다: ${opts.timeout}\n`));
          return;
        }
        cfg.responseTimeoutMs = min * 60_000;
      }
      ensureDataDir(cfg);

      const ctx = loadOrCreateContext(cfg, pr);
      syncPR(cfg, ctx);

      if (ctx.state === 'CLOSED') {
        console.log(`  ${stateBadge(ctx.state)} — 닫힌 PR 은 리뷰할 수 없습니다.\n`);
        return;
      }

      // dry-run 은 상태와 무관하게 실행 가능
      if (ctx.state !== 'REVIEW_DUE' && !opts.dryRun) {
        const forceEvent = FORCE_EVENTS[ctx.state];
        if (opts.force && forceEvent && canFire(ctx.state, forceEvent)) {
          fire(ctx, forceEvent, { note: '--force 수동 강제' });
          saveContext(cfg, ctx);
        } else {
          console.log(`  현재 상태: ${stateBadge(ctx.state)}`);
          console.log(chalk.dim(`  다음 액션: ${NEXT_ACTION_HINTS[ctx.state]}`));
          console.log(chalk.dim('  지금 바로 리뷰하려면 --force 를 사용하세요.\n'));
          return;
        }
      }

      const roundOpts = {
        dryRun: opts.dryRun,
        instructionsFile: opts.instructions,
        fromCache: opts.fromCache,
      };
      const reportState = (outcome: string) => {
        if (outcome !== 'dry') {
          console.log(`\n  현재 상태: ${stateBadge(ctx.state)}`);
          console.log(chalk.dim(`  다음 액션: ${NEXT_ACTION_HINTS[ctx.state]}`));
        }
      };

      if (opts.fromCache) {
        // 캐시 재시도는 ChatGPT 를 쓰지 않으므로 브라우저를 띄우지 않는다.
        reportState(await runRound(cfg, null, ctx, roundOpts));
      } else {
        await withDriver(cfg, async (driver) => {
          reportState(await runRound(cfg, driver, ctx, roundOpts));
        });
      }
      console.log();
    },
  );

// ── watch ──

program
  .command('watch')
  .description('감시 범위 폴링 → 상태 머신 동기화 → 리뷰 큐 순서대로 자동 리뷰')
  .option('--headless', '헤드리스 모드로 실행', false)
  .option('--dry-run', '게시·상태 전이 없이 결과만 출력', false)
  .option('--once', '1회만 스캔 후 큐를 모두 소진하고 종료', false)
  .action(async (opts: { headless: boolean; dryRun: boolean; once: boolean }) => {
    banner();
    const cfg = loadConfig();
    if (opts.headless) cfg.headless = true;
    ensureDataDir(cfg);

    if (cfg.watchIntervalMs < MIN_INTERVAL_MS) {
      console.log(
        chalk.yellow(
          `  ⚠ watchIntervalMs ${cfg.watchIntervalMs}ms 는 너무 짧습니다 — ${MIN_INTERVAL_MS}ms 로 조정합니다.`,
        ),
      );
      cfg.watchIntervalMs = MIN_INTERVAL_MS;
    }

    const scope = resolveWatchScope(cfg);
    if (!scope) {
      console.log(chalk.red('  ✗ 감시 범위가 비어 있습니다.'));
      console.log(chalk.dim('    pr-review.config.json 에 다음 중 하나를 설정하세요:'));
      console.log(chalk.dim('      watch.include  — 예: ["myorg/*"] (mode: "account")'));
      console.log(chalk.dim('      watchRepos     — 예: ["owner/repo"] (구버전 설정)\n'));
      return;
    }
    console.log(chalk.dim(`  감시 범위: ${describeScope(scope)}`));
    const repoSource = createRepoSource(scope);

    const driver = new ChatGPTDriver(cfg);
    await driver.launch();
    await driver.navigateToChatGPT();

    const user = await driver.getSessionUser();
    if (!user) {
      console.log(chalk.red('  ✗ ChatGPT 로그인이 필요합니다. 먼저 setup 을 실행하세요.'));
      await driver.close();
      return;
    }
    console.log(chalk.dim(`  계정: ${user.email ?? user.name}`));

    // 짧은 주기로 돌리면 매 사이클 출력은 소음이다. PR 상태가 바뀌었을 때만
    // 한 줄 찍고, 그 외에는 주기적 하트비트로만 살아있음을 알린다.
    const reported = new Map<string, string>();
    let lastHeartbeat = 0;
    let lastRemaining = -1; // 마지막 probe 가 보고한 GraphQL 잔여 한도
    let lastCycleCost = 0; // 직전 사이클이 실제로 쓴 GraphQL point 합계
    let watchedRepos = 0; // 마지막 스캔에서 실제로 폴링한 레포 수

    // 쿼터 쿨다운. 큐를 버리지 않고 이 시각까지 실행만 멈춘다.
    // watch 를 재시작해도 컨텍스트에서 복원되도록 시작 시 한 번 읽어둔다.
    let quotaUntil = quotaGateUntil(listContexts(cfg)) ?? 0;
    let quotaNotified = 0;

    const reportIfChanged = (ctx: PRContext): void => {
      const key = `${ctx.owner}/${ctx.repo}#${ctx.prNumber}`;
      const sig = `${ctx.state}:${ctx.round}`;
      if (reported.get(key) === sig) return;
      reported.set(key, sig);
      console.log(
        `    ${chalk.dim(`${ctx.owner}/${ctx.repo}`)}#${String(ctx.prNumber).padEnd(5)} ` +
          `${stateBadge(ctx.state)} ${chalk.dim(ctx.title.slice(0, 45))}`,
      );
    };

    /**
     * 스캔 — 감시 범위의 모든 레포를 동기화하고, 리뷰 후보 컨텍스트를 모은다.
     * 여기서는 리뷰를 실행하지 않는다. 실행 순서는 큐가 정한다.
     */
    const scan = (): { eligible: PRContext[]; openCount: number } => {
      const repos = repoSource.list();
      watchedRepos = repos.length;
      const eligible: PRContext[] = [];
      let openCount = 0;

      const all = listContexts(cfg);

      for (const repoSlug of repos) {
        const tracked = all.filter(
          (c) => `${c.owner}/${c.repo}` === repoSlug && c.state !== 'CLOSED',
        );

        // resolve 감지가 필요한 PR = AWAITING_AUTHOR.
        // PR.updatedAt 은 스레드 resolve 로 갱신되지 않으므로(실측) 스레드 상태를
        // 직접 조회해야 한다. 같은 쿼리에 alias 로 얹으면 추가 비용이 없다.
        const needThreads = tracked
          .filter((c) => c.state === 'AWAITING_AUTHOR')
          .map((c) => c.prNumber);

        let probe;
        try {
          probe = fetchRepoProbe(repoSlug, needThreads);
        } catch {
          console.log(chalk.yellow(`  ⚠ ${repoSlug} probe 실패 — 건너뜁니다.`));
          continue;
        }
        openCount += probe.prs.length;
        // 잔여 한도는 사이클 끝에서 takeGraphQLUsage() 로 한 번에 읽는다.
        // probe 시점 값을 쓰면 폴백 동기화 이전 상태라 과대평가된다.
        if (probe.truncated) {
          console.log(
            chalk.yellow(
              `  ⚠ ${repoSlug} 열린 PR ${probe.totalOpen}건 중 ${probe.prs.length}건만 조회했습니다 (최근 갱신 순).`,
            ),
          );
        }

        // 추적 중이지만 열린 목록에 없는 PR → 닫힘 확인 (여기서만 개별 조회)
        for (const c of tracked) {
          if (!probe.prs.some((p) => p.number === c.prNumber)) {
            syncPR(cfg, c);
            reportIfChanged(c);
          }
        }

        for (const pr of probe.prs) {
          const existing = loadContext(cfg, pr.owner, pr.repo, pr.number);
          const verdict = passesFilters(pr, scope.filters);

          // 필터에 걸린 PR 은 추적 자체를 시작하지 않는다. 이미 추적 중이라면
          // (초안으로 되돌렸거나 라벨을 뗀 경우) 상태는 계속 갱신하되 큐에서 뺀다.
          if (!existing && !verdict.ok) continue;

          const ctx = existing ?? createContext(pr);
          ctx.title = pr.title;

          // 1단계: probe 만으로 전이 판정 (API 추가 호출 없음)
          const needsFull = syncPRFromProbe(cfg, ctx, pr);

          // 2단계: 모르는 스레드가 생겼을 때만 전체 동기화
          if (needsFull) syncPR(cfg, ctx);

          reportIfChanged(ctx);
          if (verdict.ok) eligible.push(ctx);
        }
      }

      return { eligible, openCount };
    };

    /**
     * 한 사이클. 리뷰를 1건이라도 실행했으면 true.
     *
     * drain=false 면 큐의 맨 앞 1건만 돌린다. 라운드는 2~15분 걸리므로 그 사이
     * 다른 PR 의 상황이 바뀐다 — 한 건 끝날 때마다 다시 스캔해 우선순위를 새로
     * 매기는 편이 정확하다 (리뷰 직후 재스캔은 대기 없이 즉시 예약된다).
     */
    /**
     * 이번 사이클이 쓴 GraphQL 비용을 확정한다.
     * 어느 경로로 사이클이 끝나든 반드시 호출해야 한다 — 빠뜨리면 소모량이
     * 다음 사이클로 이월되어 실제보다 비싸 보이고 주기가 과하게 늘어난다.
     */
    const tally = (): number => {
      const usage = takeGraphQLUsage();
      lastCycleCost = usage.cost;
      lastRemaining = usage.remaining;
      return usage.cost;
    };

    const loop = async (drain: boolean): Promise<boolean> => {
      // 사이클 시작 시점에 카운터를 비운다. 레포 탐색·probe 뿐 아니라 폴백 전체
      // 동기화·닫힘 확인·게시 후 동기화까지 모든 GraphQL 경로가 여기에 집계된다.
      takeGraphQLUsage();

      const { eligible, openCount } = scan();
      const queue = buildQueue(eligible);

      // ── 쿼터 게이트: 큐는 보존하고 실행만 멈춘다 ──
      // 컨텍스트에서 다시 읽어 review 명령 등 다른 경로가 걸린 한도도 반영한다.
      // dry-run 은 상태를 전이시키지 않으므로 메모리 값도 함께 본다.
      quotaUntil = Math.max(quotaUntil, quotaGateUntil(eligible) ?? 0);
      if (queue.length > 0 && Date.now() < quotaUntil) {
        tally(); // 실행은 건너뛰어도 스캔 비용은 이번 사이클 몫이다
        if (Date.now() - quotaNotified > HEARTBEAT_MS) {
          quotaNotified = Date.now();
          console.log(
            chalk.magenta(
              `    쿼터 대기 — 큐 ${queue.length}건 보존 · ${new Date(quotaUntil).toLocaleString('ko-KR')} 이후 재개`,
            ),
          );
        }
        return false;
      }

      let reviewRan = false;
      for (let i = 0; i < queue.length; i++) {
        const { ctx, reason } = queue[i];
        console.log(
          chalk.bold(`\n  🔍 ${ctx.owner}/${ctx.repo}#${ctx.prNumber}`) +
            chalk.dim(`  [${QUEUE_REASON_LABELS[reason]}]`) +
            (queue.length > 1 ? chalk.dim(`  대기열 ${i + 1}/${queue.length}`) : ''),
        );
        const outcome = await runRound(cfg, driver, ctx, { dryRun: opts.dryRun });
        reported.set(`${ctx.owner}/${ctx.repo}#${ctx.prNumber}`, `${ctx.state}:${ctx.round}`);
        reviewRan = true;

        if (outcome === 'quota') {
          // 한도는 계정 단위라 남은 큐도 지금은 못 돈다. 버리지 않고 미룬다.
          quotaUntil = Date.now() + cfg.quotaCooldownMs;
          quotaNotified = Date.now();
          const left = queue.length - i - 1;
          console.log(
            chalk.yellow(
              `\n  ⚠ 쿼터 한도 도달 — 남은 큐 ${left}건을 보존하고 ` +
                `${new Date(quotaUntil).toLocaleString('ko-KR')} 이후 재개합니다.`,
            ),
          );
          break;
        }
        if (!drain) break; // 한 건만 돌리고 즉시 재스캔
      }

      // 사이클이 끝난 뒤에 집계한다 — 폴백 동기화 비용까지 포함된다.
      const cost = tally();

      // 아무 변화 없이 조용한 구간에서도 살아있음을 알린다
      if (!reviewRan && Date.now() - lastHeartbeat > HEARTBEAT_MS) {
        lastHeartbeat = Date.now();
        const at = new Date().toLocaleTimeString('ko-KR');
        const budget = lastRemaining >= 0 ? ` · 잔여 한도 ${lastRemaining.toLocaleString()}` : '';
        console.log(
          chalk.dim(
            `    ${at} · 감시 중 (레포 ${watchedRepos} · 열린 PR ${openCount}건, ${cost} point)${budget}`,
          ),
        );
      }

      return reviewRan;
    };

    /**
     * 남은 GraphQL 한도에 맞춰 다음 대기 시간을 정한다.
     *
     * 비용은 레포 수가 아니라 **직전 사이클이 실제로 쓴 point 합계**로 계산한다.
     * awaiting PR 이 많으면 alias 가 청크로 나뉘어 레포당 1 을 넘기 때문에,
     * 레포 수로 추정하면 실제 소모를 과소평가한다.
     */
    const nextDelay = (): number => {
      const base = cfg.watchIntervalMs;
      if (lastRemaining < 0) return base;

      // 폴백도 설정값(watchRepos)이 아니라 실제로 폴링한 레포 수를 쓴다.
      // 계정 모드에서는 watchRepos 가 비어 있고 레포 수는 실행 중에 늘어난다.
      const perScan = Math.max(1, lastCycleCost || watchedRepos);
      const scansPerHour = 3_600_000 / base;
      const needed = perScan * scansPerHour;
      const budget = lastRemaining * RATE_BUDGET_RATIO;
      if (needed <= budget) return base;

      const scaled = Math.ceil((perScan * 3_600_000) / Math.max(1, budget));
      console.log(
        chalk.yellow(
          `    ⚠ 잔여 한도 ${lastRemaining.toLocaleString()} — 주기를 ${formatDuration(scaled)} 로 자동 상향`,
        ),
      );
      return scaled;
    };

    // --once 는 "1회 스캔" 이므로 그 스캔에서 나온 큐를 끝까지 소진한다.
    await loop(opts.once);

    if (opts.once) {
      await driver.close();
      return;
    }

    // 사이클이 끝난 뒤에 다음 스캔을 예약한다.
    //
    // setInterval 은 리뷰 한 건이 폴링 간격보다 오래 걸릴 때 (실측 9~15분 vs 5분)
    // 사이클을 겹치게 만들었다. 겹친 사이클들은 같은 PR 을 동시에 리뷰해 중복
    // 리뷰를 게시하고, 브라우저 페이지 하나를 서로 다투다 전송·수신에도 실패했다.
    let stopped = false;
    let timer: NodeJS.Timeout | null = null;

    // 리뷰를 실행한 사이클 직후에는 대기 없이 재스캔한다.
    // 라운드는 2~15분 걸리므로 그 사이에 쌓인 변화를 바로 확인해야 한다.
    // (이걸 안 하면 15분 라운드 뒤 다시 폴링 주기를 기다려 꼬리 지연이 붙는다)
    const scheduleNext = (delayMs: number): void => {
      if (stopped) return;
      timer = setTimeout(async () => {
        if (stopped) return;
        let reviewRan = false;
        try {
          reviewRan = await loop(false);
        } catch (e) {
          console.error(chalk.red('  ✗ 스캔 실패:'), e instanceof Error ? e.message : String(e));
        }
        scheduleNext(reviewRan ? 0 : nextDelay()); // 사이클 종료 후에만 다음 예약
      }, delayMs);
    };

    console.log(
      chalk.dim(
        `\n  ${formatDuration(cfg.watchIntervalMs)}마다 스캔합니다 (리뷰 직후에는 즉시 재스캔). Ctrl+C 로 종료.\n`,
      ),
    );
    scheduleNext(cfg.watchIntervalMs);

    const cleanup = async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await driver.close();
      process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  });

// ── queue ──

program
  .command('queue')
  .description('리뷰 대기열 조회 — watch 가 처리할 순서대로')
  .option('--json', 'JSON 으로 출력 (UI/스크립트 연동용)', false)
  .action((opts: { json: boolean }) => {
    const cfg = loadConfig();
    ensureDataDir(cfg);

    // 큐는 저장되지 않는다 — 컨텍스트에서 매번 다시 계산한다 (queue.ts 참고).
    const all = listContexts(cfg);
    const entries = buildQueue(all);
    const blockedUntil = quotaGateUntil(all);

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            blockedUntil: blockedUntil ? new Date(blockedUntil).toISOString() : null,
            entries: entries.map((e: QueueEntry) => ({
              owner: e.ctx.owner,
              repo: e.ctx.repo,
              prNumber: e.ctx.prNumber,
              title: e.ctx.title,
              url: e.ctx.prUrl,
              round: e.ctx.round,
              tier: e.tier,
              reason: e.reason,
              waitingSince: e.waitingSince,
              waitingMs: e.waitingMs,
            })),
          },
          null,
          2,
        ),
      );
      return;
    }

    banner();
    if (blockedUntil) {
      console.log(
        chalk.magenta(
          `  ⏸ 쿼터 대기 중 — ${new Date(blockedUntil).toLocaleString('ko-KR')} 이후 재개`,
        ),
      );
      console.log(chalk.dim('    대기열은 그대로 보존됩니다.\n'));
    }
    if (entries.length === 0) {
      console.log(chalk.dim('  대기열이 비어 있습니다.\n'));
      return;
    }

    console.log(chalk.bold(`  대기열 ${entries.length}건`) + chalk.dim('  (위에서부터 처리)'));
    entries.forEach((e, i) => {
      console.log(
        `  ${String(i + 1).padStart(2)}. ${chalk.bold(`${e.ctx.owner}/${e.ctx.repo}#${e.ctx.prNumber}`)}` +
          `  ${chalk.cyan(`[${QUEUE_REASON_LABELS[e.reason]}]`)}` +
          `  ${chalk.dim(`대기 ${formatWaiting(e.waitingMs)}`)}`,
      );
      console.log(chalk.dim(`      ${e.ctx.title.slice(0, 60)}`));
    });
    console.log();
  });

// ── status ──

program
  .command('status [pr]')
  .description('추적 중인 PR 상태 조회 (pr 지정 시 상세 뷰)')
  .option('--json', 'JSON 으로 출력 (UI/스크립트 연동용)', false)
  .action((pr: string | undefined, opts: { json: boolean }) => {
    const cfg = loadConfig();
    ensureDataDir(cfg);

    // ── 전체 목록 ──
    if (!pr) {
      const all = listContexts(cfg);
      if (opts.json) {
        console.log(JSON.stringify(all, null, 2));
        return;
      }
      banner();
      if (all.length === 0) {
        console.log(chalk.dim('  추적 중인 PR 이 없습니다.\n'));
        return;
      }
      for (const c of all) {
        const threads = c.threads.length;
        const resolved = c.threads.filter((t) => t.isResolved).length;
        console.log(
          `  ● ${chalk.bold(`${c.owner}/${c.repo}#${c.prNumber}`)}  ${stateBadge(c.state)}` +
            `  ${c.round}라운드 · 요청 ${c.requestedCount}개` +
            (threads > 0 ? ` · 스레드 ${resolved}/${threads} 해결` : ''),
        );
        console.log(chalk.dim(`      ${c.title.slice(0, 60)}`));
      }
      console.log();
      return;
    }

    // ── 상세 뷰 ──
    const { owner, repo, number } = parsePRInput(pr);
    const ctx = loadContext(cfg, owner, repo, number);
    if (!ctx) {
      console.log(chalk.dim(`\n  ${owner}/${repo}#${number} — 추적 기록 없음\n`));
      return;
    }
    if (opts.json) {
      console.log(JSON.stringify(ctx, null, 2));
      return;
    }

    banner();
    console.log(chalk.bold(`  ${ctx.title}`));
    console.log(chalk.dim(`  ${ctx.prUrl}\n`));
    console.log(`  상태:       ${stateBadge(ctx.state)}`);
    console.log(`  라운드:     ${ctx.round}회 완료`);
    console.log(`  요청 누적:  ${ctx.requestedCount}개 코멘트`);
    if (ctx.conversationUrl) {
      const turns = ctx.conversationTurns ?? ctx.round - (ctx.conversationStartRound ?? ctx.round) + 1;
      console.log(`  대화:       ${ctx.conversationUrl} ${chalk.dim(`(${turns}회 전송)`)}`);
    }
    if (ctx.quotaRetryAt) {
      console.log(`  쿼터 해제:  ${new Date(ctx.quotaRetryAt).toLocaleString('ko-KR')}`);
    }
    if (ctx.lastError) console.log(chalk.red(`  마지막 오류: ${ctx.lastError.slice(0, 100)}`));
    console.log(chalk.dim(`  다음 액션:  ${NEXT_ACTION_HINTS[ctx.state]}`));

    if (ctx.threads.length > 0) {
      console.log(chalk.bold(`\n  스레드 (${ctx.threads.length})`));
      for (const t of ctx.threads) {
        const mark = t.isResolved ? chalk.green('✓') : chalk.yellow('○');
        const extra = !t.isResolved && t.authorReplied ? chalk.dim(' (답변 있음)') : '';
        console.log(`   ${mark} [${t.round}차] ${t.path}:${t.line ?? '?'} — ${chalk.dim(t.snippet.slice(0, 60))}${extra}`);
      }
    }

    if (ctx.history.length > 0) {
      console.log(chalk.bold('\n  최근 이벤트'));
      for (const h of ctx.history.slice(-8)) {
        const ts = new Date(h.at).toLocaleString('ko-KR');
        console.log(
          `   ${chalk.dim(ts)}  ${h.from} ${chalk.dim('→')} ${chalk.bold(h.to)}  ${chalk.cyan(h.event)}` +
            (h.note ? chalk.dim(`  ${h.note}`) : ''),
        );
      }
    }
    console.log();
  });

// ── graph ──

program
  .command('graph [pr]')
  .description('상태 머신 mermaid 다이어그램 출력 (pr 지정 시 현재 상태 강조)')
  .action((pr: string | undefined) => {
    const cfg = loadConfig();
    let current: PRState | undefined;
    if (pr) {
      const { owner, repo, number } = parsePRInput(pr);
      current = loadContext(cfg, owner, repo, number)?.state;
    }
    console.log('```mermaid');
    console.log(toMermaid(current));
    console.log('```');
    console.log(chalk.dim('\n  → GitHub 마크다운이나 mermaid.live 에 붙여넣으면 렌더링됩니다.\n'));
  });

// ── rounds ──

program
  .command('rounds <pr>')
  .description('특정 PR 의 리뷰 라운드 이력 조회')
  .action((pr: string) => {
    banner();
    const cfg = loadConfig();
    const { owner, repo, number } = parsePRInput(pr);
    const ctx = loadContext(cfg, owner, repo, number);

    if (!ctx) {
      console.log(chalk.dim(`  ${owner}/${repo}#${number} — 리뷰 기록 없음\n`));
      return;
    }

    console.log(chalk.bold(`  ${ctx.title}`));
    console.log(chalk.dim(`  ${ctx.prUrl}\n`));

    const posted = ctx.history.filter(
      (h) => h.event === 'POSTED_COMMENTS' || h.event === 'POSTED_CLEAN',
    );
    if (posted.length === 0) {
      console.log(chalk.dim('  완료된 리뷰 라운드가 없습니다.\n'));
      return;
    }
    posted.forEach((h, i) => {
      const ts = new Date(h.at).toLocaleString('ko-KR');
      console.log(`  ${chalk.cyan(`${i + 1}차`)}  ${ts}  ${chalk.dim(h.note ?? '')}`);
    });
    console.log();
  });

// ── run ──

// commander 의 async 액션에서 발생한 오류가 스택 트레이스로 노출되지 않도록 한다.
process.on('unhandledRejection', (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(chalk.red('\n  ✗ 오류:'), msg, '\n');
  process.exit(1);
});

program.parse();
