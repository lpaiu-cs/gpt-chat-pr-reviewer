#!/usr/bin/env node

/**
 * 스킬용 데몬 클라이언트 — **켜는 것만 한다.**
 *
 * 여러 세션이 각자 이 스크립트를 부른다. 그래서 여기 있는 동사는 전부
 * (1) 멱등이거나 (2) PR 하나에만 작용한다. 전역에 작용하는 동사 —
 * 종료·일시정지·`scope-set`·`only-set` — 는 **의도적으로 없다.**
 *
 * 문서에 "부르지 마세요" 라고 적는 방식은 쓰지 않았다. 세션 A 가 세션 B 의
 * 리뷰를 멈추거나 감시 범위를 통째로 갈아 끼우는 사고는 한 번이면 충분히
 * 비싸고, 규칙은 잊히지만 없는 기능은 부를 수 없다. 사람이 데몬을 끄는
 * 경로는 따로 있다 (대시보드 종료 버튼 · `npm run dev -- stop`).
 *
 * 의존성 없음 · 빌드 불필요 — notify.mjs 와 같은 이유다. 이 스크립트는 다른
 * 레포에서 일하는 세션이 부르므로 tsx·dist 준비 상태를 가정할 수 없다.
 *
 *   node scripts/daemon.mjs ensure
 *   node scripts/daemon.mjs status [--pr owner/repo#12] [--json]
 *   node scripts/daemon.mjs review owner/repo#12
 *   node scripts/daemon.mjs skip   owner/repo#12
 *   node scripts/daemon.mjs wait   owner/repo#12 [--timeout 2700]
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, openSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── 설치 위치 ───────────────────────────────────────────────
//
// 자기 파일 위치에서 구한다. 스킬은 절대 경로로 이 파일을 부르므로 (설치 시
// 경로가 박힌다) 어떤 cwd 에서 불려도 맞는다. 홈 디렉터리에 설치 위치를
// 따로 기록하는 방식은 쓰지 않았다 — 파일이 하나 더 늘고, 그게 낡으면
// 아무것도 안 되는데 지금 방식은 낡을 수가 없다.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_UI_PORT = 4478;
/** UI 서버가 포트 충돌 시 물러서는 칸 수 (startUIServer 와 같아야 한다). */
const UI_PORT_WALK = 10;
/** 데몬이 떠서 /api/state 를 열 때까지 기다리는 시간. 브라우저 기동을 포함한다. */
const START_TIMEOUT_MS = 90_000;
const POLL_MS = 1_000;

function config() {
  const f = path.join(ROOT, 'pr-review.config.json');
  try {
    return JSON.parse(readFileSync(f, 'utf-8'));
  } catch {
    return {};
  }
}

function dataDir() {
  return path.resolve(ROOT, config().dataDir ?? './data');
}

/**
 * 이 설치본의 식별자 — `src/daemon-file.ts` 의 `instanceId` 와 **같은 계산**이다.
 * 갈라지면 클라이언트가 자기 데몬을 못 알아본다.
 */
function instanceId() {
  return createHash('sha1').update(dataDir()).digest('hex').slice(0, 16);
}

/** 실행 중인 데몬의 주소·신원. watch 가 기동 시 쓰고 종료 시 지운다. */
function daemonFile() {
  return path.join(dataDir(), 'daemon.json');
}

function readDaemonFile() {
  try {
    return JSON.parse(readFileSync(daemonFile(), 'utf-8'));
  } catch {
    return null;
  }
}

// ── 인자 ────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const VERB = argv[0];
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
/** 플래그가 아닌 위치 인자들 (동사 제외). */
function positionals() {
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      // 값을 받는 플래그면 그 값도 건너뛴다
      if (['--pr', '--timeout', '--until', '--since-round'].includes(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

const JSON_OUT = flag('--json');

function out(human, data) {
  if (JSON_OUT) console.log(JSON.stringify(data));
  else console.log(human);
}

function die(msg, data = {}) {
  if (JSON_OUT) console.log(JSON.stringify({ ok: false, error: msg, ...data }));
  else console.error(msg);
  process.exit(1);
}

// ── PR 참조 ─────────────────────────────────────────────────

/**
 * `owner/repo#12` · PR URL · `owner/repo` 를 받아 정규형으로 바꾼다.
 *
 * 세션은 방금 만든 PR 의 URL 을 손에 들고 있는 경우가 많아서 URL 을 그대로
 * 받는 게 실수를 줄인다.
 */
function parseRef(raw) {
  const s = String(raw ?? '').trim();
  const url = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i.exec(s);
  if (url) return { slug: `${url[1]}/${url[2]}`, number: Number(url[3]) };
  const hash = /^([^/\s]+\/[^/#\s]+)#(\d+)$/.exec(s);
  if (hash) return { slug: hash[1], number: Number(hash[2]) };
  const repo = /^([^/\s]+\/[^/#\s]+)$/.exec(s);
  if (repo) return { slug: repo[1], number: null };
  return null;
}

const refKey = (r) => (r.number === null ? r.slug : `${r.slug}#${r.number}`);

// ── HTTP ────────────────────────────────────────────────────

async function getState(ui, timeoutMs = 3_000) {
  const ctl = AbortSignal.timeout(timeoutMs);
  const res = await fetch(`${ui}/api/state`, { signal: ctl });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function postIntent(ui, body) {
  const res = await fetch(`${ui}/api/intent`, {
    method: 'POST',
    // Origin 을 붙이지 않는다. 서버는 "Origin 이 **있으면** 우리 것이어야 한다"
    // 로 검사하므로 헤더가 없는 비브라우저 클라이언트는 그대로 통과한다.
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    throw new Error(json.error ?? `HTTP ${res.status}`);
  }
  return json;
}

/**
 * **이 설치본의** 살아 있는 데몬을 찾는다. 없으면 null.
 *
 * 포트가 열려 있다는 것만으로 받아들이면 안 된다. 잠금은 dataDir 단위인데
 * 대시보드 포트는 머신 전체에서 공유되므로, 체크아웃이 둘이면(worktree 포함)
 * 4478·4479 에 서로 다른 설치본의 데몬이 동시에 뜬다. 그대로 붙으면 **남의
 * 설정·계정으로** 리뷰를 요청하게 되고, 그건 게시된 뒤에야 드러난다.
 *
 * instance 를 밝히지 않는 데몬은 **거부한다.** 구버전이라는 뜻인데, 모르는
 * 값으로 전진하는 게 정확히 막으려던 사고다. 재시작하면 풀린다.
 */
async function findDaemon() {
  const recorded = readDaemonFile()?.ui;
  const want = instanceId();
  const candidates = [];
  if (recorded) candidates.push(recorded);
  // 기록이 없거나 낡았을 수 있다 — UI 는 포트가 막히면 옆으로 물러선다.
  for (let i = 0; i < UI_PORT_WALK; i++) {
    const u = `http://127.0.0.1:${DEFAULT_UI_PORT + i}`;
    if (u !== recorded) candidates.push(u);
  }
  let sawStranger = false;
  for (const ui of candidates) {
    try {
      const s = await getState(ui, 1_500);
      if (!s || !s.snapshot) continue;
      if (s.snapshot.instance === want) return { ui, mode: s.snapshot.mode ?? 'review' };
      sawStranger = true;
    } catch {
      /* 다음 후보 */
    }
  }
  if (sawStranger) {
    process.stderr.write(
      '  (다른 설치본 또는 구버전 데몬이 같은 포트 대역에 떠 있습니다 — 붙지 않습니다)\n',
    );
  }
  return null;
}

// ── 기동 ────────────────────────────────────────────────────

/**
 * 데몬을 백그라운드로 띄운다.
 *
 * **경쟁해도 안전하다.** 여러 세션이 동시에 여기 들어와도 `src/lock.ts` 의
 * 포트 잠금이 하나만 통과시키고 나머지는 즉시 죽는다. 그래서 "이미 떠 있나"
 * 를 먼저 확인하고 조율하는 절차가 필요 없다 — 확인은 어차피 경쟁 구간을
 * 못 없애고, 없앨 필요도 없다. 띄우고 나서 **누구의 것이든** 살아 있는
 * 데몬에 붙으면 된다.
 */
function launch() {
  mkdirSync(dataDir(), { recursive: true });
  const log = openSync(path.join(dataDir(), 'watch.log'), 'a');

  // **소스가 있으면 소스를 쓴다.** `dist/` 는 gitignore 대상이라 브랜치를 바꾸거나
  // 새로 pull 한 체크아웃에 낡은 빌드가 그대로 남아 있을 수 있다. 그걸 띄우면
  // 구버전 서버가 뜨고, 새 클라이언트의 intent 가 거부돼 스킬이 조용히 안 된다.
  // 존재 여부는 신선도가 아니다.
  const src = path.join(ROOT, 'src', 'cli.ts');
  const args = existsSync(src)
    ? ['--import', 'tsx', src, 'watch', '--ui']
    : [path.join(ROOT, 'dist', 'cli.js'), 'watch', '--ui'];

  const child = spawn(process.execPath, args, {
    cwd: ROOT, // dataDir·설정 파일 경로가 cwd 상대다
    detached: true, // 세션이 끝나도 데몬은 남는다
    windowsHide: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  return child.pid;
}

/**
 * 데몬을 찾는다. `start` 가 참일 때만 없으면 띄운다.
 *
 * **관측용 동사는 띄우지 않는다.** 일반 watch 는 브라우저를 열고 범위 안의
 * REVIEW_DUE PR 을 자동으로 리뷰한다 — 상태만 보려던 호출이 ChatGPT 한도를
 * 쓰고 GitHub 에 리뷰를 게시하면, 그건 요청한 적 없는 부작용이다. 비용을
 * 만드는 것은 비용을 의도한 동사(`review`)뿐이다.
 */
async function ensure({ start = false } = {}) {
  const found = await findDaemon();
  if (found) return { ...found, started: false };
  if (!start) {
    die(
      '이 설치본의 리뷰 데몬이 돌고 있지 않습니다.\n' +
        `  시작하려면 (브라우저·ChatGPT 한도를 씁니다):  node "${path.join(ROOT, 'scripts', 'daemon.mjs').replace(/\\/g, '/')}" review <PR>\n` +
        `  또는 ${ROOT} 에서  npm run dev -- watch --ui`,
    );
  }

  launch();
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const d = await findDaemon();
    if (d) return { ...d, started: true };
    if (Date.now() >= deadline) {
      die(
        `데몬이 ${Math.round(START_TIMEOUT_MS / 1000)}초 안에 뜨지 않았습니다.\n` +
          `로그를 확인하세요: ${path.join(dataDir(), 'watch.log')}\n` +
          `(ChatGPT 로그인이 만료됐다면 사람이 개입해야 합니다 — ` +
          `${ROOT} 에서 \`npm run setup\`)`,
      );
    }
  }
}

/**
 * 데몬을 **새로 띄웠을 때만** 낸다: 관찰 창구와 **끄는 법**.
 *
 * 스킬에는 끄는 동사가 없다. 그러니 켜는 순간 끄는 법을 같이 보여주지 않으면
 * 사용자는 자기 머신에서 도는 프로세스를 끝낼 방법을 모르게 된다. 세션이
 * 띄웠어도 수명은 사용자 것이다.
 */
function startedNotice(ui) {
  return [
    `PR 리뷰 데몬을 새로 시작했습니다.`,
    ``,
    `  대시보드   ${ui}`,
    `  종료       ${ui} 우측 상단 “종료” 버튼`,
    `             또는 ${ROOT} 에서  npm run dev -- stop`,
    `  로그       ${path.join(dataDir(), 'watch.log')}`,
    ``,
    `데몬은 세션이 끝나도 계속 돕니다. 종료는 사용자가 결정합니다.`,
  ].join('\n');
}

// ── 상태 조회 ───────────────────────────────────────────────

function cardsFor(state, ref) {
  const cards = state.snapshot?.contexts ?? [];
  if (!ref) return cards;
  const want = refKey(ref).toLowerCase();
  return cards.filter((c) => {
    const k = String(c.key).toLowerCase();
    return ref.number === null ? k.split('#')[0] === want : k === want;
  });
}

function describeCard(c) {
  const bits = [`${c.round}라운드`];
  if (c.requestedCount) bits.push(`요청 ${c.requestedCount}개`);
  if (c.threadsTotal) bits.push(`스레드 ${c.threadsResolved}/${c.threadsTotal}`);
  if (c.excludedReason) bits.push(`제외: ${c.excludedReason}`);
  if (c.lastError) bits.push(c.lastError);
  return `${c.key}  ${c.stateLabel ?? c.state}  ${bits.join(' · ')}`;
}

// ── 동사 ────────────────────────────────────────────────────

async function verbEnsure() {
  const { ui, started, mode } = await ensure({ start: true });
  if (JSON_OUT) {
    console.log(JSON.stringify({ ok: true, ui, started, mode, root: ROOT }));
    return;
  }
  if (started) console.log(startedNotice(ui));
  else console.log(`데몬이 이미 돌고 있습니다 — ${ui} (${mode})`);
}

async function verbStatus() {
  const found = await findDaemon();
  if (!found) {
    out('이 설치본의 데몬이 돌고 있지 않습니다.', { ok: true, running: false });
    return;
  }
  const { ui } = found;
  const state = await getState(ui);
  const ref = value('--pr', null) ? parseRef(value('--pr', null)) : null;
  if (value('--pr', null) && !ref) die(`잘못된 PR 참조: ${value('--pr', null)}`);

  const cards = cardsFor(state, ref);
  const active = state.snapshot?.active ?? null;

  if (JSON_OUT) {
    console.log(JSON.stringify({ ok: true, running: true, ui, active, contexts: cards }));
    return;
  }
  console.log(`데몬 ${ui} · 범위 ${state.snapshot?.scope ?? '미설정'}`);
  if (active) console.log(`  진행 중: ${active.key} ${active.round}차 (${active.phase})`);
  if (cards.length === 0) console.log('  추적 중인 PR 이 없습니다.');
  for (const c of cards) console.log(`  · ${describeCard(c)}`);
}

/**
 * 감시 범위는 **클라이언트가 넓히지 않는다.**
 *
 * 범위는 레포 단위다. PR 하나를 부탁하려고 `owner/repo` 를 넣으면 그 레포의
 * **다른 열린 PR 까지** 큐 자격을 얻는다 — 상태만 보려던 요청이 #13 에 리뷰를
 * 게시할 수 있고, 게시는 되돌릴 수 없다. 출력으로 경고해봐야 이미 보낸 의도를
 * 막지 못한다. 그래서 넓히는 일은 사람이 설정이나 대시보드로 한다.
 */
function outOfScope(key) {
  return (
    `${key} 는 감시 범위 밖입니다.\n` +
    `  이 레포를 감시하려면 사용자가 범위를 넓혀야 합니다 —\n` +
    `  대시보드의 '감시 범위' 또는 ${ROOT}/pr-review.config.json 의 watch.include.\n` +
    `  (레포를 넣으면 그 레포의 다른 열린 PR 도 리뷰 대상이 되므로 사람이 정합니다)`
  );
}

async function verbSkip() {
  const ref = parseRef(positionals()[0]);
  if (!ref || ref.number === null) die('건너뛸 PR 을 owner/repo#12 형식으로 지정하세요.');
  const { ui } = await ensure({ start: false });
  await postIntent(ui, { kind: 'skip-add', ref: refKey(ref) });
  out(`${refKey(ref)} 는 리뷰하지 않습니다.`, { ok: true, skipped: refKey(ref) });
}

async function verbReview() {
  const ref = parseRef(positionals()[0]);
  if (!ref || ref.number === null) die('리뷰할 PR 을 owner/repo#12 형식으로 지정하세요.');
  const key = refKey(ref);
  // 비용을 의도한 동사다 — 데몬이 없으면 여기서 띄운다.
  const { ui, started, mode } = await ensure({ start: true });
  if (started && !JSON_OUT) console.log(startedNotice(ui) + '\n');

  // 관측 모드 데몬은 큐만 쌓고 실행하지 않는다. 202 를 받아두면 "요청했다" 고
  // 답해놓고 영영 아무 일도 안 일어난다 — 재시작은 사람이 결정할 일이므로
  // 여기서는 사실만 알리고 멈춘다.
  if (mode === 'observe') {
    die(
      `데몬이 관측 모드(--observe)로 떠 있어 리뷰를 실행하지 않습니다.\n` +
        `  리뷰가 필요하면 사용자가 데몬을 --observe 없이 다시 띄워야 합니다.`,
      { mode },
    );
  }

  // **이미 추적 중인 PR 만 리뷰한다.** 범위를 넓히지 않으므로 여기 없으면
  // 그건 사람이 결정할 일이다 (outOfScope 주석 참고).
  const card = cardsFor(await getState(ui), ref)[0];
  if (!card) die(outOfScope(key), { outOfScope: true });

  // 필터에 걸린 PR 은 큐에 오르지 않는다. 여기서 멈추고 알린다 —
  // 스킬이 필터를 풀어버리면 그건 다른 세션의 설정을 갈아엎는 일이다.
  if (card.excludedReason) {
    die(`${key} 는 현재 감시 설정에서 제외돼 있습니다 (${card.excludedReason}).`, {
      excluded: card.excludedReason,
    });
  }

  await postIntent(ui, { kind: 'review-now', ref: key });

  // **지금 라운드 번호를 같이 낸다.** wait 가 "이 요청의 결과" 와 "이전 라운드가
  // 남긴 상태" 를 구분하려면 기준점이 필요하다 — 이게 없으면 AWAITING_AUTHOR
  // 로 남아 있던 이전 결과를 새 결과로 오인해 즉시 깨어난다.
  const sinceRound = card.round ?? 0;
  const self = path.join(ROOT, 'scripts', 'daemon.mjs').replace(/\\/g, '/');
  out(
    `${key} 를 리뷰 큐 맨 앞에 넣었습니다 (현재 ${card.stateLabel ?? card.state}).\n` +
      `결과를 기다리려면 (백그라운드로):\n` +
      `  node "${self}" wait ${key} --since-round ${sinceRound}`,
    { ok: true, ui, key, state: card.state, sinceRound },
  );
}

/**
 * 결과를 기다린다 — notify.mjs 에 위임한다.
 *
 * 세션은 이걸 **백그라운드로** 돌린다. 라운드가 2~15분이라 앞에서 기다리면
 * 그동안 아무것도 못 한다. 이벤트 하나를 받으면 종료하므로, 종료가 곧
 * "확인할 게 생겼다" 는 신호가 된다.
 */
async function verbWait() {
  const ref = parseRef(positionals()[0]);
  if (!ref) die('기다릴 PR 을 owner/repo#12 형식으로 지정하세요.');
  const { ui } = await ensure({ start: false });

  const until = value('--until', 'posted,converged,failed,quota,closed');
  const timeout = value('--timeout', '2700');
  const args = [
    path.join(ROOT, 'scripts', 'notify.mjs'),
    '--url', ui,
    '--pr', refKey(ref),
    '--porcelain',
    '--until', until,
    '--timeout', timeout,
  ];
  // review 가 알려준 기준 라운드. 그 **이후** 결과만 이미 도달한 것으로 인정한다
  // (notify.mjs 참고). 없으면 붙은 뒤의 전이만 본다.
  const since = value('--since-round', null);
  if (since !== null) args.push('--since-round', since);
  const child = spawn(process.execPath, args, { stdio: 'inherit', windowsHide: true });
  child.on('exit', (code) => process.exit(code ?? 0));
}

// ── 진입점 ──────────────────────────────────────────────────

const VERBS = {
  ensure: verbEnsure,
  status: verbStatus,
  review: verbReview,
  skip: verbSkip,
  wait: verbWait,
};

async function main() {
  if (!VERB || flag('--help') || flag('-h') || !VERBS[VERB]) {
    console.log(`
  PR 리뷰 데몬 클라이언트

    ensure                      데몬이 없으면 띄운다 (멱등) ← 브라우저·한도를 쓴다
    review <ref>                리뷰 큐 맨 앞으로 (필요하면 데몬을 띄운다)

  아래는 **데몬을 띄우지 않는다** (돌고 있지 않으면 그 사실을 알린다):

    status [--pr <ref>] [--json]  현재 상태
    skip   <ref>                이 PR 은 리뷰하지 않는다
    wait   <ref> [--since-round <n>] [--timeout <초>] [--until <이벤트>]
                                결과까지 대기 (백그라운드로 실행할 것)
                                --since-round 는 review 가 알려준 값을 그대로

  <ref> 는 owner/repo#12 또는 PR URL.

  감시 범위는 넓히지 않습니다 — 범위는 레포 단위라 PR 하나를 부탁하는 요청이
  그 레포의 다른 PR 까지 리뷰 대상으로 만듭니다. 범위는 사람이 정합니다.

  데몬 종료도 여기 없습니다 — 대시보드의 종료 버튼이나
  \`npm run dev -- stop\` 을 쓰세요 (여러 세션이 함께 씁니다).
`);
    process.exit(VERB && !VERBS[VERB] ? 1 : 0);
  }
  await VERBS[VERB]();
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
