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
    // 실패한 입력이 남긴 우리 프롬프트는 지우고 들어간다 — 남기면 모든 리뷰가 막힌다.
    await page.locator('#prompt-textarea').fill(`${loadConfig('tests/__missing__.json').promptTemplate.split('{{')[0]}https://github.com/o/r/pull/1`);
    await driver.startNewChat();
    assert.equal((await page.locator('#prompt-textarea').innerText()).trim(), '');
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

test('실제 Chrome: 한국어 사이드바의 "<이름>에서 새 채팅" 으로 진입한다', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const entry = { url: 'https://chatgpt.com/g/g-p-1234/project', name: 'Reviews' };
  const ko = NEW_UI.replace(/aria-label="New chat in Reviews"/g, 'aria-label="Reviews에서 새 채팅"')
    .replace('Project actions for Reviews', 'Reviews 프로젝트 액션');
  await page.route('https://chatgpt.com/**', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: ko }));
  try {
    await page.goto('https://chatgpt.com/');
    await enterProject(page, entry, loadConfig('tests/__missing__.json').selectors.textInput);
    assert.equal(new URL(page.url()).pathname, '/g/g-p-1234/project');
  } finally { await browser.close(); }
});

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

    // 생성 중인 답은 식별자도 턴 키 조상도 없다(실측) — 우리가 찍은 표식으로 고정해야
    // 위치 읽기의 축소 오인을 피한다. 같은 노드면 표식이 유지되고, 다시 그려지면 새로 찍힌다.
    await page.evaluate(() => {
      const unit = document.querySelector('[data-chatgpt-search-message-ids^="a2"]')!;
      unit.setAttribute('data-chatgpt-search-message-ids', '');
      unit.closest('[data-turn-key]')!.removeAttribute('data-turn-key');
    });
    const { readMessagesInPage, messageByIdSelector, readComposerInPage } = await import('../src/chatgpt.js');

    // 줄 중간 URL 이 링크 위젯이 되면 innerText 는 아이콘 자리에 줄바꿈을 그린다(platelog#3 실측).
    // 검증은 장식을 뺀 글자로 한다.
    const editor = page.locator(cfg.selectors.textInput).first();
    await editor.evaluate((el) => { el.innerHTML = '<p>로컬 (<span data-rich-text-generated-autolink=""><span aria-hidden="true" contenteditable="false" style="display:block">⊕</span>http://10.0.2.2:54321</span>, 디버그)<br>다음 줄<br class="ProseMirror-trailingBreak"></p>'; });
    assert.notEqual((await editor.innerText()).split('\n')[0], '로컬 (http://10.0.2.2:54321, 디버그)', 'innerText 는 줄을 가른다');
    assert.equal(await editor.evaluate(readComposerInPage), '로컬 (http://10.0.2.2:54321, 디버그)\n다음 줄\n');
    await editor.evaluate((el) => { el.innerHTML = ''; });
    const first = (await page.evaluate(readMessagesInPage, null)).at(-1)!;
    assert.match(first.id!, /^anchor-/);
    assert.equal((await page.evaluate(readMessagesInPage, null)).at(-1)!.id, first.id, '같은 노드는 같은 표식');
    assert.equal(await page.locator(messageByIdSelector(first.id!)).innerText(), 'ChatGPT said:\n{"summary":"ok"}');
    await page.evaluate(() => { const u = document.querySelector('[data-pr-review-anchor]')!; u.replaceWith(u.cloneNode(true) as Element); document.querySelector('[data-pr-review-anchor]')!.removeAttribute('data-pr-review-anchor'); });
    assert.notEqual((await page.evaluate(readMessagesInPage, null)).at(-1)!.id, first.id, '다시 그린 노드는 새 표식');
  } finally { await browser.close(); }
});

test('실제 Chrome: 재개 답의 모든 본문 블록을 검증하고 생성 중이면 완료까지 수집한다', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  try {
    const { parseGPTResponse } = await import('../src/parser.js');
    const head = 'a'.repeat(40), base = 'b'.repeat(40), marker = '리뷰 라운드: 1차';
    const raw = JSON.stringify({ summary: 'ok', approval: 'approve', comments: [], reviewedHeadSha: head, reviewedBaseSha: base });
    const accept = (text: string) => {
      const result = parseGPTResponse(text);
      return result.parsed === true && result.reviewedHeadSha === head && result.reviewedBaseSha === base;
    };
    const driver = new ChatGPTDriver(loadConfig('tests/__missing__.json')) as any;
    driver.page = page;
    page.waitForTimeout = async () => {};
    for (const legacy of [true, false]) {
      const attrs = (role: string, id: string) => legacy
        ? `data-message-author-role="${role}" data-message-id="${id}"`
        : `data-chatgpt-search-unit-key="t:${id}:${role}" data-chatgpt-search-message-ids="${id}"`;
      await page.setContent(`<div ${attrs('user', 'u1')}>${marker}</div><div ${attrs('assistant', 'a1')}></div>
        <div ${attrs('user', 'u2')}>이어서 진행해줘</div><div ${attrs('assistant', 'a2')}>
        <div class="markdown">리뷰를 이어서 완료했습니다.</div><div class="markdown" id="answer">${raw}</div></div>`);
      driver.isStreaming = async () => false;
      assert.equal(await driver.findRound(marker, true, accept), 1);
      assert.equal(await driver.collectFrom(1, 60_000), `리뷰를 이어서 완료했습니다.\n${raw}`);
      await page.locator('.markdown').evaluateAll(els => els.forEach(el => { el.textContent = ''; }));
      assert.equal(await driver.findRound(marker, true, accept), null, '끝난 빈 답은 기다리지 않는다');
      driver.isStreaming = async () => true;
      driver.stallEvidence = () => 'generating';
      assert.equal(await driver.findRound(marker, true, accept), 1, 'JSON이 아직 없어도 생성 중이면 수집한다');
      driver.stallEvidence = () => 'network-quiet';
      assert.equal(await driver.findRound(marker, true, accept), null, '중지 버튼만 남은 고장으로 기다리지 않는다');
    }
  } finally { await browser.close(); }
});

test('실제 Chrome: 위치로 읽는 답이 완료 때 같은 노드에서 줄어도 받아들인다', async () => {
  // 실측(platelog#3): 새 대화의 생성 중 화면에서는 질문을 못 읽어 답 위치를 전송 시점 기준으로
  // 읽었고, 완료 때 코드블록을 다시 그리며 977→963자로 줄자 "다른 노드" 로 보고 라운드를 버렸다.
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent('<main><div data-chatgpt-search-unit-key="t:2:assistant"><div data-chatgpt-selection-message-id="a">```json {"summary":"ok"} ```</div></div></main>');
    const driver = new ChatGPTDriver(loadConfig('tests/__missing__.json')) as any;
    driver.page = page;
    driver.isStreaming = async () => false;
    // 질문이 안 보이는 화면이다 — 앵커를 못 잡아 위치로 물러선다.
    let polls = 0;
    page.waitForTimeout = async () => {
      if (++polls === 5) await page.locator('[data-chatgpt-selection-message-id]').evaluate((el) => { el.textContent = '{"summary":"ok"}'; });
    };
    assert.equal(await driver.collectFrom(0, 60_000), '{"summary":"ok"}');
  } finally { await browser.close(); }
});

test('실제 Chrome: 이전 화면의 숨은 입력창이 앞에 남아 있어도 보이는 입력창으로 진입한다', async () => {
  // 실측: 홈에서 화면 내부 이동으로 들어온 프로젝트 홈에 홈 입력창이 숨은 채 먼저 남아,
  // 입력창 셀렉터가 둘에 걸려 strict mode 위반으로 데몬이 기동 직후 종료했다.
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const entry = { url: 'https://chatgpt.com/g/g-p-1234/project', name: 'Reviews' };
  const composer = (label: string) => `<form data-chatgpt-composer><div contenteditable="true" role="textbox" aria-label="${label}"></div></form>`;
  await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8',
    body: `<div hidden>${composer('Ask ChatGPT')}</div><h1>Reviews</h1>${composer('New chat in Reviews')}` }));
  try {
    const input = loadConfig('tests/__missing__.json').selectors.textInput;
    await page.goto(entry.url);
    await enterProject(page, entry, input);
    assert.deepEqual(await readProjectEntry(page, input), entry);
    assert.equal(await page.locator(input).first().getAttribute('aria-label'), 'New chat in Reviews');
  } finally { await browser.close(); }
});
