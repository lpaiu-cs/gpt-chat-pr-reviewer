import { patchConfigFile } from './config.js';
import type { ChatGPTDriver } from './chatgpt.js';
import { intents } from './intents.js';
import { progress, type Snapshot } from './progress.js';
import { releaseConversation } from './reviewer.js';
import { fire } from './state/machine.js';
import { listContexts, saveContext } from './state/store.js';
import type { AppConfig } from './types.js';

type User = Awaited<ReturnType<ChatGPTDriver['getSessionUser']>>;
const userKey = (user: User): string => typeof user?.id === 'string' && user.id
  ? user.id : typeof user?.email === 'string' ? user.email.toLowerCase() : '';

/** HTTP는 예약만 한다. 브라우저와 상태 파일 변경은 루프의 안전 지점에서 한다. */
export class AccountSwitch {
  state: NonNullable<Snapshot['accountSwitch']>;

  constructor(private cfg: AppConfig, private driver: () => ChatGPTDriver) {
    this.state = { phase: cfg.accountSwitchPending ? 'login' : 'idle' };
  }

  get blocked(): boolean {
    return this.state.phase !== 'idle' && this.state.phase !== 'complete';
  }

  publish(): void {
    progress.patch({ accountSwitch: { ...this.state } });
  }

  request(action: 'start' | 'complete'): void {
    if (['queued', 'opening', 'checking'].includes(this.state.phase)) {
      throw new Error('계정 전환 요청을 처리 중입니다. 잠시 기다려 주세요.');
    }
    if (action === 'complete' && !this.cfg.accountSwitchPending) {
      throw new Error('계정 변경을 먼저 시작해 주세요.');
    }
    this.state = { phase: action === 'start' ? 'queued' : 'checking' };
    this.publish();
    progress.control({ pendingIntents: intents.push({ kind: 'account-switch', action }) });
  }

  async apply(action: 'start' | 'complete'): Promise<boolean> {
    const oldProject = { chatgptProjectUrl: this.cfg.chatgptProjectUrl, chatgptProjectName: this.cfg.chatgptProjectName };
    try {
      const driver = this.driver();
      if (action === 'start') {
        this.state = { phase: 'opening' };
        this.publish();
        if (!this.cfg.accountSwitchPending) {
          const previousUser = userKey(await driver.getSessionUser());
          if (!previousUser) throw new Error('현재 계정을 확인하지 못했습니다. 브라우저 로그인 상태를 확인해 주세요.');
          // 브라우저를 건드리기 전에 저장한다. 재시작해도 검증 전에는 실행 금지.
          const pending = { previousUser };
          patchConfigFile({ accountSwitchPending: pending });
          this.cfg.accountSwitchPending = pending;
        }
        progress.patch({ ready: false, account: null });
        await driver.openAccountBrowser();
        this.state = { phase: 'login' };
        return false;
      }

      const pending = this.cfg.accountSwitchPending;
      if (!pending) throw new Error('계정 변경을 먼저 시작해 주세요.');
      const user = await driver.getSessionUser();
      const key = userKey(user);
      if (!key) throw new Error('새 계정으로 로그인한 뒤 ChatGPT 프로젝트 홈을 열어 주세요.');
      if (key === pending.previousUser) throw new Error('이전 계정이 그대로 로그인되어 있습니다. 로그아웃 후 사용할 계정으로 로그인해 주세요.');
      // 열린 프로젝트의 URL·이름을 읽고 사이드바를 통한 재진입까지 검증한다.
      await driver.registerProject();
      const project = await driver.projectEntry();
      if (userKey(await driver.getSessionUser()) !== key) throw new Error('확인 중 계정이 바뀌었습니다. 다시 확인해 주세요.');

      // 이전 계정의 대화/전송 회수/쿼터를 새 계정으로 넘기지 않는다.
      // 실패·크래시 시 pending을 남겨 일부만 정리된 상태로 실행하지 않는다.
      for (const ctx of listContexts(this.cfg)) {
        releaseConversation(ctx);
        delete ctx.quotaRetryAt;
        ctx.retryCount = 0;
        if (ctx.state === 'QUOTA_BLOCKED') fire(ctx, 'COOLDOWN_ELAPSED', { note: 'ChatGPT 계정 변경' });
        saveContext(this.cfg, ctx);
      }
      patchConfigFile({ chatgptProjectUrl: project.url, chatgptProjectName: project.name, accountSwitchPending: null });
      Object.assign(this.cfg, { chatgptProjectUrl: project.url, chatgptProjectName: project.name, accountSwitchPending: null });
      this.state = { phase: 'complete' };
      progress.patch({ ready: true, account: user?.email ?? user?.name ?? key, project, quotaUntil: null });
      console.log(`  ✓ 계정 변경 완료 — ${user?.email ?? key} · ${project.name}\n    ${project.url}`);
      return true;
    } catch (error) {
      Object.assign(this.cfg, oldProject);
      this.state = { phase: this.cfg.accountSwitchPending ? 'login' : 'idle', error: error instanceof Error ? error.message : String(error) };
      console.log(`  ⚠ 계정 변경: ${this.state.error}`);
      return false;
    } finally {
      this.publish();
    }
  }
}
