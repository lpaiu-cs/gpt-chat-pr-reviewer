/**
 * 관측 대시보드 서버 — watch 프로세스 **안에서** 돈다.
 *
 * 별도 프로세스로 띄우지 않는 이유는 progress.ts 헤더에 적어둔 그대로다:
 * store.ts 에 잠금이 없어서 다른 프로세스가 data/state 를 읽고 쓰면 라운드와
 * 다툰다. 그래서 이 서버는 파일을 일절 건드리지 않고 progress 버스만 중계한다.
 *
 * 의존성을 추가하지 않는다 — node:http + SSE 로 충분하다. 데이터가 사실상
 * 단방향(서버→브라우저)이라 WebSocket 을 들일 이유가 없고, SSE 는 브라우저가
 * 알아서 재연결해 준다 (watch 를 재시작해도 탭을 새로고침할 필요가 없다).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { inspect } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { progress, type BusEvent } from '../progress.js';
import { intents, INTENT_KINDS, type Intent } from '../intents.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** SSE 연결 유지용 주석 주기. 프록시·브라우저가 유휴 연결을 끊지 않게 한다. */
const KEEPALIVE_MS = 15_000;

/**
 * 대시보드 HTML.
 *
 * tsx 로 돌면 src/ui 옆에 있고, 빌드 후에는 dist/ui 로 복사된다
 * (scripts/copy-ui.mjs). 복사가 누락된 배포본에서도 죽지 않도록 원본 경로를
 * 폴백으로 둔다 — UI 하나 때문에 watch 전체가 못 뜨면 손해가 더 크다.
 */
function loadHtml(): string {
  const candidates = [
    path.join(HERE, 'app.html'),
    path.join(HERE, '..', '..', 'src', 'ui', 'app.html'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return readFileSync(c, 'utf-8');
  }
  return '<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:2rem">' +
    '<h1>대시보드 파일을 찾지 못했습니다</h1><p>src/ui/app.html 이 없습니다. ' +
    '<code>npm run build</code> 를 다시 실행하거나 저장소를 확인하세요.</p>';
}

export interface UIServerHandle {
  url: string;
  close: () => Promise<void>;
}

/**
 * 지침 파일을 읽고 쓰는 훅. cli.ts 가 config 를 들고 주입한다 —
 * 서버가 config 를 직접 알면 UI 계층이 설정 로딩까지 떠안게 된다.
 */
export interface UIHooks {
  readInstructions: () => string;
  writeInstructions: (body: string) => string;
}

/** 요청 본문을 JSON 으로 읽는다. 과도하게 크면 거부한다. */
const MAX_BODY = 256 * 1024;

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('본문이 너무 큽니다');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

/**
 * 다른 사이트가 이 대시보드를 조작하지 못하게 막는다.
 *
 * 127.0.0.1 바인딩만으로는 부족하다 — 사용자가 아무 웹페이지나 열어둔 상태에서
 * 그 페이지가 localhost 로 요청을 보낼 수 있기 때문이다. 읽기 전용일 때는 큰
 * 문제가 아니었지만 이제 POST 가 설정 파일을 바꾸므로 반드시 걸러야 한다.
 *
 * 두 겹이다: (1) Origin 이 있으면 우리 것이어야 하고 (2) JSON content-type 을
 * 요구해 단순 요청(form/텍스트)으로는 아예 닿지 못하게 한다.
 */
function rejectsCrossOrigin(req: IncomingMessage, host: string): string | null {
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}` && origin !== `http://localhost:${host.split(':')[1]}`) {
    return `허용되지 않은 origin: ${origin}`;
  }
  const ct = String(req.headers['content-type'] ?? '');
  if (!ct.includes('application/json')) {
    return 'Content-Type: application/json 이 필요합니다';
  }
  return null;
}

/** 신뢰할 수 없는 입력을 Intent 로 좁힌다. 모르는 종류는 거부한다. */
function parseIntent(body: unknown): Intent | string {
  if (!body || typeof body !== 'object') return '본문이 객체가 아닙니다';
  const b = body as Record<string, unknown>;
  const kind = b.kind;
  if (typeof kind !== 'string' || !(INTENT_KINDS as string[]).includes(kind)) {
    return `알 수 없는 intent: ${String(kind)}`;
  }
  const strArray = (v: unknown): string[] | null =>
    Array.isArray(v) && v.every((s) => typeof s === 'string') ? (v as string[]) : null;

  switch (kind) {
    case 'pause':
    case 'resume':
      return { kind };
    case 'skip-add':
    case 'skip-remove':
    case 'review-now': {
      if (typeof b.ref !== 'string' || !b.ref.trim()) return 'ref 가 필요합니다';
      return { kind, ref: b.ref.trim() };
    }
    case 'only-set': {
      const refs = strArray(b.refs);
      if (!refs) return 'refs 배열이 필요합니다';
      return { kind, refs: refs.map((s) => s.trim()).filter(Boolean) };
    }
    case 'scope-set': {
      const include = strArray(b.include);
      const exclude = strArray(b.exclude);
      if (!include || !exclude) return 'include/exclude 배열이 필요합니다';
      return {
        kind,
        include: include.map((s) => s.trim()).filter(Boolean),
        exclude: exclude.map((s) => s.trim()).filter(Boolean),
      };
    }
    default:
      return `처리되지 않은 intent: ${kind}`;
  }
}

/**
 * console.log/error 를 버스로도 흘린다.
 *
 * 로깅 API 를 새로 만들어 60여 개 호출부를 고치는 대신 출력 지점 하나를 감싼다.
 * 터미널 출력은 그대로 두고 복사본만 보내므로, --ui 를 끄면 흔적이 남지 않는다.
 * 반환값은 원복 함수다.
 */
function mirrorConsole(): () => void {
  const origLog = console.log;
  const origErr = console.error;
  const fmt = (args: unknown[]): string =>
    args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 2 }))).join(' ');

  console.log = (...args: unknown[]): void => {
    origLog(...args);
    progress.log(fmt(args));
  };
  console.error = (...args: unknown[]): void => {
    origErr(...args);
    progress.log(fmt(args));
  };

  return () => {
    console.log = origLog;
    console.error = origErr;
  };
}

function sse(res: ServerResponse): (e: BusEvent | null) => void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  return (e) => {
    if (res.writableEnded) return;
    try {
      // null = 킵얼라이브 (SSE 주석 줄)
      res.write(e === null ? ': ping\n\n' : `data: ${JSON.stringify(e)}\n\n`);
    } catch {
      /* 끊긴 연결 — close 핸들러가 정리한다 */
    }
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  html: string,
  hooks: UIHooks,
  host: string,
): Promise<void> {
  const url = (req.url ?? '/').split('?')[0];

  // ── 제어 (POST) ──
  if (req.method === 'POST') {
    const denied = rejectsCrossOrigin(req, host);
    if (denied) {
      json(res, 403, { ok: false, error: denied });
      return;
    }
    try {
      const body = await readJson(req);

      if (url === '/api/intent') {
        const intent = parseIntent(body);
        if (typeof intent === 'string') {
          json(res, 400, { ok: false, error: intent });
          return;
        }
        const pending = intents.push(intent);
        progress.control({ pendingIntents: pending });
        json(res, 202, { ok: true, pending });
        return;
      }

      if (url === '/api/instructions') {
        const b = body as Record<string, unknown>;
        if (typeof b.body !== 'string') {
          json(res, 400, { ok: false, error: 'body 문자열이 필요합니다' });
          return;
        }
        const path = hooks.writeInstructions(b.body);
        json(res, 200, { ok: true, path });
        return;
      }
    } catch (e) {
      json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }

    json(res, 404, { ok: false, error: 'not found' });
    return;
  }

  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (url === '/api/instructions') {
    json(res, 200, { ok: true, body: hooks.readInstructions() });
    return;
  }

  // SSE 를 쓸 수 없는 소비자(스크립트·curl)를 위한 단발 스냅샷.
  if (url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(progress.state()));
    return;
  }

  if (url === '/events') {
    const send = sse(res);
    const { snapshot, logs } = progress.state();
    send({ type: 'snapshot', data: snapshot });
    for (const line of logs) send({ type: 'log', data: line });

    const unsubscribe = progress.subscribe(send);
    const timer = setInterval(() => send(null), KEEPALIVE_MS);
    const cleanup = (): void => {
      clearInterval(timer);
      unsubscribe();
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

/**
 * 대시보드를 띄운다. **127.0.0.1 에만 바인딩한다** — PR 제목·상태·리뷰 로그가
 * 그대로 보이므로 같은 네트워크에 노출해서는 안 된다.
 *
 * 포트가 이미 쓰이고 있으면 다음 포트로 최대 10번 물러선다. watch 를 두 개
 * 띄우거나 이전 인스턴스가 아직 안 죽은 경우가 흔한데, 그때 대시보드 하나 때문에
 * watch 가 못 뜨는 건 과한 실패다.
 */
export async function startUIServer(port: number, hooks: UIHooks): Promise<UIServerHandle> {
  const html = loadHtml();
  const restoreConsole = mirrorConsole();
  progress.enabled = true;

  let host = `127.0.0.1:${port}`;
  const server: Server = createServer((req, res) => {
    handle(req, res, html, hooks, host).catch((e) => {
      if (!res.headersSent) json(res, 500, { ok: false, error: String(e) });
      else res.end();
    });
  });
  // 열려 있는 SSE 연결이 종료를 막지 않도록.
  server.on('connection', (s) => s.unref());

  const listen = (p: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const onError = (e: NodeJS.ErrnoException): void => reject(e);
      server.once('error', onError);
      server.listen(p, '127.0.0.1', () => {
        server.removeListener('error', onError);
        resolve(p);
      });
    });

  let bound = -1;
  for (let i = 0; i < 10; i++) {
    try {
      bound = await listen(port + i);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
        restoreConsole();
        progress.enabled = false;
        throw e;
      }
    }
  }
  if (bound < 0) {
    restoreConsole();
    progress.enabled = false;
    throw new Error(`포트 ${port}–${port + 9} 가 모두 사용 중입니다. --ui-port 로 지정하세요.`);
  }

  host = `127.0.0.1:${bound}`; // 포트가 밀렸을 수 있으니 origin 검사 기준을 맞춘다

  return {
    url: `http://127.0.0.1:${bound}`,
    close: () =>
      new Promise<void>((resolve) => {
        progress.enabled = false;
        restoreConsole();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
