import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { enterProject, readProjectEntry } from '../src/project-entry.js';
import { ChatGPTDriver } from '../src/chatgpt.js';
import { loadConfig } from '../src/config.js';

test('실제 Chrome: 직접 로딩 실패·호버 비활성 버튼에서도 Enter 진입, ID와 초안 보호', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const entry = { url: 'https://chatgpt.com/g/g-p-1234-reviews/project', name: 'Reviews' };
  let destination = entry.url;
  let deepLoads = 0;
  await page.route('https://chatgpt.com/**', async route => {
    if (new URL(route.request().url()).pathname !== '/') {
      deepLoads++;
      return route.fulfill({ status: 500, body: 'Try again' });
    }
    await route.fulfill({ contentType: 'text/html', body: `
      <div><div role="button" tabindex="0">Reviews</div>
      <button aria-label="Open project home" style="pointer-events:none;opacity:0"
        onclick="history.pushState({}, '', '${destination}'); document.querySelector('h1').textContent='Reviews'">open</button></div>
      <h1>Home</h1><div id="prompt-textarea" contenteditable="true"></div>` });
  });
  try {
    for (let i = 0; i < 3; i++) {
      await page.goto('https://chatgpt.com/');
      await enterProject(page, entry, '#prompt-textarea');
      assert.deepEqual(await readProjectEntry(page, '#prompt-textarea'), entry);
    }
    assert.equal(deepLoads, 0, '프로젝트를 HTTP 문서로 요청하지 않아야 한다');
    const driver = new ChatGPTDriver({ ...loadConfig('tests/__missing__.json'), chatgptProjectUrl: entry.url });
    (driver as any).page = page;
    await driver.registerProject();
    assert.deepEqual(await driver.projectEntry(), entry);
    await page.evaluate(url => {
      const link = document.createElement('a');
      link.href = url;
      link.textContent = 'Existing review';
      link.onclick = event => { event.preventDefault(); history.pushState({}, '', url); };
      document.body.appendChild(link);
    }, entry.url.replace('/project', '/c/abcd'));
    assert.equal(await driver.resumeChat(entry.url.replace('/project', '/c/abcd'), { requireAssistant: false }), true);
    assert.equal(deepLoads, 0, '대화 복귀도 전체 문서 로딩을 피해야 한다');
    await page.goto('https://chatgpt.com/');
    await enterProject(page, entry, '#prompt-textarea');
    await page.locator('#prompt-textarea').fill('keep my draft');
    await assert.rejects(enterProject(page, entry, '#prompt-textarea'), /작성 중/);
    assert.equal(await page.locator('#prompt-textarea').innerText(), 'keep my draft');
    destination = entry.url.replace('1234', '5678');
    await page.goto('https://chatgpt.com/');
    await assert.rejects(enterProject(page, entry, '#prompt-textarea'), /ID/);
    await assert.rejects(enterProject(page, { ...entry, name: '' }, '#prompt-textarea'), /setup/);
  } finally { await browser.close(); }
});

// 2026-09 개편 화면: 입력창 id 가 없고, 사이드바 행은 펼치기 버튼이며, 프로젝트 새 채팅 버튼이
// 행 안에 있다. 메시지는 data-message-author-role 대신 검색 단위 속성으로 그려진다.
// 실측: 새로 연 탭은 전부 이 화면만 받았고, 옛 셀렉터로는 홈 입력창부터 찾지 못했다.
const NEW_UI = `
<nav>
  <!-- 이름이 같은 다른 프로젝트가 먼저 나온다 — 이름으로 고르면 여기로 들어간다. -->
  <div role="button" tabindex="0" data-app-action-sidebar-project-row data-app-action-sidebar-project-id="g-p-9999"
    aria-label="Reviews"><button aria-label="New chat in Reviews"
    onclick="history.pushState({}, '', '/g/g-p-9999/project')">+</button></div>
  <div data-sidebar-project-container-id="project:g-p-1234"><div>
    <div role="button" tabindex="0" aria-expanded="true" data-app-action-sidebar-project-row
      data-app-action-sidebar-project-id="g-p-1234" aria-labelledby="label"><span id="label">Reviews</span>
      <button aria-label="Project actions for Reviews" aria-haspopup="menu">…</button>
      <button aria-label="New chat in Reviews" style="pointer-events:none;opacity:0" onclick="openProject()">+</button>
    </div>
    <div role="list" aria-label="Chats in Reviews"></div>
  </div></div>
</nav>
<main id="main"></main>
<script>
  const composer = '<form data-chatgpt-composer><div contenteditable="true" role="textbox"></div></form>';
  // 이름이 같은 버튼(추천 칩)이 하나 더 있다 — 이름으로 찾으면 둘이 걸린다.
  main.innerHTML = '<h1>Ready when you are.</h1><button>Reviews</button>' + composer;
  function openProject() {
    history.pushState({}, '', '/g/g-p-1234/project');
    main.innerHTML = '<h1>Reviews</h1>' + composer
      + '<a href="/g/g-p-1234/c/abcd" onclick="event.preventDefault(); openChat()">Existing review</a>';
  }
  const turn = (n, user, answerId, answer) => '<div data-turn-key="u' + n + '">'
    + '<div data-chatgpt-search-unit-key="fallback-turn-' + n + ':0:user" data-chatgpt-search-message-ids="u' + n + '">'
    + '<div data-user-message-bubble="true">' + user + '</div></div><span hidden data-chatgpt-agent-turn-start></span>'
    + '<div data-chatgpt-search-unit-key="fallback-turn-' + n + ':2:assistant" data-chatgpt-search-message-ids="' + answerId + ' ' + answerId + '-x">'
    + '<h4 data-conversation-role="assistant">ChatGPT said:</h4><div data-chatgpt-selection-message-id="' + answerId + '">' + answer + '</div></div></div>';
  function openChat() {
    history.pushState({}, '', '/g/g-p-1234/c/abcd');
    // 본문에 안내 문구와 같은 글자가 있다 — 화면 안내로 읽히면 새로고침 복구로 빠진다.
    main.innerHTML = turn(1, '리뷰 라운드: 1차', 'a1', 'Connection interrupted 는 리뷰 본문이다')
      + turn(2, '리뷰 라운드: 2차 · Connection interrupted', 'a2', '{"summary":"ok"}') + composer;
  }
</script>`;

test('실제 Chrome: 개편 화면에서 진입·대화 복귀·라운드 찾기·응답 수집', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const entry = { url: 'https://chatgpt.com/g/g-p-1234/project', name: 'Reviews' };
  let deepLoads = 0;
  await page.route('https://chatgpt.com/**', async (route) => {
    if (new URL(route.request().url()).pathname !== '/') {
      deepLoads++;
      return route.fulfill({ status: 500, body: 'Try again' });
    }
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: NEW_UI });
  });
  try {
    const cfg = { ...loadConfig('tests/__missing__.json'), chatgptProjectUrl: entry.url, chatgptProjectName: entry.name };
    await page.goto('https://chatgpt.com/');
    await enterProject(page, entry, cfg.selectors.textInput);
    assert.deepEqual(await readProjectEntry(page, cfg.selectors.textInput), entry);

    const driver = new ChatGPTDriver(cfg) as any;
    driver.page = page;
    const chat = entry.url.replace('/project', '/c/abcd');
    assert.equal(await driver.resumeChat(chat, { requireAssistant: false }), true);
    assert.equal(deepLoads, 0, '개편 화면에서도 전체 문서 로딩을 피해야 한다');

    assert.equal(await driver.lastUserMessageId(page), 'u2');
    assert.equal(await driver.countUserMessages(page), 2);
    const baseline = await driver.findRound('리뷰 라운드: 2차');
    assert.equal(baseline, 1);
    page.waitForTimeout = async () => {}; // 폴링 간격만 없앤다 — 판정은 실제 화면으로 한다
    assert.equal(await driver.collectFrom(baseline, 60_000), '{"summary":"ok"}');
  } finally { await browser.close(); }
});
