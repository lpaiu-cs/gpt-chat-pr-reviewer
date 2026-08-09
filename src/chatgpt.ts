/**
 * ChatGPT 웹 UI Playwright 자동화 드라이버.
 *
 * 영속 프로필(persistent context)로 Chrome 을 띄워
 * 최초 1회 수동 로그인 후 세션을 재사용한다.
 */

import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import chalk from 'chalk';
import { progress } from './progress.js';
import type { AppConfig } from './types.js';

/** ChatGPT 사용량 한도 도달 — 상태 머신의 QUOTA_EXCEEDED 이벤트로 매핑된다. */
export class QuotaLimitError extends Error {
  constructor(message = 'ChatGPT 사용량 한도 도달') {
    super(message);
    this.name = 'QuotaLimitError';
  }
}

/** 대화에서 읽어온 메시지 하나 (역할 + 본문). */
export interface ConversationMessage {
  role: string;
  text: string;
}

/**
 * 이 대화에서 그 라운드 질문이 **마지막 질문**인지 보고, 맞으면 그 질문 직전까지의
 * 어시스턴트 메시지 수를 돌려준다 (없으면 null).
 *
 * 이 숫자가 응답 수집의 기준점이다. 다시 세면 안 된다 — 대상 응답의 노드가 이미
 * 만들어져 스트리밍 중이면 그것까지 기준에 포함돼, 오지 않을 **그 다음** 메시지를
 * 60초 기다리다 실패한다.
 *
 * **마지막 질문일 때만** 인정한다. 뒤에 다른 질문이 이어져 있으면 "우리가 묻고
 * 기다리는 중" 이 아니라 이미 진행된 대화이므로, 어느 응답이 그 라운드 것인지
 * 단정할 수 없다. 그때는 null 을 돌려 평소 경로(다시 묻기)로 보낸다.
 */
export function findRoundBaseline(msgs: ConversationMessage[], marker: string): number | null {
  let lastUser = -1;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === 'user') lastUser = i;
  }
  if (lastUser < 0 || !msgs[lastUser].text.includes(marker)) return null;
  return msgs.slice(0, lastUser).filter((m) => m.role === 'assistant').length;
}

/** 전송 후 대화 주소(/c/<uuid>)가 확정되기를 기다리는 최대 시간. */
const CONVERSATION_URL_TIMEOUT_MS = 15_000;

/** 스트림이 끊겼을 때 ChatGPT 가 표시하는 안내 문구. */
const INTERRUPT_PATTERNS: RegExp[] = [
  /connection interrupted/i,
  /waiting for the complete answer/i,
  /연결이 (중단|끊)/,
  /완전한 (답변|응답)을 기다/,
];

/** 연결 중단 시 새로고침으로 복구를 시도할 최대 횟수. */
const MAX_RELOAD_RECOVERIES = 3;

/** 응답이 시작도 안 한 채 조용할 때 한도를 다시 확인하는 주기. */
const QUOTA_RECHECK_MS = 30_000;

/** 전송 전, 진행 중인 생성이 끝나기를 기다리는 폴링 간격. */
const IDLE_POLL_MS = 3_000;

/**
 * 어시스턴트 메시지의 **안정적 식별자**.
 *
 * 위치(`nth`)로 붙잡으면 DOM 재렌더·가상화 때 다른 메시지를 가리킬 수 있다 —
 * 9차 라운드가 7차 응답을 게시한 경로가 그것이다. 노드가 뜨는 즉시 이 값으로
 * 고정해 이후 읽기가 항상 같은 메시지를 향하게 한다.
 */
const MESSAGE_ID_ATTR = 'data-message-id';

/** 식별자를 못 잡았을 때, 축소 관측을 이만큼 연속으로 보면 수집 실패로 본다. */
const SHRINK_TOLERANCE = 3;

/** 기존 메시지 렌더링이 끝났다고 인정할 연속 동일 관측 횟수·간격·최대 대기. */
const SETTLE_STABLE_READS = 3;
const SETTLE_POLL_MS = 500;
const SETTLE_MAX_MS = 15_000;

/** 대화를 열 수 없을 때 ChatGPT 가 본문에 표시하는 문구 (삭제·타 계정 등). */
const CONVERSATION_GONE_PATTERNS: RegExp[] = [
  /unable to load (?:the )?conversation/i,
  /conversation not found/i,
  /대화를 불러올 수 없/,
  /대화를 찾을 수 없/,
];

/**
 * 대화 URL 여부를 판별해 정규화한다 (아니면 null).
 *
 * ChatGPT 는 첫 메시지를 보낸 뒤에야 주소를 /c/<uuid> 로 바꾼다.
 * 프로젝트·GPTs 안에서 열린 대화는 /g/<id>/c/<uuid> 형태이므로 둘 다 받는다.
 */
export function parseConversationUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname;
  const onChatGPT = host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host.endsWith('.openai.com');
  if (!onChatGPT) return null;
  if (!/^(?:\/g\/[^/]+)?\/c\/[0-9a-zA-Z-]+$/.test(u.pathname)) return null;
  return `${u.origin}${u.pathname}`; // 쿼리·프래그먼트는 버린다
}

/** 화면 텍스트에서 쿼터/한도 안내를 감지하기 위한 패턴. */
const QUOTA_PATTERNS: RegExp[] = [
  /reached (?:your|the)[^.]{0,40}limit/i,
  /message (?:cap|limit)/i,
  /usage cap/i,
  /too many (?:requests|messages)/i,
  /try again (?:later|in|after)/i,
  /한도에 도달/,
  /사용량 한도/,
  /메시지 한도/,
];

export class ChatGPTDriver {
  private ctx: BrowserContext | null = null;
  private page: Page | null = null;
  private readonly cfg: AppConfig;

  constructor(config: AppConfig) {
    this.cfg = config;
  }

  // ── 라이프사이클 ──────────────────────────────────────────

  async launch(): Promise<void> {
    this.ctx = await chromium.launchPersistentContext(this.cfg.browserProfileDir, {
      channel: this.cfg.browserChannel as any,
      headless: this.cfg.headless,
      viewport: { width: 1280, height: 900 },
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
    this.page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
  }

  async close(): Promise<void> {
    if (this.ctx) {
      await this.ctx.close();
      this.ctx = null;
      this.page = null;
    }
  }

  // ── 로그인 ────────────────────────────────────────────────

  async navigateToChatGPT(): Promise<void> {
    const p = this.requirePage();
    await p.goto(this.cfg.chatgptUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  }

  /** 현재 페이지가 ChatGPT 오리진에 있는지. */
  private isOnChatGPT(page: Page): boolean {
    try {
      const h = new URL(page.url()).hostname;
      return h === 'chatgpt.com' || h.endsWith('.chatgpt.com') || h.endsWith('.openai.com');
    } catch {
      return false; // about:blank 등
    }
  }

  /** ChatGPT 세션 쿠키 보유 여부 — 페이지 위치와 무관하게 판별 가능. */
  private async hasSessionCookie(): Promise<boolean> {
    try {
      const cookies = (await this.ctx?.cookies()) ?? [];
      return cookies.some(
        (c) =>
          c.name.includes('next-auth.session-token') &&
          c.domain.includes('chatgpt.com') &&
          !!c.value,
      );
    } catch {
      return false;
    }
  }

  /**
   * 로그인된 계정 정보를 반환한다 (로그아웃이면 null).
   * ChatGPT 오리진에 있을 때만 조회 가능하다.
   */
  async getSessionUser(): Promise<{ email?: string; name?: string } | null> {
    const p = this.requirePage();
    if (!this.isOnChatGPT(p)) return null;
    try {
      return await p.evaluate(async () => {
        const r = await fetch('/api/auth/session', { credentials: 'include' });
        if (!r.ok) return null;
        const j = (await r.json().catch(() => null)) as any;
        if (!j?.user) return null;
        return { email: j.user.email, name: j.user.name };
      });
    } catch {
      return null; // 네비게이션 중 등
    }
  }

  /**
   * 실제 인증 여부를 판별한다.
   *
   * 주의 1: 로그아웃 상태의 chatgpt.com 도 입력창(#prompt-textarea)을 그대로 노출하므로
   *         DOM 요소 존재만으로는 판별할 수 없다.
   * 주의 2: OAuth 진행 중에는 accounts.google.com 등 외부 오리진에 있게 된다.
   *         "ChatGPT 로그인 버튼이 안 보인다" 는 인증의 근거가 될 수 없다.
   *         (이 휴리스틱 때문에 구글 로그인 화면에서 인증됨으로 오판한 적이 있다)
   */
  async isLoggedIn(): Promise<boolean> {
    const p = this.requirePage();

    // ChatGPT 오리진에 있으면 세션 엔드포인트가 가장 정확하다.
    if (this.isOnChatGPT(p)) {
      const user = await this.getSessionUser();
      if (user) return true;
      // 엔드포인트가 응답했는데 user 가 없으면 로그아웃.
      // 단, 차단·오류로 조회 자체가 실패했을 수 있어 쿠키로 한 번 더 확인한다.
      return this.hasSessionCookie();
    }

    // 외부 오리진(OAuth 진행 중 등) — 쿠키로만 판단한다.
    return this.hasSessionCookie();
  }

  /** 사용자가 직접 로그인할 때까지 (최대 10분) 대기. */
  async waitForManualLogin(): Promise<void> {
    console.log(chalk.yellow('\n  ⏳ ChatGPT에 로그인해주세요 (브라우저 창 확인).'));
    console.log(chalk.yellow('     로그인이 완료되면 자동으로 계속됩니다.\n'));

    const deadline = Date.now() + 600_000;
    let notified = false;

    while (Date.now() < deadline) {
      const p = this.requirePage();

      // OAuth 등 외부 오리진에 있는 동안은 완료로 보지 않는다.
      if (!this.isOnChatGPT(p)) {
        if (!notified) {
          console.log(chalk.dim(`     (${new URL(p.url()).hostname} 에서 인증 진행 중…)`));
          notified = true;
        }
        await p.waitForTimeout(3_000);
        continue;
      }
      notified = false;

      const user = await this.getSessionUser();
      if (user) {
        const who = user.email ?? user.name ?? '계정 확인됨';
        console.log(chalk.green(`  ✓ 로그인 확인 — ${who}`));
        return;
      }

      await p.waitForTimeout(3_000);
    }
    throw new Error('로그인 대기 시간 초과 (10분)');
  }

  // ── 대화 ──────────────────────────────────────────────────

  /** 새 대화 시작 (chatgpt.com 루트로 이동). */
  async startNewChat(): Promise<void> {
    const p = this.requirePage();
    await p.goto(this.cfg.chatgptUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await p.waitForSelector(this.cfg.selectors.textInput, { timeout: 15_000 });
    // 새 대화 진입 시 뜨는 안내 모달을 닫고, 하이드레이션이 끝날 여유를 준다
    await p.keyboard.press('Escape').catch(() => {});
    await p.waitForTimeout(1_000);
  }

  /**
   * 기존 대화로 복귀한다. 열지 못하면 false 를 반환한다 (호출부가 새 대화로 폴백).
   *
   * 대화가 삭제됐거나 다른 계정의 것이면 ChatGPT 는 오류 문구를 띄우거나
   * 루트로 되돌린다. 둘 다 "복귀 실패" 로 취급해야 이전 대화에 이어 쓴 것처럼
   * 착각한 채 엉뚱한 화면에 프롬프트를 넣는 일을 막을 수 있다.
   */
  async resumeChat(url: string, opts: { requireAssistant?: boolean } = {}): Promise<boolean> {
    const p = this.requirePage();
    const want = parseConversationUrl(url);
    if (!want) return false;

    try {
      await p.goto(want, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await p.waitForSelector(this.cfg.selectors.textInput, { timeout: 15_000 });
    } catch {
      return false;
    }
    await p.keyboard.press('Escape').catch(() => {});
    await p.waitForTimeout(1_000);

    // 접근 불가 시 루트나 다른 대화로 튕긴다
    if (parseConversationUrl(p.url()) !== want) return false;

    const body = await p
      .locator('body')
      .innerText()
      .catch(() => '');
    if (CONVERSATION_GONE_PATTERNS.some((re) => re.test(body))) return false;

    // 이전 라운드의 응답이 하나도 안 보이면 본문 로드에 실패한 것이다.
    // 그대로 진행하면 sendAndCollect 가 기존 메시지를 새 응답으로 오인한다.
    //
    // 다만 **응답이 오기 전에 죽은 대화**는 어시스턴트 메시지가 하나도 없는 게
    // 정상이다. 그걸 실패로 보면 대화를 놓아버리고 같은 질문을 새 창에 다시 보내게
    // 된다 — 이 검사가 막으려던 것보다 나쁜 결과다. 재전송하지 않는 경로
    // (findRound 로 확인만 하는 복구)에서는 이 검사를 건너뛴다.
    if (opts.requireAssistant === false) return true;
    try {
      await p
        .locator(this.cfg.selectors.assistantMessage)
        .first()
        .waitFor({ state: 'attached', timeout: 15_000 });
    } catch {
      return false;
    }
    return true;
  }

  /** 현재 페이지가 대화 화면이면 그 URL, 아니면 null. */
  currentConversationUrl(): string | null {
    return parseConversationUrl(this.requirePage().url());
  }

  /**
   * 프롬프트를 전송하고 응답 전문을 반환한다.
   *
   * 1. 텍스트를 입력 (클립보드 paste → 실패 시 keyboard.type fallback)
   * 2. 전송 버튼 클릭
   * 3. 어시스턴트 메시지가 안정될 때까지 폴링
   */
  async sendAndCollect(
    prompt: string,
    onSent?: (conversationUrl: string | null) => void,
  ): Promise<string> {
    const p = this.requirePage();

    // ── 진행 중인 생성이 끝나기를 기다린다 ──
    // 생성 중에 프롬프트를 넣으면 전송 버튼 자리가 **중지 버튼**이라 진행 중인
    // 응답을 끊는다 (ChatGPT 가 중단 여부를 되묻는다). 우리 쪽에서 라운드를 실패로
    // 접었어도 브라우저는 아직 답을 만들고 있을 수 있으므로 — 실제로 그렇게
    // 사고가 났다 — 보내기 전에 반드시 확인한다.
    await this.waitUntilIdle(p);

    // ── 기존 어시스턴트 메시지 수 기록 ──
    // 이어가는 대화에서는 지난 응답들이 순차적으로 렌더링되므로, 개수가 멎기 전에
    // 세면 실제보다 작게 잡힌다. 그러면 collectResponse 가 "새 응답이 이미 도착했다"
    // 고 오인해 직전 라운드의 응답을 그대로 반환한다.
    const before = await this.countSettledMessages(p);

    // ── 프롬프트 입력 ──
    await this.fillPrompt(p, prompt);

    // ── 전송 ──
    await this.clickSend(p);

    // ── 대화 주소 확보 ──
    // **응답을 기다리기 전에** 알린다. 대기 구간이 2~15분이라 그 사이에 프로세스가
    // 죽으면, 여기서 안 남겨둔 URL 은 영영 잃는다. 그러면 다음 라운드가 대화가 없는
    // 줄 알고 새 창을 열어 **같은 질문을 다시 보낸다** (대화 한도를 그냥 버린다).
    if (onSent) onSent(await this.waitForConversationUrl(p));

    // ── 응답 수집 ──
    return this.collectResponse(p, before);
  }

  /**
   * 이미 보낸 프롬프트의 응답을 기다린다 (재전송 없이).
   *
   * 복귀했더니 그 라운드 질문은 이미 가 있고 답만 없는 경우에 쓴다.
   */
  async collectPending(): Promise<string> {
    const p = this.requirePage();
    return this.collectResponse(p, await this.countSettledMessages(p));
  }

  /**
   * 이 대화에 그 라운드 질문이 이미 있는지, 답까지 나왔는지 본다.
   *
   *   answered — 답이 있다. 다시 묻지 말고 그대로 쓴다.
   *   pending  — 질문만 있고 답이 없다. 다시 묻지 말고 기다린다.
   *   absent   — 그 라운드 질문이 없다. 새로 보내야 한다.
   *
   * 판별 실패는 전부 absent 로 떨어뜨린다 — 잘못 answered 로 보면 낡은 응답을
   * 게시하게 되고, 그건 다시 묻는 것보다 훨씬 나쁘다.
   */
  /**
   * 이 대화에 그 라운드 질문이 이미 있는지 본다.
   *
   * 있으면 응답 수집의 기준점(그 질문 직전까지의 어시스턴트 메시지 수)을 돌려준다.
   * 판별 실패는 전부 null 로 떨어뜨린다 — 잘못 "있다" 고 보면 엉뚱한 응답을
   * 게시하게 되고, 그건 다시 묻는 것보다 훨씬 나쁘다.
   */
  async findRound(marker: string): Promise<number | null> {
    const p = this.requirePage();
    await this.countSettledMessages(p); // 렌더가 멎을 때까지 기다린다

    // selectors.assistantMessage 를 일반화한 형태다 — 역할별로 나눠 읽어야
    // "그 질문이 마지막인가" 를 판정할 수 있다.
    try {
      const msgs = await p.evaluate((contentSel) => {
        return [...document.querySelectorAll('[data-message-author-role]')].map((el) => ({
          role: el.getAttribute('data-message-author-role') ?? '',
          text: (el.querySelector(contentSel) ?? el).textContent ?? '',
        }));
      }, this.cfg.selectors.messageContent);
      return findRoundBaseline(msgs, marker);
    } catch {
      return null;
    }
  }

  /**
   * 이미 보낸 프롬프트의 응답을 기준점부터 수집한다 (재전송 없이).
   *
   * 기준점을 findRound 가 준 값으로 쓰는 것이 핵심이다. 여기서 다시 세면 스트리밍
   * 중인 대상 노드가 기준에 포함돼 영영 오지 않을 다음 메시지를 기다리게 된다.
   * 완료 판정(스트리밍 종료 + 내용 안정)은 collectResponse 가 그대로 맡는다 —
   * 그래서 스트리밍 중인 부분 응답을 완성본으로 오인하지 않는다.
   */
  async collectFrom(assistantBefore: number): Promise<string> {
    return this.collectResponse(this.requirePage(), assistantBefore);
  }

  /**
   * 전송 직후 대화 주소가 확정될 때까지 짧게 기다린다.
   *
   * 새 대화는 첫 메시지를 보낸 뒤에야 /c/<uuid> 로 바뀐다. 이어가는 대화면 이미
   * 그 주소이므로 즉시 돌아온다.
   */
  private async waitForConversationUrl(page: Page): Promise<string | null> {
    const deadline = Date.now() + CONVERSATION_URL_TIMEOUT_MS;
    for (;;) {
      const url = parseConversationUrl(page.url());
      if (url) return url;
      if (Date.now() >= deadline) return null;
      await page.waitForTimeout(500);
    }
  }

  // ── 내부 헬퍼 ─────────────────────────────────────────────

  private requirePage(): Page {
    if (!this.page) throw new Error('Browser not launched — call launch() first');
    return this.page;
  }

  /**
   * 어시스턴트 메시지 개수가 더 늘지 않을 때까지 기다렸다가 그 값을 반환한다.
   *
   * 한 번 같았다고 끝내면 안 된다. 복귀가 느린 대화에서는 과거 응답 1건만 뜬 채로
   * 잠시 멎었다가 나머지가 뒤늦게 붙는데, 그 사이에 개수를 확정하면 늦게 도착한
   * **과거 응답을 새 응답의 시작으로 오인**한다. 연속으로 여러 번 같아야 확정한다.
   * 새 대화(0건)에서도 판정은 거치지만 몇 초짜리라 라운드 시간에 비해 무시할 수준.
   */
  private async countSettledMessages(page: Page): Promise<number> {
    const loc = page.locator(this.cfg.selectors.assistantMessage);
    const deadline = Date.now() + SETTLE_MAX_MS;
    let last = -1;
    let stable = 0;

    while (Date.now() < deadline) {
      const cur = await loc.count().catch(() => last);
      stable = cur === last ? stable + 1 : 0;
      last = cur;
      if (stable >= SETTLE_STABLE_READS) return cur;
      await page.waitForTimeout(SETTLE_POLL_MS);
    }

    // 계속 늘어나는 중 — 마지막 관측값으로 진행하되 조용히 넘어가지는 않는다
    console.log(
      chalk.yellow(`  ⚠ 기존 메시지 수가 안정되지 않았습니다 — ${last}건 기준으로 진행합니다.`),
    );
    return last;
  }

  /** 화면 하단 텍스트에서 쿼터 한도 안내를 탐지한다 (없으면 null). */
  private async detectQuotaLimit(page: Page): Promise<string | null> {
    const body = await page
      .locator('body')
      .innerText()
      .catch(() => '');
    const tail = body.slice(-4_000); // 최근 화면 영역만 검사
    for (const re of QUOTA_PATTERNS) {
      const m = tail.match(re);
      if (m) return m[0];
    }
    return null;
  }

  /** 입력창에 실제 텍스트가 들어갔는지 확인. */
  private async inputHasText(page: Page): Promise<boolean> {
    const t = await page
      .locator(this.cfg.selectors.textInput)
      .first()
      .innerText()
      .catch(() => '');
    return t.trim().length > 0;
  }

  /**
   * 입력창에 포커스를 준다.
   *
   * 모달·오버레이·하이드레이션 지연으로 실제 클릭이 actionable 하지 않을 수 있으므로
   * (관측: locator.click 30초 타임아웃) 클릭이 실패하면 JS 포커스로 대체한다.
   */
  private async focusInput(page: Page): Promise<void> {
    const sel = this.cfg.selectors;
    const input = page.locator(sel.textInput).first();
    await input.waitFor({ state: 'visible', timeout: 20_000 });

    try {
      await input.click({ timeout: 10_000 });
      return;
    } catch {
      console.log(chalk.dim('  입력창 클릭 실패 — 모달 해제 후 JS 포커스로 대체'));
    }

    // 떠 있는 모달·팝오버를 닫아본다
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);

    try {
      await input.click({ timeout: 5_000 });
      return;
    } catch {
      /* JS 포커스로 진행 */
    }

    const focused = await page.evaluate((selector: string) => {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el) return false;
      el.focus();
      return document.activeElement === el || el.contains(document.activeElement);
    }, sel.textInput);

    if (!focused) {
      throw new Error('프롬프트 입력창에 포커스할 수 없습니다 — 브라우저 화면 상태를 확인하세요');
    }
  }

  /** ProseMirror contenteditable 에 텍스트를 삽입한다. */
  private async fillPrompt(page: Page, text: string): Promise<void> {
    await this.focusInput(page);
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');

    // 방법 1: CDP insertText — contenteditable 에 가장 안정적이고 빠르다
    await page.keyboard.insertText(text);
    await page.waitForTimeout(200);
    if (await this.inputHasText(page)) return;

    // 방법 2: 합성 paste 이벤트
    const pasted = await page.evaluate(
      ({ selector, t }: { selector: string; t: string }) => {
        const el = document.querySelector(selector) as HTMLElement | null;
        if (!el) return false;
        el.focus();
        const dt = new DataTransfer();
        dt.setData('text/plain', t);
        return el.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
        );
      },
      { selector: this.cfg.selectors.textInput, t: text },
    );
    if (pasted) {
      await page.waitForTimeout(300);
      if (await this.inputHasText(page)) return;
    }

    // 방법 3: keyboard.type
    console.log(chalk.dim('  insertText·paste 실패 — keyboard.type 로 재시도'));
    await this.focusInput(page);
    await page.keyboard.type(text, { delay: 1 });
    if (!(await this.inputHasText(page))) {
      throw new Error('프롬프트 입력 실패 — textInput 셀렉터를 확인하세요');
    }
  }

  private async clickSend(page: Page): Promise<void> {
    // 전송 버튼이 활성화될 때까지 잠시 대기
    await page.waitForTimeout(600);

    // 설정된 셀렉터를 먼저, 그다음 알려진 후보들을 순서대로 시도
    const candidates = [
      this.cfg.selectors.sendButton,
      '#composer-submit-button',
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="보내기"]',
    ];

    for (const c of candidates) {
      const btn = page.locator(c).first();
      try {
        if (await btn.isVisible({ timeout: 1_500 })) {
          await btn.click();
          return;
        }
      } catch {
        /* 다음 후보 */
      }
    }

    console.log(chalk.dim('  send 버튼 미발견 — Enter 로 전송'));
    await page.keyboard.press('Enter');
  }

  /**
   * 어시스턴트 응답이 완전히 스트리밍 될 때까지 폴링한다.
   * 3회 연속 동일 텍스트이면 완료로 간주.
   */
  private async collectResponse(page: Page, messageCountBefore: number): Promise<string> {
    const sel = this.cfg.selectors;
    const timeout = this.cfg.responseTimeoutMs;

    // 응답 시작을 **따로 기다리지 않는다.** 예전에는 여기서 60초 안에 어시스턴트
    // 노드가 안 뜨면 실패로 던졌는데, 추론 모드는 첫 노드가 뜨기까지 몇 분이 걸린다
    // ("Worked for 8m30s"). 정상 응답을 절단하고 라운드를 버린 뒤 같은 질문을 다시
    // 보내게 되므로, 이 프로젝트에서 가장 비싼 실패 방향이다.
    //
    // 예산은 responseTimeoutMs 하나로 통일한다. 아래 루프가 노드가 없는 동안에도
    // 빈 문자열을 읽으며 돌고, 완료 조건이 "내용이 있고 안정" 이라 조기 종료하지
    // 않는다. 한도 감지는 루프 안에서 주기적으로 한다 (예전엔 60초 catch 에만
    // 있어서, 그 시점을 넘기면 한도를 영영 못 봤다).
    progress.phase('waiting');
    console.log(chalk.dim('  응답 대기 중...'));

    // **기다린 그 노드를 읽는다.** `.last()` 로 읽으면 안 된다 — 기다리는 대상과
    // 읽는 대상이 갈리면 **엉뚱한 메시지를 응답으로 저장해 게시한다.** 실제로 9차
    // 라운드가 7차의 응답을 그대로 게시했다 (관측 길이가 845자로 272초 고정되다가
    // 341자로 급감 — 스트리밍이면 있을 수 없는 변화다).
    //
    // 위치(nth)조차 재렌더·가상화 때 다른 메시지를 가리킬 수 있으므로, 노드가 뜨는
    // 즉시 **식별자로 고정**한다. 그 뒤로는 DOM 이 어떻게 흔들려도 같은 메시지만
    // 읽는다. 고정 후 노드가 사라지면 그건 진짜 이상이므로 수집을 실패시킨다 —
    // 다른 메시지를 대신 읽어 게시하는 것보다 낫다.
    let boundId: string | null = null;
    const targetLocator = (): Locator =>
      boundId
        ? page.locator(`[${MESSAGE_ID_ATTR}="${boundId}"]`)
        : page.locator(sel.assistantMessage).nth(messageCountBefore);

    const bindTarget = async (): Promise<void> => {
      if (boundId) return;
      const byIndex = page.locator(sel.assistantMessage).nth(messageCountBefore);
      if ((await byIndex.count().catch(() => 0)) === 0) return;
      const id = await byIndex.getAttribute(MESSAGE_ID_ATTR).catch(() => null);
      // 따옴표가 섞이면 셀렉터가 깨진다 — 그때는 위치 기반으로 남고 축소 방어가 맡는다.
      if (id && !/["\\]/.test(id)) boundId = id;
    };

    // 메시지 컨테이너 전체를 읽으면 "Edit"·복사 버튼 같은 UI 텍스트가 섞인다.
    // 본문(.markdown)이 있으면 그쪽을 읽는다. 한 메시지 안에 본문 블록이 여러 개면
    // (산문 + 코드블록 + 산문) **전부 이어 붙인다** — 마지막 하나만 집으면 JSON 이
    // 앞에 있을 때 통째로 잃는다.
    const readTarget = async (): Promise<string> => {
      const target = targetLocator();
      const bodies = target.locator(sel.messageContent);
      if ((await bodies.count().catch(() => 0)) > 0) {
        const parts = await bodies.allInnerTexts().catch(() => [] as string[]);
        return parts.join('\n').trim();
      }
      return target.innerText().catch(() => '');
    };

    let lastText = '';
    let stable = 0;
    let shrinks = 0;
    let recoveries = 0;
    let lastLogAt = Date.now();
    let lastQuotaCheckAt = Date.now();
    const t0 = Date.now();

    while (Date.now() - t0 < timeout) {
      await page.waitForTimeout(3_000);

      await bindTarget();

      // 고정한 노드가 사라졌다 — DOM 이 통째로 갈렸다는 뜻이다. 위치로 물러서서
      // 아무 메시지나 읽으면 그게 바로 낡은 응답 게시다.
      if (boundId && (await targetLocator().count().catch(() => 0)) === 0) {
        throw new Error('수집 중이던 응답 노드가 사라졌습니다 (대화 화면이 바뀐 것으로 보입니다).');
      }

      const cur = await readTarget();

      // 식별자를 못 잡아 위치로 읽는 중이라면, **짧아진 값을 채택하지 않는다.**
      // 생성 중인 응답은 길어지기만 하므로 축소는 다른 노드를 읽었다는 신호다.
      // (경고만 하고 덮어쓰면 그 값이 3회 안정 관측을 통과해 그대로 게시된다.)
      if (!boundId && lastText.length > 0 && cur.length < lastText.length) {
        shrinks++;
        console.log(
          chalk.yellow(
            `  ⚠ 읽은 응답이 짧아졌습니다 (${lastText.length.toLocaleString()} → ` +
              `${cur.length.toLocaleString()}자) — 다른 노드로 보고 채택하지 않습니다 ` +
              `(${shrinks}/${SHRINK_TOLERANCE}).`,
          ),
        );
        stable = 0;
        if (shrinks >= SHRINK_TOLERANCE) {
          throw new Error('읽는 응답 노드가 계속 바뀝니다 — 낡은 응답을 게시하지 않기 위해 중단합니다.');
        }
        continue;
      }
      shrinks = 0;

      if (cur.length > 0 && cur === lastText) {
        stable++;
      } else {
        stable = 0;
        lastText = cur;
      }

      const streaming = await this.isStreaming(page);
      const phase = streaming ? '생성 중' : lastText ? '대기' : '추론 중';

      // 아직 아무것도 안 나왔고 생성 중도 아니면 한도에 막힌 것일 수 있다.
      // 예전에는 이 검사가 "60초 시작 타임아웃" catch 에만 있어서, 그 시점을
      // 넘기면 한도를 영영 못 보고 15분을 기다렸다.
      if (!streaming && !lastText && Date.now() - lastQuotaCheckAt > QUOTA_RECHECK_MS) {
        lastQuotaCheckAt = Date.now();
        const quota = await this.detectQuotaLimit(page);
        if (quota) throw new QuotaLimitError(`한도 감지: "${quota}"`);
      }

      // 터미널은 30초마다 한 줄이지만 UI 는 폴링마다 갱신한다 — 이 구간이 2~15분
      // 이라 "멈춘 건지 도는 건지" 를 실시간으로 보여주는 게 관측의 핵심이다.
      // (이슈 #1 의 원인 미상 타임아웃도 여기 기록이 남아야 나중에 짚을 수 있다.)
      progress.stream(phase, lastText.length);

      // 완료 조건: 생성이 끝났고, 내용이 있고, 여러 번 동일
      if (!streaming && lastText.trim().length > 0 && stable >= 3) {
        console.log(chalk.green(`  ✓ 응답 수신 완료 (${lastText.length.toLocaleString()}자)`));
        return lastText;
      }

      // "Connection interrupted" — 스트림이 끊긴 상태. 서버에는 응답이 완성돼 있으므로
      // 대화를 새로고침하면 완성본을 가져올 수 있다.
      if (!streaming && (await this.hasInterruptedBanner(page))) {
        if (recoveries >= MAX_RELOAD_RECOVERIES) {
          throw new Error(
            `연결 중단이 반복됩니다 (${recoveries}회 복구 시도). 브라우저 창에서 상태를 확인하세요.`,
          );
        }
        recoveries++;
        console.log(
          chalk.yellow(
            `  ⚠ 연결 중단 감지 — 대화를 새로고침해 완성된 응답을 가져옵니다 (${recoveries}/${MAX_RELOAD_RECOVERIES})`,
          ),
        );
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
        await page.waitForTimeout(6_000);
        stable = 0;
        lastText = '';
        continue;
      }

      // 진행 상황 — 멈춘 것처럼 보이지 않게 30초마다 출력
      if (Date.now() - lastLogAt > 30_000) {
        lastLogAt = Date.now();
        const sec = Math.round((Date.now() - t0) / 1000);
        console.log(
          chalk.dim(`    …${sec}초 경과 · ${phase} · ${lastText.length.toLocaleString()}자`),
        );
      }
    }

    // ── 타임아웃 ──
    if (lastText.trim().length > 0) {
      console.log(chalk.yellow('  ⚠ 응답 타임아웃 — 현재까지 수신된 텍스트를 사용합니다.'));
      return lastText;
    }

    const quota = await this.detectQuotaLimit(page);
    if (quota) throw new QuotaLimitError(`한도 감지: "${quota}"`);
    throw new Error(
      `응답을 수신하지 못했습니다 (${Math.round(timeout / 60_000)}분 대기). ` +
        '브라우저 창에서 ChatGPT 상태를 확인하거나 responseTimeoutMs 를 늘려보세요.',
    );
  }

  /**
   * 진행 중인 생성이 끝날 때까지 기다린다 (전송 직전 가드).
   *
   * 우리 라운드가 실패로 끝나도 브라우저의 생성은 계속된다. 그 위에 새 프롬프트를
   * 넣으면 **남의 답을 끊는다** — 대화 한도를 쓰고 만든 답을 버리는 셈이라, 기다려서
   * 라운드가 느려지는 것보다 훨씬 비싸다. 예산은 응답 대기와 같은 값을 쓴다.
   */
  private async waitUntilIdle(page: Page): Promise<void> {
    if (!(await this.isStreaming(page))) return;

    console.log(chalk.yellow('  ⚠ 이전 응답이 아직 생성 중입니다 — 끊지 않도록 기다립니다.'));
    progress.phase('waiting');
    const deadline = Date.now() + this.cfg.responseTimeoutMs;
    while (await this.isStreaming(page)) {
      if (Date.now() > deadline) {
        throw new Error(
          '이전 응답이 계속 생성 중이라 전송을 보류했습니다 — 끊지 않기 위해 라운드를 넘깁니다.',
        );
      }
      await page.waitForTimeout(IDLE_POLL_MS);
    }
    console.log(chalk.dim('  이전 생성이 끝났습니다 — 전송을 계속합니다.'));
  }

  /** 생성 중지 버튼이 있으면 아직 스트리밍 중. */
  private async isStreaming(page: Page): Promise<boolean> {
    try {
      return (await page.locator(this.cfg.selectors.stopButton).count()) > 0;
    } catch {
      return false;
    }
  }

  /** "Connection interrupted" 배너 감지. */
  private async hasInterruptedBanner(page: Page): Promise<boolean> {
    const body = await page
      .locator('body')
      .innerText()
      .catch(() => '');
    return INTERRUPT_PATTERNS.some((re) => re.test(body.slice(-4_000)));
  }
}
