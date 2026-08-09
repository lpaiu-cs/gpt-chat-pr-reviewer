#!/usr/bin/env node

/**
 * 대시보드 이벤트 알림 — `watch --ui` 가 띄운 SSE 를 구독해 리뷰 진행을 알린다.
 *
 * 셀프 리뷰(내 PR 을 내 도구가 리뷰)는 GitHub 알림도, 외부 CI 훅도 잡아주지
 * 않는다. 리뷰가 게시된 걸 알아채려면 결국 사람이 대시보드를 들여다봐야 하는데,
 * 라운드가 2~15분이라 계속 보고 있을 수가 없다. 이 스크립트가 그 자리를 채운다.
 *
 * **읽기 전용이다.** 대시보드 SSE 만 구독하고 상태 파일은 건드리지 않는다 —
 * store.ts 에 잠금이 없어 watch 와 같은 파일을 다투면 라운드 결과가 깨진다.
 * 그래서 별도 프로세스로 띄워도 안전하다.
 *
 * 의존성 없음. `node scripts/notify.mjs` 로 바로 돈다 (tsx 불필요).
 *
 *   node scripts/notify.mjs
 *   node scripts/notify.mjs --on posted --exec "gh pr view $PR_NUMBER --web"
 *   node scripts/notify.mjs --url http://127.0.0.1:9000 --no-bell
 */

import { spawn } from 'node:child_process';

// ── 인자 ────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

if (flag('--help') || flag('-h')) {
  console.log(`
  대시보드 이벤트 알림 — watch --ui 의 SSE 를 구독한다.

  사용법
    node scripts/notify.mjs [옵션]

  옵션
    --pr <refs>       감시할 대상, 쉼표 구분. 없으면 전부.
                      'owner/repo#12' → 그 PR 만 · 'owner/repo' → 그 레포 전체
    --url <origin>    대시보드 주소 (기본 http://127.0.0.1:4478)
    --on <events>     --exec 를 실행할 이벤트, 쉼표 구분 (기본 posted,converged,failed)
    --exec <command>  이벤트 발생 시 실행할 셸 명령
    --porcelain       이벤트 1건 = 1줄, 장식 없음 (에이전트·스크립트가 소비할 때)
    --no-bell         터미널 벨 끄기
    --quiet           진행 단계는 **화면에** 찍지 않고 주요 이벤트만
                      (--exec 실행 대상은 --on 이 정한다 — quiet 는 관여하지 않는다)

  이벤트
    round-start   라운드 시작
    posting       리뷰 게시 단계 진입 (아직 GitHub 에 올라가기 전)
    posted        코멘트 게시 완료 → AWAITING_AUTHOR  ← 처리할 게 생긴 시점
    converged     수렴 (approve)
    failed        라운드 실패
    quota         ChatGPT 한도 도달
    closed        PR 닫힘/머지

  --exec 에 넘어가는 환경변수
    PR_EVENT PR_KEY PR_URL PR_OWNER PR_REPO PR_NUMBER PR_ROUND PR_STATE PR_TITLE
`);
  process.exit(0);
}

const ORIGIN = value('--url', 'http://127.0.0.1:4478').replace(/\/+$/, '');
const EXEC = value('--exec', null);
const ON = new Set(value('--on', 'posted,converged,failed').split(',').map((s) => s.trim()));
const PORCELAIN = flag('--porcelain');
const BELL = !flag('--no-bell') && !PORCELAIN;
const QUIET = flag('--quiet');

// ── 감시 대상 필터 ──────────────────────────────────────────

/**
 * 대시보드 하나를 여러 세션이 함께 본다. 각 세션은 자기가 붙잡고 있는 PR 의
 * 리뷰만 기다리는데, 필터가 없으면 남의 PR 이 게시될 때마다 전부 깨어난다.
 *
 * `owner/repo#12` 는 그 PR 만, `owner/repo` 는 그 레포 전체를 뜻한다.
 * watch 설정의 `filters.skip`/`only` 와 달리 여기서 레포 단위를 허용하는 이유는
 * 성격이 다르기 때문이다 — 저쪽은 "무엇을 리뷰할지" 를 정하는 안전 장치라 넓게
 * 잡히면 위험하지만, 이건 "무엇을 들을지" 라 세션 단위로 묶는 게 자연스럽다.
 *
 * 대시보드가 주는 key 는 이미 `owner/repo#<번호>` 정규형이므로 사용자가 적은
 * 쪽만 맞춰 준다 (대소문자 · 여백 · 선행 0).
 */
function parseFilter(entry) {
  const s = entry.trim().toLowerCase().replace(/\/+$/, '');
  const m = /^(.+?)#0*(\d+)$/.exec(s);
  if (m) return { slug: m[1], number: Number(m[2]), label: `${m[1]}#${Number(m[2])}` };
  return { slug: s, number: null, label: `${s} (레포 전체)` };
}

const FILTERS = (value('--pr', '') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(parseFilter);

function matchesFilter(key) {
  if (FILTERS.length === 0) return true;
  const [slug, num] = String(key).toLowerCase().split('#');
  return FILTERS.some((f) => f.slug === slug && (f.number === null || f.number === Number(num)));
}

// ── 출력 ────────────────────────────────────────────────────

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  mag: (s) => `\x1b[35m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const clock = () => new Date().toLocaleTimeString('ko-KR', { hour12: false });
const say = (line) => {
  if (PORCELAIN) return; // porcelain 은 이벤트 줄만 낸다
  console.log(`${C.dim(clock())}  ${line}`);
};

/** 연결 상태처럼 이벤트는 아니지만 소비자가 알아야 하는 소식. */
const note = (kind, text) => {
  if (PORCELAIN) console.log(`${kind}  ${text}`);
  else say(C.yellow(text));
};

/** 주의를 끌어야 하는 이벤트 — 벨을 울린다. */
const LOUD = new Set(['posted', 'converged', 'failed', 'quota']);

const EVENT_STYLE = {
  'round-start': [C.cyan, '리뷰 시작'],
  posting: [C.cyan, '게시 중'],
  posted: [C.yellow, '코멘트 게시됨'],
  converged: [C.green, '수렴'],
  failed: [C.red, '실패'],
  quota: [C.mag, '쿼터 한도'],
  closed: [C.dim, '종료'],
};

// ── --exec 직렬 실행 ────────────────────────────────────────

/**
 * 명령을 직렬로 돌린다. 라운드는 겹치지 않지만 posted 직후 converged 가 붙어
 * 오는 등 이벤트는 연달아 날 수 있고, 핸들러가 git 작업이면 겹치면 깨진다.
 */
let chain = Promise.resolve();

function runExec(event, ctx) {
  if (!EXEC || !ON.has(event)) return;
  const [owner, rest] = ctx.key.split('/');
  const [repo, number] = (rest ?? '').split('#');

  chain = chain.then(
    () =>
      new Promise((resolve) => {
        say(C.dim(`  ↳ exec: ${EXEC}`));
        const child = spawn(EXEC, {
          shell: true,
          stdio: 'inherit',
          env: {
            ...process.env,
            PR_EVENT: event,
            PR_KEY: ctx.key,
            PR_URL: ctx.url ?? '',
            PR_OWNER: owner ?? '',
            PR_REPO: repo ?? '',
            PR_NUMBER: number ?? '',
            PR_ROUND: String(ctx.round ?? ''),
            PR_STATE: ctx.state ?? '',
            PR_TITLE: ctx.title ?? '',
          },
        });
        child.on('exit', (code) => {
          if (code !== 0) say(C.red(`  ↳ exec 종료 코드 ${code}`));
          resolve();
        });
        child.on('error', (e) => {
          say(C.red(`  ↳ exec 실패: ${e.message}`));
          resolve();
        });
      }),
  );
}

function emit(event, ctx, detail = '') {
  // 필터가 가장 먼저다 — 남의 PR 이면 출력도 exec 도 없어야 한다.
  if (!matchesFilter(ctx.key)) return;

  // --quiet 는 **화면만** 줄인다. --on 으로 명시한 핸들러까지 막으면
  // `--quiet --on round-start --exec ...` 가 조용히 아무것도 안 하게 된다 —
  // 둘은 목적이 다른 옵션이고, 여기서 겹치면 사용자가 요청한 자동화가 사라진다.
  if (!QUIET || LOUD.has(event)) {
    if (PORCELAIN) {
      console.log([event, ctx.key, detail, ctx.url ?? ''].filter(Boolean).join('  '));
    } else {
      const [color, label] = EVENT_STYLE[event] ?? [C.dim, event];
      const bell = BELL && LOUD.has(event) ? '\x07' : '';
      say(
        `${bell}${color(C.bold(label.padEnd(7)))} ${C.bold(ctx.key)}${detail ? '  ' + C.dim(detail) : ''}`,
      );
      if (ctx.url) say(C.dim(`         ${ctx.url}`));
    }
  }

  runExec(event, ctx);
}

// ── 상태 비교 ───────────────────────────────────────────────

/**
 * 상태 전이를 컨텍스트 카드로 판정한다 (active.phase 가 아니라).
 *
 * active 는 endReview 직후 null 이 되는데 그 스냅샷의 카드는 아직 라운드 이전
 * 값이다. 결과는 그 다음 publish 에 실린다. 카드 상태만 보면 그 타이밍을 신경
 * 쓸 필요가 없고, watch 를 재시작해도 같은 기준으로 이어진다.
 */
const STATE_EVENT = {
  AWAITING_AUTHOR: 'posted',
  CONVERGED: 'converged',
  ERROR: 'failed',
  QUOTA_BLOCKED: 'quota',
  CLOSED: 'closed',
};

let session = null;
let prevPhase = null;
let prevActiveKey = null;
/**
 * 이번 끊김을 이미 알렸는가.
 *
 * 없으면 watch 가 내려가 있는 동안 재시도마다 "연결 끊김" 을 쏟는다. 알림은
 * 상태 변화를 알리는 것이지 상태를 반복 보고하는 게 아니다 — 끊긴 순간 한 번,
 * 붙은 순간 한 번이면 침묵의 의미를 판정하는 데 충분하다.
 */
let announcedDisconnect = false;
/** 재연결 대기 (ms). 붙는 순간 되돌린다. */
let backoff = 1000;
/** key → state. 연결 직후 채워서 "이미 그 상태였던 것" 을 새 이벤트로 오인하지 않는다. */
let prevStates = new Map();
let baselined = false;

function onSnapshot(s) {
  // 스냅샷이 왔다 = 붙어 있다. 다음 끊김은 다시 한 번 알린다.
  announcedDisconnect = false;
  backoff = 1000;

  // watch 재시작 → 기준선을 다시 잡는다. 안 그러면 재시작 직후 모든 PR 의
  // 현재 상태가 방금 일어난 일처럼 한꺼번에 쏟아진다.
  if (s.session !== session) {
    if (session !== null) note('watch-restarted', '── watch 재시작 감지 — 기준선을 다시 잡습니다 ──');
    session = s.session;
    baselined = false;
    prevPhase = null;
    prevActiveKey = null;
  }

  const a = s.active;

  if (baselined) {
    if (a && a.key !== prevActiveKey) {
      emit('round-start', a, `${a.round}차 · ${a.reasonLabel}`);
    }
    if (a && a.phase === 'posting' && prevPhase !== 'posting') {
      emit('posting', a, `${a.round}차 · 대기 ${Math.round((Date.now() - a.startedAt) / 1000)}초 경과`);
    }

    for (const c of s.contexts) {
      const before = prevStates.get(c.key);
      if (before === undefined || before === c.state) continue;
      const event = STATE_EVENT[c.state];
      if (!event) continue; // REVIEW_DUE·REVIEWING 은 그 자체로 알릴 게 없다
      const threads = c.threadsTotal ? `스레드 ${c.threadsResolved}/${c.threadsTotal}` : '';
      const detail = [`${c.round}라운드`, `요청 ${c.requestedCount}개`, threads, c.lastError]
        .filter(Boolean)
        .join(' · ');
      emit(event, c, detail);
    }
  }

  prevActiveKey = a?.key ?? null;
  prevPhase = a?.phase ?? null;
  prevStates = new Map(s.contexts.map((c) => [c.key, c.state]));

  if (!baselined) {
    baselined = true;
    const watching = s.contexts.filter((c) => matchesFilter(c.key));

    // 필터에 걸리는 PR 이 하나도 없으면 오타일 가능성이 높다. 조용히 기다리면
    // 영원히 아무 일도 안 일어나는데 그게 정상처럼 보인다 — 반드시 짚어준다.
    // (아직 추적 전인 새 PR 일 수도 있으므로 경고까지만 하고 계속 돈다.)
    if (FILTERS.length > 0 && watching.length === 0) {
      note(
        'filter-no-match',
        `⚠ --pr 필터(${FILTERS.map((f) => f.label).join(', ')})와 맞는 PR 이 지금은 없습니다 — ` +
          `오타이거나 아직 추적 전일 수 있습니다. 추적 중: ${s.contexts.map((c) => c.key).join(', ') || '없음'}`,
      );
    }

    if (PORCELAIN) {
      console.log(
        `connected  ${FILTERS.length ? FILTERS.map((f) => f.label).join(',') : '전체'}  ` +
          `watching=${watching.map((c) => `${c.key}:${c.state}`).join(',') || '없음'}` +
          (a && matchesFilter(a.key) ? `  active=${a.key}:${a.phase}` : ''),
      );
      return;
    }

    say(C.green(`연결됨 — ${s.scope || '범위 미설정'}`));
    if (FILTERS.length > 0) say(C.cyan(`  대상: ${FILTERS.map((f) => f.label).join(', ')}`));
    for (const c of watching) {
      say(C.dim(`  · ${c.key}  ${c.stateLabel}  ${c.round}라운드${c.excludedReason ? `  (제외: ${c.excludedReason})` : ''}`));
    }
    if (a && matchesFilter(a.key)) say(C.cyan(`  · 진행 중: ${a.key} ${a.round}차 (${a.phase})`));
  }
}

// ── SSE 구독 ────────────────────────────────────────────────

async function stream() {
  const res = await fetch(`${ORIGIN}/events`, { headers: { accept: 'text/event-stream' } });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

  let buf = '';
  for await (const chunk of res.body) {
    buf += Buffer.from(chunk).toString('utf-8');
    // SSE 프레임 구분자는 빈 줄. 마지막 조각은 미완성일 수 있으니 남겨둔다.
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const frame of frames) {
      const data = frame
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('\n');
      if (!data) continue; // ': ping' 킵얼라이브
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        continue;
      }
      if (msg.type === 'snapshot') onSnapshot(msg.data);
    }
  }
  throw new Error('스트림이 종료되었습니다');
}

async function main() {
  if (!PORCELAIN) {
    console.log(C.bold(`\n  대시보드 이벤트 알림  ${C.dim(ORIGIN)}`));
    console.log(
      C.dim(
        `  대상: ${FILTERS.length ? FILTERS.map((f) => f.label).join(', ') : '전체'}` +
          ` · exec: ${EXEC ? `${EXEC}  (on ${[...ON].join(',')})` : '없음'}` +
          `${BELL ? ' · 벨 켜짐' : ''}\n`,
      ),
    );
  }

  for (;;) {
    try {
      await stream();
    } catch (e) {
      // watch 가 아직 안 떴거나 재시작 중일 수 있다 — 조용히 다시 붙는다.
      //
      // 여기서 기준선을 버리지 않는다. 같은 watch 프로세스에 다시 붙은 것이라면
      // (session 이 같다면) 끊긴 사이에 일어난 전이를 첫 스냅샷에서 그대로
      // 잡아내야 한다 — 3초 끊겼다고 그 사이 게시된 리뷰를 놓치면 알림의 의미가
      // 없다. watch 자체가 재시작됐을 때만 onSnapshot 의 session 비교가
      // 기준선을 다시 잡는다.
      //
      // 알림은 **끊긴 순간 한 번만** 낸다. 재시도마다 내면 watch 가 내려가 있는
      // 동안 같은 사실을 초당 한 번씩 반복하게 된다.
      if (session !== null && !announcedDisconnect) {
        note('disconnected', `연결 끊김 (${e.message}) — 재연결합니다`);
        announcedDisconnect = true;
      }
    }
    await new Promise((r) => setTimeout(r, backoff));
    // 오래 끊겨 있을수록 뜸하게 — 붙는 순간 onSnapshot 이 1초로 되돌린다.
    backoff = Math.min(backoff * 2, 15_000);
  }
}

process.on('SIGINT', () => {
  console.log(C.dim('\n  종료합니다.\n'));
  process.exit(0);
});

main();
