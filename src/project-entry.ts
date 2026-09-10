import type { Page } from 'playwright';
import { chatgptProjectId, requireProjectUrl } from './config.js';

export interface ProjectEntry { url: string; name: string }

export async function readProjectEntry(page: Page, input: string): Promise<ProjectEntry> {
  const url = requireProjectUrl(page.url());
  await page.locator(input).waitFor({ state: 'visible', timeout: 15_000 });
  const name = (await page.getByRole('heading', { level: 1 }).innerText()).trim();
  if (!name) throw new Error('프로젝트 이름을 읽지 못했습니다. 프로젝트 홈을 열어 주세요.');
  return { url, name };
}

/** 전체 문서 로딩 대신 ChatGPT의 화면 내부 이동을 사용한다. 이름은 탐색용, ID가 신원이다. */
export async function enterProject(page: Page, entry: ProjectEntry, input: string): Promise<void> {
  const expected = chatgptProjectId(requireProjectUrl(entry.url));
  if (!entry.name?.trim()) throw new Error('프로젝트 이름 등록이 필요합니다. npm run dev -- setup 으로 프로젝트를 열고 등록하세요.');
  const editor = page.locator(input);
  const onHome = () => chatgptProjectId(page.url()) === expected && /\/project\/?$/.test(new URL(page.url()).pathname);
  if (!onHome() || !(await editor.isVisible())) {
    if (!page.url().startsWith('https://chatgpt.com/') || !(await editor.isVisible())) {
      await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await editor.waitFor({ state: 'visible', timeout: 15_000 });
    }
    const openSidebar = page.getByRole('button', { name: /^(Open sidebar|사이드바 열기)$/i });
    if (await openSidebar.isVisible()) await openSidebar.press('Enter');
    const row = page.getByRole('button', { name: entry.name, exact: true });
    try { await row.waitFor({ state: 'visible', timeout: 15_000 }); }
    catch (cause) {
      const visible = await page.locator('[data-sidebar-item][role="button"], a[href*="/g/g-p-"]').allTextContents();
      throw new Error(`사이드바에서 프로젝트 "${entry.name}"을 찾지 못했습니다. 표시된 항목: ${visible.map(s => s.trim()).filter(Boolean).slice(0,20).join(', ')}`, { cause });
    }
    // 숨겨진 trailing button은 pointer-events:none일 수 있다. Enter는 호버나 OS 포커스를 요구하지 않는다.
    await row.locator('..').getByRole('button', { name: /^(Open project( home)?|프로젝트 홈 열기)$/i }).press('Enter');
    await page.waitForURL(url => chatgptProjectId(url.href) !== null && /\/project\/?$/.test(url.pathname), { timeout: 15_000 });
    await editor.waitFor({ state: 'visible', timeout: 15_000 });
  }
  if (!onHome()) throw new Error('선택한 프로젝트 ID가 등록된 프로젝트와 다릅니다. setup으로 다시 등록하세요.');
  if ((await editor.innerText()).trim()) throw new Error('프로젝트 입력창에 작성 중인 내용이 있습니다. 내용을 비운 뒤 다시 시도하세요.');
}
