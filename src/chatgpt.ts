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

  async isLoggedIn(): Promise<boolean> {
    const p = this.requirePage();
    try {
      await p.waitForSelector(this.cfg.selectors.loggedInIndicator, { timeout: 12_000 });
      return true;
    } catch {
      return false;
    }
  }

  /** 사용자가 직접 로그인할 때까지 (최대 10분) 대기. */
  async waitForManualLogin(): Promise<void> {
    const p = this.requirePage();
    console.log(chalk.yellow('\n  ⏳ ChatGPT에 로그인해주세요 (브라우저 창 확인).'));
    console.log(chalk.yellow('     로그인이 완료되면 자동으로 계속됩니다.\n'));
    await p.waitForSelector(this.cfg.selectors.loggedInIndicator, { timeout: 600_000 });
    console.log(chalk.green('  ✓ 로그인 확인!'));
  }

  // ── 대화 ──────────────────────────────────────────────────

  /** 새 대화 시작 (chatgpt.com 루트로 이동). */
  async startNewChat(): Promise<void> {
    const p = this.requirePage();
    await p.goto(this.cfg.chatgptUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await p.waitForSelector(this.cfg.selectors.textInput, { timeout: 15_000 });
    // 기존 입력 잔여물 제거
    await p.waitForTimeout(500);
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

  /** ProseMirror contenteditable 에 텍스트를 삽입한다. */
  private async fillPrompt(page: Page, text: string): Promise<void> {
    const sel = this.cfg.selectors;
    const input = page.locator(sel.textInput);
    await input.click();

    // 방법 1: 합성 paste 이벤트
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
      { selector: sel.textInput, t: text },
    );

    if (pasted) {
      await page.waitForTimeout(300);
      const content = await input.innerText().catch(() => '');
      if (content.trim().length > 0) return; // 성공
    }

    // 방법 2: keyboard.type fallback
    console.log(chalk.dim('  paste 실패 — keyboard.type 로 재시도'));
    await input.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type(text, { delay: 2 });
  }

  private async clickSend(page: Page): Promise<void> {
    const sel = this.cfg.selectors;
    // 전송 버튼이 활성화될 때까지 잠시 대기
    await page.waitForTimeout(500);

    const sendBtn = page.locator(sel.sendButton).first();
    try {
      await sendBtn.waitFor({ state: 'visible', timeout: 5_000 });
      await sendBtn.click();
    } catch {
      // 버튼을 못 찾으면 Enter 로 대체
      console.log(chalk.dim('  send 버튼 미발견 — Enter 로 전송'));
      await page.keyboard.press('Enter');
    }
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

    // 스트리밍이 끝날 때까지 폴링
    let lastText = '';
    let stable = 0;
    const t0 = Date.now();

    while (stable < 3 && Date.now() - t0 < timeout) {
      await page.waitForTimeout(3_000);
      const cur = await page
        .locator(sel.assistantMessage)
        .last()
        .innerText()
        .catch(() => '');

      if (cur.length > 0 && cur === lastText) {
        stable++;
      } else {
        stable = 0;
        lastText = cur;
      }
    }

    if (lastText.trim().length === 0) {
      // 빈 응답 — 쿼터 한도 가능성 확인
      const quota = await this.detectQuotaLimit(page);
      if (quota) throw new QuotaLimitError(`한도 감지: "${quota}"`);
      throw new Error('ChatGPT 응답이 비어 있음');
    }

    if (stable < 3) {
      console.log(chalk.yellow('  ⚠ 응답 타임아웃 — 현재까지 수신된 텍스트를 사용합니다.'));
    } else {
      console.log(chalk.green(`  ✓ 응답 수신 완료 (${lastText.length.toLocaleString()}자)`));
    }

    return lastText;
  }
}
