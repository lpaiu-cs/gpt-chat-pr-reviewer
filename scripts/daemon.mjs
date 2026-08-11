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

import { spawn, execFileSync } from 'node:child_process';
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
/** 데몬이 떠서 /api/state 를 열 때까지 기다리는 시간. */
const START_TIMEOUT_MS = 90_000;
/**
 * "이 PR 은 범위 밖" 을 확정하기 전에 신선한 스캔을 기다리는 시간.
 *
 * cold start 에서는 UI 가 **브라우저 기동보다 먼저** 열리므로(로그인 안내도
 * 대시보드에 남아야 한다) 첫 스캔까지 시간이 걸리고, 이미 오래 돌던 데몬에서는
 * 마지막 스캔이 방금 만든 PR 보다 앞선다. 둘 다 "아직 못 봤다" 인데 그걸 범위
 * 밖으로 읽으면 멀쩡한 PR 을 거부한다. 기동·로그인 확인까지 넉넉히 준다.
 */
const FRESH_SCAN_TIMEOUT_MS = 180_000;
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
      if (['--pr', '--timeout', '--until', '--since-seq'].includes(a)) i++;
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
      if (s.snapshot.instance === want) {
        return { ui, mode: s.snapshot.mode ?? 'review', ready: s.snapshot.ready === true };
      }
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
  // **일찍 죽었는지 본다.** watch 는 감시 범위가 비었거나 로그인이 만료됐으면
  // UI 를 열기도 전에 종료한다. 그걸 모르면 "데몬이 90초 안에 안 떴다" 는
  // 엉뚱한 원인을 보고하게 된다 — 진짜 원인은 이미 로그에 적혀 있는데도.
  const died = { code: null };
  child.on('exit', (code) => {
    died.code = code ?? 0;
  });
  child.unref();
  return died;
}

/** watch.log 꼬리 — 기동 실패의 진짜 원인이 여기 적혀 있다. */
function logTail(lines = 15) {
  try {
    const all = readFileSync(path.join(dataDir(), 'watch.log'), 'utf-8')
      .split(/\r?\n/)
      // ANSI 색을 걷어낸다 — 로그 파일에는 chalk 이 그대로 들어 있다.
      .map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trimEnd())
      .filter(Boolean);
    return all.slice(-lines).map((l) => `    ${l}`).join('\n');
  } catch {
    return '    (로그를 읽지 못했습니다)';
  }
}

/**
 * 데몬을 찾는다. `start` 가 참일 때만 없으면 띄운다.
 *
 * **관측용 동사는 띄우지 않는다.** 일반 watch 는 브라우저를 열고 범위 안의
 * REVIEW_DUE PR 을 자동으로 리뷰한다 — 상태만 보려던 호출이 ChatGPT 한도를
 * 쓰고 GitHub 에 리뷰를 게시하면, 그건 요청한 적 없는 부작용이다. 비용을
 * 만드는 것은 비용을 의도한 동사(`review`)뿐이다.
 */
async function ensure({ start = false, requireReady = false } = {}) {
  const found = await findDaemon();
  if (found && (found.ready || !requireReady)) return { ...found, started: false };
  // 떠 있지만 아직 초기화 중이다 — 비용을 쓸 동사는 기다린다 (아래 루프).
  if (!found && !start) {
    die(
      '이 설치본의 리뷰 데몬이 돌고 있지 않습니다.\n' +
        `  시작하려면 (브라우저·ChatGPT 한도를 씁니다):  node "${path.join(ROOT, 'scripts', 'daemon.mjs').replace(/\\/g, '/')}" review <PR>\n` +
        `  또는 ${ROOT} 에서  npm run dev -- watch --ui`,
    );
  }

  // 이미 떠 있으면(초기화 중일 뿐) 새로 띄우지 않는다 — 잠금이 막겠지만
  // 애초에 띄울 이유가 없고, 로그에 실패 흔적만 쌓인다.
  const startedHere = !found;
  const died = startedHere ? launch() : { code: null };
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const d = await findDaemon();
    // **UI 가 떴다는 것만으로 성공을 확정하지 않는다.** watch 는 대시보드를 먼저
    // 열고 그 뒤에 브라우저 기동·로그인 확인을 한다. 로그인이 만료됐으면 UI 가
    // 잠깐 살아 있다가 죽으므로, 여기서 돌아가면 **곧 죽을 데몬을 "정상 기동"
    // 으로 보고**하게 된다.
    if (d && (d.ready || !requireReady)) return { ...d, started: startedHere };

    // 죽었다면 기다릴 이유가 없다. 단, 다른 세션이 잠금을 먼저 잡아서 우리
    // 프로세스만 물러난 경우일 수 있으므로 위의 findDaemon 을 먼저 본다
    // (그쪽이 이겼으면 이미 위에서 돌아갔다).
    if (died.code !== null) {
      die(
        `데몬이 기동 직후 종료했습니다 (코드 ${died.code}).\n` +
          `  로그 마지막 부분 (${path.join(dataDir(), 'watch.log')}):\n` +
          `${logTail()}\n` +
          `  감시 범위가 비어 있으면 ${ROOT}/pr-review.config.json 의 watch.include 를,\n` +
          `  ChatGPT 로그인이 만료됐으면 ${ROOT} 에서 \`npm run setup\` 을 실행해야 합니다.`,
      );
    }

    if (Date.now() >= deadline) {
      const secs = Math.round(START_TIMEOUT_MS / 1000);
      die(
        (d
          ? `데몬이 ${secs}초 안에 초기화를 끝내지 못했습니다 (대시보드는 응답하지만 준비 전).\n` +
            `  브라우저 기동이나 ChatGPT 로그인 확인에서 멈춰 있을 수 있습니다.\n`
          : `데몬이 ${secs}초 안에 뜨지 않았습니다.\n`) +
          `  로그 마지막 부분 (${path.join(dataDir(), 'watch.log')}):\n` +
          `${logTail()}`,
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
  const { ui, started, mode } = await ensure({ start: true, requireReady: true });
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
async function fetchState(ui) {
  try {
    return await getState(ui);
  } catch {
    // 로그인 실패 등으로 데몬이 내려갔을 수 있다 — 조용히 기다리면 안 된다.
    die(
      `데몬과의 연결이 끊겼습니다. 로그를 확인하세요: ${path.join(dataDir(), 'watch.log')}\n` +
        `(ChatGPT 로그인이 만료됐다면 ${ROOT} 에서 \`npm run setup\`)`,
    );
  }
}

/**
 * 그 PR 의 카드를 찾는다. **없다는 사실은 그 레포를 실제로 조회한 뒤에만 믿는다.**
 *
 * 카드가 없는 데는 서로 다른 이유가 있고 결론이 정반대다:
 *   · 그 PR 이 없다 (번호 오류·닫힘) → 사람이 확인할 일
 *   · 그 레포가 감시 대상이 아니다 → 사람이 범위를 넓힐 일
 *   · 아직 그 레포를 조회하지 않았다 → 곧 보인다, 기다리면 된다
 *
 * 마지막을 앞의 것으로 읽으면 멀쩡한 PR 을 거부한다. 그런데 스킬의 대표 경로가
 * **"PR 을 만든 직후 리뷰"** 라 하필 그 상황이 가장 흔하다.
 *
 * 전역 `lastScanAt` 으로는 판정할 수 없다. 사이클은 매번 끝나지만
 * `probeIdleIntervalMs`(기본 60초) 안에 있는 레포는 조회를 건너뛰므로,
 * "방금 스캔했다" 가 참인데 그 레포는 안 본 상태가 정상적으로 발생한다.
 * 그래서 **레포별** 조회 시각(`cycle.probedAt`)이 우리 요청보다 뒤인지를 본다.
 *
 * 카드가 있으면 즉시 돌려준다 — 흔한 경로에 대기를 붙이지 않는다.
 */
async function resolveCard(ui, ref, key) {
  const askedAt = Date.now();
  let state = await fetchState(ui);
  let card = cardsFor(state, ref)[0];
  if (card) return card;

  // probedAt 키는 소문자로 정규화돼 있다 (cli.ts) — 조회도 같은 형태로 한다.
  // GitHub slug 는 대소문자를 구분하지 않아 사용자가 아무렇게나 적을 수 있다.
  const slugKey = ref.slug.toLowerCase();
  const deadline = askedAt + FRESH_SCAN_TIMEOUT_MS;
  for (;;) {
    // 그 레포를 **우리 요청 뒤에** 실제로 조회했는데도 카드가 없다. 원인은
    // "PR 이 없다" 일 수도 "필터에 걸렸다" 일 수도 있으므로 단정하지 않는다.
    const probedAt = state.snapshot?.cycle?.probedAt ?? {};
    if (Number(probedAt[slugKey]) > askedAt) {
      const ctl = state.snapshot?.control ?? {};
      const filters = [
        ctl.skip?.length ? `skip ${ctl.skip.length}건` : '',
        ctl.only?.length ? `only ${ctl.only.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      die(cardMissing(key, ref.slug, ref.number, filters), { notTracked: true });
    }

    if (Date.now() >= deadline) {
      // 끝내 조회 기록을 못 봤다. 범위 밖일 가능성이 가장 크지만 **단정하지
      // 않는다** — 리뷰가 도는 동안에는 스캔 자체가 밀린다.
      const active = state.snapshot?.active;
      die(
        repoNotWatched(key, ref.slug, state.snapshot?.control?.include ?? []) +
          (active ? `\n  (지금 ${active.key} ${active.round}차 리뷰 중이라 스캔이 밀려 있습니다)` : ''),
        { outOfScope: true },
      );
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
    state = await fetchState(ui);
    card = cardsFor(state, ref)[0];
    if (card) return card;
  }
}

/**
 * 레포는 조회했는데 카드가 없다 — **그렇다고 PR 이 없는 건 아니다.**
 *
 * `scan()` 은 `passesFilters()`/`admitsNewPR()` 에서 걸린 PR 의 컨텍스트를 아예
 * 만들지 않는다 (`if (!existing && !admitted) continue`). 그래서 기본 설정의
 * draft PR 은 열려 있어도 카드가 없다 — 그걸 "번호가 틀렸다" 고 보고하면
 * 사용자는 멀쩡한 번호를 몇 번이고 다시 확인하게 된다.
 *
 * 데몬이 남긴 것만으로는 구분할 수 없으므로 **실패 경로에서만** GitHub 에
 * 직접 한 번 물어본다 (정상 경로에는 비용이 붙지 않는다).
 */
function inspectPR(slug, number) {
  try {
    const out = execFileSync(
      'gh',
      ['pr', 'view', String(number), '--repo', slug, '--json', 'state,isDraft,author,title'],
      { windowsHide: true, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return JSON.parse(out);
  } catch {
    return null; // 없거나 권한이 없거나 gh 가 없다 — 아래에서 그대로 말한다
  }
}

function cardMissing(key, slug, number, filters) {
  const pr = inspectPR(slug, number);
  if (!pr) {
    return (
      `${key} 를 찾지 못했습니다. 레포는 방금 조회했는데 이 PR 이 없습니다.\n` +
      `  번호가 맞는지 확인하세요 (또는 접근 권한·gh 인증).`
    );
  }
  if (pr.state !== 'OPEN') {
    return `${key} 는 이미 ${pr.state === 'MERGED' ? '머지됐습니다' : '닫혔습니다'}.`;
  }
  // 열려 있는데 추적되지 않는다 = 감시 설정에서 걸러졌다.
  return (
    `${key} 는 열려 있지만 감시 대상이 아닙니다 — 설정 필터에서 제외됐습니다.\n` +
    (pr.isDraft ? `  draft PR 입니다 (기본값은 제외 — filters.draft: true 로 포함).\n` : '') +
    `  작성자: ${pr.author?.login ?? '?'}\n` +
    `  현재 필터: ${filters || '(없음)'}\n` +
    `  필터는 사용자가 정합니다 — 대시보드나 pr-review.config.json 을 확인하세요.`
  );
}

/** 그 레포 자체가 감시 대상이 아니다 (또는 아직 발견되지 않았다). */
function repoNotWatched(key, slug, include) {
  return (
    `${key} 를 확인하지 못했습니다 — ${slug} 를 조회한 기록이 없습니다.\n` +
    `  현재 감시 범위: ${include.length ? include.join(', ') : '(없음)'}\n` +
    `  이 레포가 범위에 없다면 사용자가 넓혀야 합니다 —\n` +
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
  const { ui, started, mode } = await ensure({ start: true, requireReady: true });
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

  // 카드가 없으면 신선한 스캔을 본 뒤에만 범위 밖으로 확정한다 (resolveCard).
  const card = await resolveCard(ui, ref, key);

  // 필터에 걸린 PR 은 큐에 오르지 않는다. 여기서 멈추고 알린다 —
  // 스킬이 필터를 풀어버리면 그건 다른 세션의 설정을 갈아엎는 일이다.
  if (card.excludedReason) {
    die(`${key} 는 현재 감시 설정에서 제외돼 있습니다 (${card.excludedReason}).`, {
      excluded: card.excludedReason,
    });
  }

  // 요청 시점에 **본** 전이 횟수를 함께 보낸다. 이 의도는 진행 중인 라운드가
  // 끝난 뒤에야 적용되는데, 그 사이 그 PR 이 이미 리뷰됐으면 그대로 적용할 때
  // 같은 PR 을 한 번 더 리뷰하게 된다 (intents.ts 참고).
  await postIntent(ui, { kind: 'review-now', ref: key, seq: card.seq ?? 0 });

  // **지금 전이 횟수를 같이 낸다.** wait 가 "이 요청의 결과" 와 "이전 라운드가
  // 남긴 상태" 를 구분하려면 기준점이 필요하다 — 이게 없으면 AWAITING_AUTHOR
  // 로 남아 있던 이전 결과를 새 결과로 오인해 즉시 깨어난다.
  //
  // 라운드 번호가 아니라 전이 횟수인 이유: 실패·쿼터 한도·PR 닫힘은 라운드를
  // 올리지 않는다. 라운드로 재면 요청 직후에 실패하거나 한도에 걸린 경우를
  // "예전 것" 으로 버리고, 45분 뒤 timeout 으로 끝나 원인까지 잘못 전한다
  // (쿼터는 실제로는 몇 시간짜리 대기다).
  const sinceSeq = card.seq ?? 0;
  const self = path.join(ROOT, 'scripts', 'daemon.mjs').replace(/\\/g, '/');
  out(
    `${key} 를 리뷰 큐 맨 앞에 넣었습니다 (현재 ${card.stateLabel ?? card.state}).\n` +
      `결과를 기다리려면 (백그라운드로):\n` +
      `  node "${self}" wait ${key} --since-seq ${sinceSeq}`,
    { ok: true, ui, key, state: card.state, sinceSeq },
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
  // review 가 알려준 기준 전이 횟수. 그 **이후** 결과만 이미 도달한 것으로
  // 인정한다 (notify.mjs 참고). 없으면 붙은 뒤의 전이만 본다.
  const since = value('--since-seq', null);
  if (since !== null) args.push('--since-seq', since);
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
    wait   <ref> [--since-seq <n>] [--timeout <초>] [--until <이벤트>]
                                결과까지 대기 (백그라운드로 실행할 것)
                                --since-seq 는 review 가 알려준 값을 그대로

  <ref> 는 owner/repo#12 또는 PR URL.

  감시 범위는 넓히지 않습니다 — 범위는 레포 단위라 PR 하나를 부탁하는 요청이
  그 레포의 다른 PR 까지 리뷰 대상으로 만듭니다. 범위는 사람이 정합니다.

  데몬 종료도 여기 없습니다 — 대시보드의 종료 버튼이나
  \`npm run dev -- stop\` 을 쓰세요 (여러 세션이 함께 씁니다).
`);
    // 도움말을 **요청해서** 본 것은 성공이다. 모르는 동사만 실패로 친다.
    const askedForHelp = !VERB || flag('--help') || flag('-h');
    process.exit(askedForHelp ? 0 : 1);
  }
  await VERBS[VERB]();
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
