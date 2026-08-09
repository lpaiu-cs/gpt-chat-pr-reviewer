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
 *                     (--ui 로 localhost 관측 대시보드 동반 실행)
 *   queue             리뷰 대기열 조회 (--json)
 *   status [pr]       추적 중인 PR 상태 조회 (--json)
 *   graph [pr]        상태 머신 mermaid 다이어그램 출력
 *   rounds <pr>       특정 PR 의 리뷰 라운드 이력 조회
 */

import { spawn } from 'node:child_process';
import { Command } from 'commander';
import chalk from 'chalk';

import { loadConfig, initConfig, ensureDataDir, patchConfigFile } from './config.js';
import { ChatGPTDriver } from './chatgpt.js';
import { parsePRInput, getPRInfo, fetchRepoProbe, takeGraphQLUsage } from './github.js';
import { syncPR, syncPRFromProbe, runRound } from './reviewer.js';
import { fire, canFire, toMermaid, STATE_LABELS, NEXT_ACTION_HINTS } from './state/machine.js';
import { createContext, loadContext, saveContext, listContexts } from './state/store.js';
import { ensureInstructionsFile, readInstructionsRaw, saveInstructions } from './instructions.js';
import {
  admitsNewPR,
  createRepoSource,
  describeScope,
  invalidPRRefs,
  isRefFilterReason,
  parsePRRef,
  passesRefFilters,
  unsupportedPatterns,
  matchesScope,
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
import { progress, type ContextCard, type QueueItem } from './progress.js';
import { intents, type Intent } from './intents.js';
import { startUIServer, type UIServerHandle } from './ui/server.js';
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

/** `watch --ui` 대시보드 기본 포트. 쓰이고 있으면 서버가 다음 포트로 물러선다. */
const DEFAULT_UI_PORT = 4478;

/** PR 컨텍스트의 표시용 키. 카드·큐 항목·스캔 로그가 모두 같은 값을 써야 한다. */
function ctxKey(c: Pick<PRContext, 'owner' | 'repo' | 'prNumber'>): string {
  return `${c.owner}/${c.repo}#${c.prNumber}`;
}

/**
 * "이 PR 에 대해 이미 보고한 것과 같은 상황인가" 를 판정하는 서명.
 *
 * 계산하는 쪽(reportIfChanged)과 저장하는 쪽(리뷰 직후 캐시 갱신)이 **반드시 이
 * 함수를 함께** 써야 한다. 한쪽만 고치면 서명이 영원히 어긋나서, 아무것도 바뀌지
 * 않았는데 매 스캔마다 같은 PR 을 '변경됨' 으로 다시 찍는다 — 10초 폴링에서는
 * 그게 곧 로그 도배이고, 그 캐시가 존재하는 이유 자체가 사라진다.
 * (실제로 excludedReason 을 여기에만 더했다가 그 회귀를 냈다.)
 */
function ctxSignature(c: PRContext): string {
  return `${c.state}:${c.round}:${c.excludedReason ?? ''}`;
}

/**
 * PRContext · QueueEntry → 대시보드가 쓰는 납작한 뷰 모델.
 *
 * 여기서 변환하는 이유는 progress.ts 를 리프로 두기 위해서다 — 버스가
 * 상태 머신 라벨을 알기 시작하면 reviewer 와 machine 이 UI 를 거쳐 얽힌다.
 */
function toCard(c: PRContext): ContextCard {
  return {
    key: ctxKey(c),
    title: c.title,
    url: c.prUrl,
    state: c.state,
    stateLabel: STATE_LABELS[c.state],
    nextAction: NEXT_ACTION_HINTS[c.state],
    round: c.round,
    requestedCount: c.requestedCount,
    threadsTotal: c.threads.length,
    threadsResolved: c.threads.filter((t) => t.isResolved).length,
    excludedReason: c.excludedReason,
    quotaRetryAt: c.quotaRetryAt,
    lastError: c.lastError?.slice(0, 160),
    conversationUrl: c.conversationUrl,
    conversationTurns: c.conversationUrl ? c.conversationTurns : undefined,
    updatedAt: c.updatedAt,
  };
}

function toItem(e: QueueEntry): QueueItem {
  return {
    key: ctxKey(e.ctx),
    title: e.ctx.title,
    url: e.ctx.prUrl,
    round: e.ctx.round,
    tier: e.tier,
    reasonLabel: QUEUE_REASON_LABELS[e.reason],
    waitingSince: e.waitingSince,
  };
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
    // windowsHide: 'cmd /c start' 도 콘솔 창을 띄운다 (github.ts 의 gh 게이트웨이 참고).
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    /* 편집기 실행 실패 — 경로만 안내 */
  }
}

// ── CLI ─────────────────────────────────────────────────────

const program = new Command()
  .name('pr-review')
  .description('상태 머신 기반 ChatGPT PR 자동 리뷰')
  .version('0.3.0');

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
  .option('--observe', '감시·동기화만 하고 리뷰는 실행하지 않는다 (브라우저·한도 소비 없음)', false)
  .option('--ui', '관측 대시보드를 localhost 에 띄운다 (읽기 전용)', false)
  .option('--ui-port <port>', `대시보드 포트 (기본 ${DEFAULT_UI_PORT})`)
  .action(async (opts: {
    headless: boolean;
    dryRun: boolean;
    once: boolean;
    observe: boolean;
    ui: boolean;
    uiPort?: string;
  }) => {
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

    // 형식이 틀린 skip 항목은 아무것도 매치하지 않아 조용히 무효가 된다.
    // 제외한 줄 알았던 PR 이 리뷰되면 되돌릴 수 없으므로 시작할 때 짚어준다.
    const badRefs = invalidPRRefs(scope.filters);
    if (badRefs.length > 0) {
      console.log(
        chalk.yellow(`  ⚠ filters 형식 오류 ${badRefs.length}건 — 무시됩니다: ${badRefs.join(', ')}`),
      );
      console.log(chalk.dim("    'owner/repo#12' 형식이어야 합니다."));
    }

    const repoSource = createRepoSource(scope);

    // ── 제어 상태 (UI 의도 큐가 바꾼다) ──
    let paused = false;
    /** '지금 리뷰' 로 큐 앞으로 당긴 PR (정규화 키). 그 라운드가 돌면 빠진다. */
    const prioritized = new Set<string>();
    scope.filters ??= {};

    const publishControl = (): void => {
      progress.control({
        mode: scope.mode,
        paused,
        pendingIntents: intents.pending,
        include: [...scope.include],
        exclude: [...(scope.exclude ?? [])],
        skip: [...(scope.filters?.skip ?? [])],
        only: [...(scope.filters?.only ?? [])],
        prioritized: [...prioritized],
      });
    };

    /**
     * **지금 기준**의 제외 사유 (없으면 undefined).
     *
     * 두 갈래다. `skip`/`only` 는 UI 가 런타임에 바꾸므로 설정만 보고 **다시**
     * 판정한다. 나머지(draft/authors/labels)는 GitHub 관측값이 있어야 알 수 있어
     * 스캔이 남긴 `excludedReason` 을 그대로 쓴다.
     *
     * 이 판정이 필요한 자리가 셋이다 — 서버 검증 · review-now 적용 · probe 생략
     * 경로. 앞의 둘에 복제해 두었다가 세 번째(probe 생략)에서 빠뜨려 "방금 제외한
     * PR 이 그대로 리뷰되는" 회귀를 냈다. 그래서 하나로 묶는다.
     */
    const effectiveExclusion = (c: PRContext): string | undefined => {
      const live = passesRefFilters(ctxKey(c), scope.filters);
      if (!live.ok) return live.reason;
      return c.excludedReason && !isRefFilterReason(c.excludedReason)
        ? c.excludedReason
        : undefined;
    };

    publishControl(); // 첫 스캔 전에도 현재 필터·일시정지 상태가 화면에 보이게

    /** 바뀐 감시 범위를 설정 파일에 남긴다 (바뀐 키만 패치 — config.ts 참고). */
    const persistScope = (): void => {
      try {
        patchConfigFile({ watch: scope });
      } catch (e) {
        console.log(
          chalk.red(`  ✗ 설정 저장 실패: ${e instanceof Error ? e.message : String(e)}`),
        );
        console.log(chalk.dim('    메모리에는 적용됐지만 watch 를 재시작하면 되돌아갑니다.'));
      }
    };

    /** 정규화 키로 추적 중인 컨텍스트를 찾는다 (파일명 대소문자에 기대지 않는다). */
    const findContext = (key: string): PRContext | undefined =>
      listContexts(cfg).find((c) => parsePRRef(ctxKey(c)) === key);

    /**
     * 쌓인 제어 의도를 적용한다.
     *
     * **사이클 시작점에서만** 호출한다. 라운드가 도는 중에 감시 범위가 바뀌면
     * 그 라운드가 끝나고 저장할 때 반쯤 낡은 기준으로 판정한 결과가 섞인다.
     * HTTP 핸들러가 여기까지 들어오지 않는 이유가 이것이다 (intents.ts 참고).
     */
    const applyIntents = (): void => {
      const queued = intents.drain();
      if (queued.length === 0) return;

      // **필터 변경을 먼저 전부 적용한 뒤** review-now 를 판정한다.
      //
      // 한 배치에 [건너뛰기 B, 지금 리뷰 B] 나 [지금 리뷰 B, 건너뛰기 B] 가 함께
      // 들어올 수 있다 (라운드가 2~15분이라 그 사이 클릭이 쌓인다). 순서대로
      // 처리하면 후자에서 review-now 가 아직 skip 이 반영되기 전 기준으로 통과해
      // 상태를 전이시키고, 직후 스캔에서 큐에서 빠져 **영속 상태만 오염된다.**
      // 사용자의 최종 의사는 배치 전체를 본 결과이므로 그 기준으로 판정한다.
      const filterIntents = queued.filter((i) => i.kind !== 'review-now');
      const reviewNowIntents = queued.filter((i) => i.kind === 'review-now');

      const f = scope.filters!;
      let scopeChanged = false;

      /** skip/only 목록에서 참조 하나를 넣거나 뺀다. 저장은 정규화 키로 한다. */
      const editList = (name: 'skip' | 'only', ref: string, add: boolean): void => {
        const key = parsePRRef(ref);
        if (!key) {
          console.log(chalk.yellow(`  ⚠ 잘못된 PR 참조: "${ref}" — 'owner/repo#12' 형식이어야 합니다.`));
          return;
        }
        const list = f[name] ?? [];
        const next = list.filter((e) => parsePRRef(e) !== key);
        if (add) next.push(key);
        if (next.length === list.length && add) return; // 이미 있음
        if (next.length === list.length && !add) return; // 원래 없음
        f[name] = next;
        scopeChanged = true;
        console.log(
          chalk.cyan(`    ${add ? '추가' : '해제'}: ${name} ${key}`),
        );
      };

      for (const it of filterIntents) {
        switch (it.kind) {
          case 'pause':
            if (!paused) console.log(chalk.magenta('    ⏸ 일시정지 — 리뷰 실행만 멈춥니다 (감시·동기화는 계속).'));
            paused = true;
            break;
          case 'resume':
            if (paused) console.log(chalk.green('    ▶ 재개'));
            paused = false;
            break;
          case 'skip-add':
            editList('skip', it.ref, true);
            break;
          case 'skip-remove':
            editList('skip', it.ref, false);
            break;
          case 'only-set': {
            // 하나라도 형식이 틀리면 **아무것도 적용하지 않는다.**
            // 잘못된 것만 버리고 나머지를 쓰면, 전부 틀렸을 때 f.only = [] 가 되어
            // "이것만 리뷰" 요청이 정반대로 **기존 한정을 해제**해 버린다.
            // 막아둔 PR 들이 그대로 리뷰되는 방향의 실패라 되돌릴 수 없다.
            const bad = it.refs.filter((r) => !parsePRRef(r));
            if (bad.length > 0) {
              console.log(
                chalk.yellow(`  ⚠ 잘못된 PR 참조 — 대상 한정을 바꾸지 않습니다: ${bad.join(', ')}`),
              );
              break;
            }
            const keys = it.refs.map((r) => parsePRRef(r) as string);
            f.only = keys;
            scopeChanged = true;
            console.log(
              keys.length > 0
                ? chalk.cyan(`    리뷰 대상 한정: ${keys.join(', ')}`)
                : chalk.cyan('    리뷰 대상 한정 해제 — 범위 전체가 대상입니다.'),
            );
            break;
          }
          case 'scope-set': {
            // 빈 include 는 "감시 중지" 가 아니다. matchesScope 는 빈 목록을
            // **전부 허용**으로 읽으므로(review-requested 가 그렇게 쓴다) 오히려
            // 추적 중인 컨텍스트가 전부 lingering 으로 되살아나 계속 리뷰된다.
            // 멈추려면 일시정지를 쓴다. review-requested 는 빈 include 가 정상이다.
            if (it.include.length === 0 && scope.mode !== 'review-requested') {
              console.log(
                chalk.yellow(`  ⚠ ${scope.mode} 모드에서는 include 를 비울 수 없습니다 — 무시합니다.`),
              );
              break;
            }
            // 탐색이 펼칠 수 없는 패턴은 저장해봐야 조용히 아무것도 발견하지
            // 못한다. lingering 컨텍스트가 남아 있으면 그 실패가 한동안 가려진다.
            const bad = unsupportedPatterns(scope.mode, it.include);
            if (bad.length > 0) {
              console.log(
                chalk.yellow(`  ⚠ ${scope.mode} 모드가 펼칠 수 없는 패턴 — 무시합니다: ${bad.join(', ')}`),
              );
              break;
            }
            scope.include = it.include;
            scope.exclude = it.exclude;
            scopeChanged = true;
            // 캐시·targets 를 통째로 버린다. lastAt 만 0 으로 두면 "다시 탐색하라"
            // 일 뿐이라, 그 탐색이 부분 실패하면 nextRepoCache 가 이전 캐시를
            // 보존해 **옛 범위의 레포가 그대로 살아남는다**. 그 상태로 스캔이 돌면
            // 방금 범위에서 뺀 레포에 리뷰를 게시할 수 있고, 게시는 못 되돌린다.
            repoSource.reset();
            console.log(chalk.cyan(`    감시 범위 변경: include=${it.include.join(',') || '(없음)'}`));
            break;
          }
        }
      }

      // ── 2단계: review-now — 위에서 확정된 필터 기준으로 판정한다 ──
      for (const it of reviewNowIntents) {
        const key = parsePRRef(it.ref);
        if (!key) {
          console.log(chalk.yellow(`  ⚠ 잘못된 PR 참조: "${it.ref}"`));
          continue;
        }
        const target = findContext(key);
        if (!target) {
          console.log(chalk.yellow(`  ⚠ ${key} 는 추적 중이 아닙니다.`));
          continue;
        }
        if (target.state === 'REVIEWING') {
          console.log(chalk.dim(`    ${key} 는 이미 리뷰 중입니다.`));
          continue;
        }

        // 필터에 걸린 PR 은 **전이시키기 전에** 막는다.
        //
        // scan 이 excludedReason 붙은 컨텍스트를 eligible 에 넣지 않으므로 상태만
        // 바뀌고 리뷰는 영영 실행되지 않는다. 그냥 무동작이면 그나마 나은데,
        // AWAITING_AUTHOR/CONVERGED 였던 **영속 상태가 REVIEW_DUE 로 바뀌어 남는다.**
        // 나중에 제외를 풀면 작성자 응답도 새 커밋도 없이 리뷰가 돌아버린다.
        //
        // 일회성 우회로 만들지 않은 이유: skip 은 "확실히 하지 말 것" 이고 only
        // 보다도 강하게 잡아둔 조건이다. 버튼 하나로 뒤집히면 그 보증이 사라진다.
        //
        // 판정은 **두 갈래**다. skip/only 는 방금 1단계에서 바뀌었을 수 있으므로
        // 캐시가 아니라 지금 설정으로 다시 본다. 나머지(draft/authors/labels)는
        // GitHub 관측값이 있어야 알 수 있어 스캔이 남긴 값이 여전히 유효하다.
        const blocked = effectiveExclusion(target);
        if (blocked) {
          console.log(
            chalk.yellow(`  ⚠ ${key} 는 필터에 걸려 있습니다 (${blocked}) — 먼저 제외를 푸세요.`),
          );
          continue;
        }

        // REVIEW_DUE 가 아니면 강제로 되돌린다 — review --force 와 같은 경로다.
        if (target.state !== 'REVIEW_DUE') {
          const ev = FORCE_EVENTS[target.state];
          if (!ev || !canFire(target.state, ev)) {
            console.log(chalk.yellow(`  ⚠ ${key} 는 ${target.state} 에서 강제 실행할 수 없습니다.`));
            continue;
          }
          fire(target, ev, { note: 'UI: 지금 리뷰' });
          saveContext(cfg, target);
        }
        prioritized.add(key);
        console.log(chalk.cyan(`    지금 리뷰: ${key} — 큐 맨 앞으로 올립니다.`));
      }

      if (scopeChanged) {
        persistScope();
        progress.patch({ scope: describeScope(scope) }); // 헤더의 범위 표시도 갱신
        const bad = invalidPRRefs(scope.filters);
        if (bad.length > 0) {
          console.log(chalk.yellow(`  ⚠ 저장된 필터에 형식 오류가 남아 있습니다: ${bad.join(', ')}`));
        }
      }
      publishControl();
    };

    // ── 관측 대시보드 ──
    // 브라우저를 띄우기 **전에** 켠다. 로그인 안내나 launch 실패도 대시보드
    // 로그에 남아야 터미널을 안 보고도 무슨 일인지 알 수 있다.
    let ui: UIServerHandle | null = null;
    if (opts.ui) {
      const port = Number(opts.uiPort ?? DEFAULT_UI_PORT);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        console.log(chalk.red(`  ✗ 잘못된 포트: ${opts.uiPort}`));
        return;
      }
      try {
        ui = await startUIServer(port, {
          readInstructions: () => readInstructionsRaw(cfg),
          writeInstructions: (body) => saveInstructions(cfg, body),
          // 형식은 서버가 보고, 뜻은 여기서 본다 — 감시 범위와 모드를 아는 쪽이다.
          // 큐까지 흘려보낸 뒤 로그로만 알리면 "눌렀는데 아무 일도 안 남" 이 된다.
          validate: (intent): string | null => {
            const badRef = (r: string): string | null =>
              parsePRRef(r) ? null : `잘못된 PR 참조: "${r}" — 'owner/repo#12' 형식이어야 합니다.`;

            switch (intent.kind) {
              case 'skip-add':
              case 'skip-remove':
                return badRef(intent.ref);
              case 'review-now': {
                const bad = badRef(intent.ref);
                if (bad) return bad;
                // 필터에 걸린 PR 은 스캔이 큐에 올리지 않는다. 202 로 받아두면
                // "큐 맨 앞으로" 라고 해놓고 아무 일도 안 일어난다 (그리고 상태만
                // 바뀐다 — applyIntents 주석 참고).
                const key = parsePRRef(intent.ref) as string;
                const target = findContext(key);
                if (!target) return `${intent.ref} 는 추적 중이 아닙니다.`;
                // applyIntents 와 같은 두 갈래 판정 (skip/only 는 지금 설정,
                // 나머지는 스캔이 남긴 값). 큐에 아직 적용 대기 중인 필터 변경까지는
                // 볼 수 없으므로 최종 권한은 루프에 있고, 여기는 즉시 피드백용이다.
                const blocked = effectiveExclusion(target);
                if (blocked) {
                  return `필터에 걸려 있어 실행할 수 없습니다 (${blocked}). 먼저 제외를 푸세요.`;
                }
                return null;
              }
              case 'only-set': {
                // 하나라도 틀리면 전체를 거부한다. 일부만 적용하면 '이것만' 이
                // 기존 한정 해제로 뒤집힌다 (applyIntents 주석 참고).
                const bad = intent.refs.map(badRef).filter(Boolean);
                return bad.length > 0 ? bad.join(' / ') : null;
              }
              case 'scope-set': {
                if (intent.include.length === 0 && scope.mode !== 'review-requested') {
                  return `${scope.mode} 모드에서는 include 를 비울 수 없습니다. 감시를 멈추려면 '일시정지' 를 쓰세요.`;
                }
                // discoverRepos 와 **같은 판정**을 쓴다 (unsupportedPatterns).
                // 갈라지면 UI 는 받아주고 백엔드는 조용히 버린다.
                const bad = unsupportedPatterns(scope.mode, intent.include);
                if (bad.length > 0) {
                  return scope.mode === 'repos'
                    ? `repos 모드는 글롭을 펼칠 수 없습니다: ${bad.join(', ')} — mode 를 account 로 바꾸거나 'owner/repo' 를 그대로 적으세요.`
                    : `소유자 자리에 글롭을 쓸 수 없습니다: ${bad.join(', ')} — 검색이 'org:<owner>' 단위입니다.`;
                }
                return null;
              }
              default:
                return null;
            }
          },
        });
        progress.patch({
          startedAt: Date.now(),
          scope: describeScope(scope),
          dryRun: opts.dryRun,
        });
        console.log(chalk.cyan(`  ◆ 대시보드: ${ui.url}`) + chalk.dim('  (localhost 전용)'));
      } catch (e) {
        // 대시보드는 부가 기능이다 — 못 떠도 감시는 계속한다.
        console.log(
          chalk.yellow(`  ⚠ 대시보드를 띄우지 못했습니다: ${e instanceof Error ? e.message : String(e)}`),
        );
      }
    }

    // ── 관측 모드 ──
    // 리뷰를 실행하지 않으므로 브라우저를 아예 띄우지 않는다. ChatGPT 한도도,
    // Chrome 창도, 로그인도 필요 없다 — GitHub 폴링만 도는 완전한 무비용 모드다.
    let driver: ChatGPTDriver | null = null;
    if (opts.observe) {
      console.log(
        chalk.cyan('  ◆ 관측 모드 — 리뷰를 실행하지 않습니다') +
          chalk.dim(' (브라우저 미실행 · ChatGPT 한도 소비 없음)'),
      );
    } else {
      driver = new ChatGPTDriver(cfg);
      await driver.launch();
      await driver.navigateToChatGPT();

      const user = await driver.getSessionUser();
      if (!user) {
        console.log(chalk.red('  ✗ ChatGPT 로그인이 필요합니다. 먼저 setup 을 실행하세요.'));
        await driver.close();
        await ui?.close();
        return;
      }
      console.log(chalk.dim(`  계정: ${user.email ?? user.name}`));
      progress.patch({ account: user.email ?? user.name ?? null });
    }

    // 짧은 주기로 돌리면 매 사이클 출력은 소음이다. PR 상태가 바뀌었을 때만
    // 한 줄 찍고, 그 외에는 주기적 하트비트로만 살아있음을 알린다.
    const reported = new Map<string, string>();
    let lastHeartbeat = 0;
    let lastRemaining = -1; // 마지막 probe 가 보고한 GraphQL 잔여 한도
    let lastCycleCost = 0; // 직전 사이클이 실제로 쓴 GraphQL point 합계
    let watchedRepos = 0; // 마지막 스캔에서 실제로 폴링한 레포 수
    /** 레포별 마지막 probe 시각 — resolve 를 기다리지 않는 레포를 늦추는 기준. */
    const lastProbeAt = new Map<string, number>();
    /** 레포별 마지막으로 관측한 열린 PR 수 — probe 를 건너뛴 주기의 표시용. */
    const lastOpenAt = new Map<string, number>();

    // 쿼터 쿨다운. 큐를 버리지 않고 이 시각까지 실행만 멈춘다.
    // watch 를 재시작해도 컨텍스트에서 복원되도록 시작 시 한 번 읽어둔다.
    let quotaUntil = quotaGateUntil(listContexts(cfg)) ?? 0;
    let quotaNotified = 0;
    let observeNotified = 0;
    let pauseNotified = 0;


    const reportIfChanged = (ctx: PRContext): void => {
      const key = ctxKey(ctx);
      // 제외 사유도 서명에 넣는다 — skip 을 넣거나 뺀 것도 상태 변화로 보고해야 한다.
      const sig = ctxSignature(ctx);
      if (reported.get(key) === sig) return;
      reported.set(key, sig);
      // REVIEW_DUE 인데 필터에 걸린 PR 을 상태만 찍으면 곧 리뷰될 것처럼 보인다.
      const excluded = ctx.excludedReason ? chalk.dim(`  — 제외: ${ctx.excludedReason}`) : '';
      console.log(
        `    ${chalk.dim(`${ctx.owner}/${ctx.repo}`)}#${String(ctx.prNumber).padEnd(5)} ` +
          `${stateBadge(ctx.state)} ${chalk.dim(ctx.title.slice(0, 45))}${excluded}`,
      );
    };

    /**
     * 스캔 — 감시 범위의 모든 레포를 동기화하고, 리뷰 후보 컨텍스트를 모은다.
     * 여기서는 리뷰를 실행하지 않는다. 실행 순서는 큐가 정한다.
     */
    const scan = (): { eligible: PRContext[]; openCount: number; seen: PRContext[] } => {
      progress.cycle({ scanning: true });
      // 한 스캔 안에서는 같은 시각을 쓴다 — 레포마다 now 가 달라지면 주기 판정이
      // 미세하게 어긋나 어떤 레포는 매번 한 박자씩 밀린다.
      const now = Date.now();
      const discovered = repoSource.list();
      const all = listContexts(cfg);

      // 검색은 "열린 PR 이 있는 레포" 만 돌려준다. 어떤 레포의 마지막 PR 이 닫히면
      // 그 레포가 목록에서 사라지고, 추적 중이던 컨텍스트는 PR_CLOSED 를 못 받아
      // AWAITING_AUTHOR 같은 상태로 영원히 남는다. 아직 살아있는 컨텍스트가 있는
      // 레포는 범위 안이라면 계속 훑어서 종료까지 정리한다.
      const lingering = [
        ...new Set(
          all.filter((c) => c.state !== 'CLOSED').map((c) => `${c.owner}/${c.repo}`),
        ),
      ].filter(
        (s) => !discovered.includes(s) && matchesScope(s, scope.include, scope.exclude ?? []),
      );

      const repos = [...discovered, ...lingering];
      const eligible: PRContext[] = [];
      let probedRepos = 0;
      // 이번 스캔이 실제로 손댄 컨텍스트. 대시보드는 이걸 그대로 보여준다.
      // listContexts 를 다시 읽지 않는 이유: 여기서 ctx.title·excludedReason 을
      // 이벤트 없이 갱신하는 경로가 있어 디스크가 아직 최신이 아닐 수 있다.
      const seen: PRContext[] = [];
      let openCount = 0;

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

        // ── probe 주기 판정 ──
        //
        // probe 는 **레포당** 1 point 라 비용이 레포 수에 선형 비례한다 (실측: PR
        // 개수·alias 와 무관하게 항상 1). 레포 20개면 10초 주기가 시간당 7,200 point
        // 로 한도를 넘는다.
        //
        // 그런데 10초가 정말 필요한 건 `AWAITING_AUTHOR` 레포뿐이다 — 작성자가 방금
        // 응답했고 사람이 결과를 기다리는 상태다. 나머지에서 probe 가 잡는 것(새 PR ·
        // 새 커밋 · 닫힘)은 몇십 초 늦어도 무해하다. 라운드 자체가 2~15분이다.
        const hot = needThreads.length > 0;
        const since = now - (lastProbeAt.get(repoSlug) ?? 0);
        if (!hot && since < cfg.probeIdleIntervalMs) {
          // GitHub 을 부르지 않을 뿐, **이미 아는 컨텍스트는 그대로 큐에 남긴다.**
          // 여기서 빼면 REVIEW_DUE PR 이 건너뛴 주기마다 큐에서 사라져 리뷰 시작이
          // 들쭉날쭉해진다. 새 정보가 없을 뿐 판정이 바뀐 게 아니다.
          openCount += lastOpenAt.get(repoSlug) ?? tracked.length;
          for (const c of tracked) {
            // excludedReason 은 probe 경로에서만 갱신된다. 건너뛰는 동안 사용자가
            // 건너뛰기/이것만을 눌렀다면 그 값은 낡았고, 그대로 믿으면 **방금 제외한
            // PR 을 리뷰해 버린다.** skip 은 "확실히 하지 말 것" 이라 즉시 들어야 한다.
            const reason = effectiveExclusion(c);
            if (reason) c.excludedReason = reason;
            else delete c.excludedReason;
            seen.push(c);
            if (!reason) eligible.push(c);
          }
          continue;
        }

        let probe;
        try {
          probe = fetchRepoProbe(repoSlug, needThreads);
        } catch {
          console.log(chalk.yellow(`  ⚠ ${repoSlug} probe 실패 — 건너뜁니다.`));
          continue;
        }
        lastProbeAt.set(repoSlug, now);
        lastOpenAt.set(repoSlug, probe.prs.length);
        probedRepos++;
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
            seen.push(c);
          }
        }

        for (const pr of probe.prs) {
          const existing = loadContext(cfg, pr.owner, pr.repo, pr.number);
          const verdict = passesFilters(pr, scope.filters);

          if (pr.labelsTruncated && scope.filters?.labels?.length) {
            console.log(
              chalk.yellow(
                `  ⚠ ${repoSlug}#${pr.number} 라벨 목록이 잘렸습니다 — 라벨 조건을 확정할 수 없어 제외하지 않고 통과시킵니다.`,
              ),
            );
          }

          // 새로 추적을 시작할지의 판정.
          //
          // 필터에 걸린 PR 과 리뷰 요청받지 않은 PR 은 추적 자체를 시작하지 않는다.
          // 반대로 **이미 추적 중이면 계속 간다** — 리뷰를 게시하면 GitHub 이 리뷰
          // 요청을 해제하므로, 검색 결과만 믿으면 1차 라운드 직후 대상에서 빠져
          // 2차 라운드가 영영 오지 않는다.
          const admitted = verdict.ok && admitsNewPR(repoSource.targets, repoSlug, pr.number);
          if (!existing && !admitted) continue;

          const ctx = existing ?? createContext(pr);
          ctx.title = pr.title;
          // 필터 판정을 컨텍스트에 남긴다 — queue 명령이 GitHub 을 다시 부르지 않고도
          // watch 와 같은 답을 낼 수 있어야 한다.
          if (verdict.ok) delete ctx.excludedReason;
          else ctx.excludedReason = verdict.reason;

          // 1단계: probe 만으로 전이 판정 (API 추가 호출 없음)
          const needsFull = syncPRFromProbe(cfg, ctx, pr);

          // 2단계: 모르는 스레드가 생겼을 때만 전체 동기화
          if (needsFull) syncPR(cfg, ctx);

          reportIfChanged(ctx);
          seen.push(ctx);
          if (verdict.ok) eligible.push(ctx);
        }
      }

      // 실제로 GitHub 을 부른 레포 수. nextDelay 의 비용 추정과 대시보드 표시가
      // 둘 다 이 값을 봐야 "왜 이만큼 썼는지" 가 맞는다.
      watchedRepos = probedRepos;
      progress.cycle({ scanning: false, lastScanAt: Date.now() });
      return { eligible, openCount, seen };
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
      progress.cycle({ lastCost: usage.cost, remaining: usage.remaining });
      return usage.cost;
    };

    /** 대시보드에 이번 스캔 결과를 반영한다 (UI 가 꺼져 있으면 no-op). */
    const publish = (
      seen: PRContext[],
      queue: QueueEntry[],
      openCount: number,
      quotaAt: number,
    ): void => {
      if (!progress.enabled) return;
      progress.patch({
        queue: queue.map(toItem),
        // CLOSED 를 걸러내지 않는다. seen 은 이번 스캔이 손댄 것만 담는데,
        // CLOSED 컨텍스트는 PR_CLOSED 가 발화된 **그 한 번의 스캔**에서만 들어온다
        // (이후로는 tracked·lingering 이 둘 다 CLOSED 를 제외한다). 여기서 지우면
        // 소비자 입장에서는 카드가 조용히 사라질 뿐 종료를 관측할 방법이 없어져
        // notify 의 closed 이벤트가 영영 발생하지 않는다. 누적 걱정은 없다 —
        // 다음 스캔의 seen 에는 이미 없다.
        contexts: seen.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(toCard),
        quotaUntil: quotaAt > Date.now() ? quotaAt : null,
      });
      progress.cycle({ openCount, watchedRepos });
      publishControl();
    };

    const loop = async (drain: boolean): Promise<boolean> => {
      // 사이클 시작 시점에 카운터를 비운다. 레포 탐색·probe 뿐 아니라 폴백 전체
      // 동기화·닫힘 확인·게시 후 동기화까지 모든 GraphQL 경로가 여기에 집계된다.
      takeGraphQLUsage();

      // 제어 의도는 스캔 직전에만 적용한다 — 라운드가 돌지 않는 유일한 지점이다.
      applyIntents();

      const { eligible, openCount, seen } = scan();

      // '지금 리뷰' 로 지목된 PR 을 맨 앞으로. sort 는 안정적이므로 그 안에서는
      // buildQueue 가 매긴 원래 우선순위가 그대로 유지된다.
      const isPrioritized = (e: QueueEntry): boolean =>
        prioritized.has(parsePRRef(ctxKey(e.ctx)) ?? '');
      const queue = buildQueue(eligible).sort(
        (a, b) => Number(isPrioritized(b)) - Number(isPrioritized(a)),
      );

      // ── 쿼터 게이트: 큐는 보존하고 실행만 멈춘다 ──
      // 컨텍스트에서 다시 읽어 review 명령 등 다른 경로가 걸린 한도도 반영한다.
      // dry-run 은 상태를 전이시키지 않으므로 메모리 값도 함께 본다.
      quotaUntil = Math.max(quotaUntil, quotaGateUntil(eligible) ?? 0);
      publish(seen, queue, openCount, quotaUntil);

      // ── 관측 모드: 큐는 만들되 실행하지 않는다 ──
      // 쿼터 게이트보다 앞선다 — 리뷰를 안 하니 한도는 애초에 무관하다.
      if (opts.observe) {
        tally();
        if (queue.length > 0 && Date.now() - observeNotified > HEARTBEAT_MS) {
          observeNotified = Date.now();
          console.log(
            chalk.cyan(`    관측 모드 — 대기열 ${queue.length}건을 표시만 하고 실행하지 않습니다.`),
          );
        }
        return false;
      }

      // ── 일시정지: 감시·동기화는 계속하고 실행만 멈춘다 ──
      if (paused) {
        tally();
        if (queue.length > 0 && Date.now() - pauseNotified > HEARTBEAT_MS) {
          pauseNotified = Date.now();
          console.log(chalk.magenta(`    ⏸ 일시정지 중 — 대기열 ${queue.length}건 보존`));
        }
        return false;
      }

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
        progress.beginReview({
          key: ctxKey(ctx),
          title: ctx.title,
          url: ctx.prUrl,
          round: ctx.round + 1,
          reasonLabel: QUEUE_REASON_LABELS[reason],
          dryRun: opts.dryRun,
        });
        let outcome;
        try {
          outcome = await runRound(cfg, driver, ctx, { dryRun: opts.dryRun });
        } finally {
          // runRound 는 스스로 던지지 않도록 만들어져 있지만, 만약 새어 나오면
          // 대시보드가 끝난 리뷰를 영원히 "진행 중" 으로 붙잡고 있게 된다.
          progress.endReview();
        }
        reported.set(ctxKey(ctx), ctxSignature(ctx));
        // 앞당기기는 1회성이다 — 돌고 나면 평소 우선순위로 돌아간다.
        prioritized.delete(parsePRRef(ctxKey(ctx)) ?? '');
        publishControl();
        reviewRan = true;
        publish(seen, buildQueue(eligible), openCount, quotaUntil);

        if (outcome === 'quota') {
          // 한도는 계정 단위라 남은 큐도 지금은 못 돈다. 버리지 않고 미룬다.
          quotaUntil = Date.now() + cfg.quotaCooldownMs;
          quotaNotified = Date.now();
          progress.patch({ quotaUntil });
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
      await driver?.close();
      await ui?.close();
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
      progress.cycle({ nextScanAt: Date.now() + delayMs });
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
      await driver?.close();
      await ui?.close();
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
    //
    // watch 와 같은 범위·필터를 적용해야 "watch 가 처리할 대기열" 이라는 말이
    // 사실이 된다. 범위는 여기서 글롭으로 판정하고, draft/라벨 필터는 스캔이
    // 남겨둔 excludedReason 을 buildQueue 가 읽는다 (GitHub 재조회 없음).
    // 범위 설정이 없으면 watch 자체가 돌지 않는다. 그런 상태에서 저장 컨텍스트를
    // 실행 대기열로 보여주면 처리될 수 없는 PR 을 처리될 것처럼 광고하게 된다.
    const scope = resolveWatchScope(cfg);
    const all = listContexts(cfg);
    const inScope = (c: PRContext): boolean =>
      !!scope && matchesScope(`${c.owner}/${c.repo}`, scope.include, scope.exclude ?? []);

    const scoped = all.filter(inScope);
    const entries = buildQueue(scoped);
    const blockedUntil = quotaGateUntil(scoped);

    // 숨긴 것은 반드시 세어서 알린다 — 조용히 빠지면 "대기열 0건" 이 거짓이 된다.
    const hiddenOutOfScope = all.filter((c) => c.state === 'REVIEW_DUE' && !inScope(c)).length;
    const hiddenFiltered = scoped.filter(
      (c) => c.state === 'REVIEW_DUE' && !!c.excludedReason,
    ).length;

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            blockedUntil: blockedUntil ? new Date(blockedUntil).toISOString() : null,
            // false 면 watch 가 돌 수 없는 상태다 — 소비자가 "대기열 0건" 을
            // 정상으로 오해하지 않도록 설정 미완료를 명시한다.
            scopeConfigured: !!scope,
            hidden: { outOfScope: hiddenOutOfScope, filtered: hiddenFiltered },
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
    if (!scope) {
      console.log(chalk.red('  ✗ 감시 범위가 설정되지 않았습니다 — watch 가 처리할 대기열이 없습니다.'));
      console.log(chalk.dim('    pr-review.config.json 의 watch.include 를 채우세요.'));
      if (hiddenOutOfScope > 0) {
        console.log(chalk.dim(`    (추적 기록은 ${hiddenOutOfScope}건 있지만 범위 밖입니다 — status 로 확인하세요.)`));
      }
      console.log();
      return;
    }
    if (blockedUntil) {
      console.log(
        chalk.magenta(
          `  ⏸ 쿼터 대기 중 — ${new Date(blockedUntil).toLocaleString('ko-KR')} 이후 재개`,
        ),
      );
      console.log(chalk.dim('    대기열은 그대로 보존됩니다.\n'));
    }
    /** 범위·필터로 감춘 항목을 알린다 (조용히 빠지면 대기열이 거짓말을 한다). */
    const reportHidden = (): void => {
      if (hiddenOutOfScope > 0) {
        console.log(chalk.dim(`  · 감시 범위 밖 ${hiddenOutOfScope}건은 표시하지 않았습니다.`));
      }
      if (hiddenFiltered > 0) {
        console.log(chalk.dim(`  · 필터에 걸린 ${hiddenFiltered}건은 표시하지 않았습니다.`));
      }
    };

    if (entries.length === 0) {
      console.log(chalk.dim('  대기열이 비어 있습니다.'));
      reportHidden();
      console.log();
      return;
    }

    console.log(chalk.bold(`  대기열 ${entries.length}건`) + chalk.dim('  (위에서부터 처리)'));
    entries.forEach((e, i) => {
      console.log(
        `  ${String(i + 1).padStart(2)}. ${chalk.bold(ctxKey(e.ctx))}` +
          `  ${chalk.cyan(`[${QUEUE_REASON_LABELS[e.reason]}]`)}` +
          `  ${chalk.dim(`대기 ${formatWaiting(e.waitingMs)}`)}`,
      );
      console.log(chalk.dim(`      ${e.ctx.title.slice(0, 60)}`));
    });
    reportHidden();
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
