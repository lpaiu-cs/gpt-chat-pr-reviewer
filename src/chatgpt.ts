/**
 * ChatGPT 웹 UI Playwright 자동화 드라이버.
 *
 * 영속 프로필(persistent context)로 Chrome 을 띄워
 * 최초 1회 수동 로그인 후 세션을 재사용한다.
 */

import { chromium, type BrowserContext, type Page } from 'playwright';
import chalk from 'chalk';
import type { AppConfig } from './types.js';

/** ChatGPT 사용량 한도 도달 — 상태 머신의 QUOTA_EXCEEDED 이벤트로 매핑된다. */
export class QuotaLimitError extends Error {
  constructor(message = 'ChatGPT 사용량 한도 도달') {
    super(message);
    this.name = 'QuotaLimitError';
  }
}

/** 스트림이 끊겼을 때 ChatGPT 가 표시하는 안내 문구. */
const INTERRUPT_PATTERNS: RegExp[] = [
  /connection interrupted/i,
  /waiting for the complete answer/i,
  /연결이 (중단|끊)/,
  /완전한 (답변|응답)을 기다/,
];

/** 연결 중단 시 새로고침으로 복구를 시도할 최대 횟수. */
const MAX_RELOAD_RECOVERIES = 3;

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
   * 프롬프트를 전송하고 응답 전문을 반환한다.
   *
   * 1. 텍스트를 입력 (클립보드 paste → 실패 시 keyboard.type fallback)
   * 2. 전송 버튼 클릭
   * 3. 어시스턴트 메시지가 안정될 때까지 폴링
   */
  async sendAndCollect(prompt: string): Promise<string> {
    const p = this.requirePage();
    const sel = this.cfg.selectors;

    // ── 기존 어시스턴트 메시지 수 기록 ──
    const before = await p.locator(sel.assistantMessage).count();

    // ── 프롬프트 입력 ──
    await this.fillPrompt(p, prompt);

    // ── 전송 ──
    await this.clickSend(p);

    // ── 응답 수집 ──
    return this.collectResponse(p, before);
  }

  // ── 내부 헬퍼 ─────────────────────────────────────────────

  private requirePage(): Page {
    if (!this.page) throw new Error('Browser not launched — call launch() first');
    return this.page;
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

    // 새 어시스턴트 메시지가 나타날 때까지 대기
    console.log(chalk.dim('  응답 대기 중...'));
    try {
      await page.locator(sel.assistantMessage).nth(messageCountBefore).waitFor({ timeout: 60_000 });
    } catch {
      // 응답이 안 오는 이유가 쿼터 한도인지 먼저 확인
      const quota = await this.detectQuotaLimit(page);
      if (quota) throw new QuotaLimitError(`한도 감지: "${quota}"`);
      throw new Error('ChatGPT 응답이 시작되지 않음 (60초 초과)');
    }

    // 메시지 컨테이너 전체를 읽으면 "Edit"·복사 버튼 같은 UI 텍스트가 섞인다.
    // 본문(.markdown)이 있으면 그쪽을 읽고, 없을 때만 컨테이너로 폴백한다.
    const readLatest = async (): Promise<string> => {
      const msg = page.locator(sel.assistantMessage).last();
      const body = msg.locator(sel.messageContent).last();
      if ((await body.count()) > 0) {
        return body.innerText().catch(() => '');
      }
      return msg.innerText().catch(() => '');
    };

    let lastText = '';
    let stable = 0;
    let recoveries = 0;
    let lastLogAt = Date.now();
    const t0 = Date.now();

    while (Date.now() - t0 < timeout) {
      await page.waitForTimeout(3_000);

      const cur = await readLatest();
      if (cur.length > 0 && cur === lastText) {
        stable++;
      } else {
        stable = 0;
        lastText = cur;
      }

      const streaming = await this.isStreaming(page);

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
        const state = streaming ? '생성 중' : lastText ? '대기' : '추론 중';
        console.log(
          chalk.dim(`    …${sec}초 경과 · ${state} · ${lastText.length.toLocaleString()}자`),
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
