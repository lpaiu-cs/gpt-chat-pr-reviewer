/**
 * GitHub 연동 — `gh` CLI 래퍼.
 *
 * PR 정보 조회, diff 파싱, 리뷰 게시, GraphQL 스레드 동기화를 담당한다.
 */

import { execFileSync } from 'node:child_process';
import chalk from 'chalk';
import type { PRInfo, DiffHunk, ReviewComment } from './types.js';

// ── PR 식별 ─────────────────────────────────────────────────

/** 현재 디렉터리가 속한 레포의 'owner/repo' 슬러그. */
export function currentRepoSlug(): string {
  return gh(['repo', 'view', '--json', 'owner,name', '-q', '.owner.login+"/"+.name']).trim();
}

/**
 * 사용자 입력(URL / owner/repo#N / 단순 숫자)을 파싱하여
 * { owner, repo, number } 를 반환한다.
 *
 * 단순 숫자는 "현재 디렉터리의 레포" 를 뜻하는데, 그 조회는 I/O 다. 파싱과
 * 조회를 섞으면 이 함수를 테스트할 수 없으므로 해석기를 주입받는다 —
 * 기본값이 실제 gh 호출이고, 호출부는 건드리지 않는다.
 */
export function parsePRInput(
  input: string,
  resolveCurrentRepo: () => string = currentRepoSlug,
): { owner: string; repo: string; number: number } {
  // https://github.com/owner/repo/pull/123
  const urlRe = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;
  const urlMatch = input.match(urlRe);
  if (urlMatch) return { owner: urlMatch[1], repo: urlMatch[2], number: +urlMatch[3] };

  // owner/repo#123
  const shortRe = /^([^/]+)\/([^#]+)#(\d+)$/;
  const shortMatch = input.match(shortRe);
  if (shortMatch) return { owner: shortMatch[1], repo: shortMatch[2], number: +shortMatch[3] };

  // 단순 숫자 (현재 디렉터리가 gh repo 일 때)
  if (/^\d+$/.test(input.trim())) {
    const [owner, repo] = resolveCurrentRepo().split('/');
    return { owner, repo, number: +input.trim() };
  }

  throw new Error(`PR 식별 불가: "${input}"\n  URL · owner/repo#number · PR번호 중 하나를 입력해주세요.`);
}

/**
 * gh 실행 게이트웨이 — **모든** gh 호출은 여기를 지난다.
 *
 * `execSync` 를 쓰면 안 된다. execSync 는 명령을 **셸(cmd.exe)에 넘기는데**, cmd.exe 는
 * 콘솔 서브시스템이라 Windows 가 호출마다 새 콘솔 창을 할당한다. 감시 레포마다 매
 * 주기 gh 를 부르므로 화면에 빈 검은 창이 연속으로 깜빡인다 (실측: 25분에 conhost
 * 198개 ≈ 분당 8개). `windowsHide` 는 execSync 에서 먹지 않는다 — 숨겨야 할 대상이
 * gh 가 아니라 그 앞의 셸이기 때문이다.
 *
 * 그래서 셸을 아예 거치지 않고 execFileSync 로 직접 띄운다. 호출부마다 플래그를
 * 붙이는 방식은 쓰지 않았다 — opt-in 이면 새 호출부가 생길 때마다 재발한다.
 *
 * **인자는 배열로 넘긴다.** 셸이 없으므로 인용부호를 우리가 쓰면 안 된다.
 * 셸에서 `-q ".owner.login"` 이던 것은 `['-q', '.owner.login']` 이 되고, 따옴표를
 * 그대로 남기면 gh 가 그 문자까지 값으로 받는다.
 */
function gh(
  argv: string[],
  opts: { input?: string; maxBuffer?: number; captureStderr?: boolean } = {},
): string {
  try {
    return execFileSync('gh', argv, {
      encoding: 'utf-8',
      windowsHide: true,
      input: opts.input,
      maxBuffer: opts.maxBuffer,
      // stderr 를 캡처할지. 기본은 부모로 흘려보내지만, 10초 주기로 도는 경로에서는
      // 부분 실패 메시지가 그대로 쏟아져 로그를 못 쓰게 만든다.
      stdio: opts.captureStderr ? ['pipe', 'pipe', 'pipe'] : undefined,
    });
  } catch (e) {
    // 셸을 거치지 않으므로 PATH 에 gh 실행 파일이 그대로 있어야 한다.
    // (.cmd/.bat 래퍼로 설치된 경우 Node 가 셸 없이 띄우지 못한다.)
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error(
        "gh 실행 파일을 찾지 못했습니다. GitHub CLI 가 설치되어 PATH 에 있는지 확인하세요 (`gh --version`).",
      );
    }
    throw e;
  }
}

// ── PR 정보 ─────────────────────────────────────────────────

const PR_JSON_FIELDS = 'url,title,author,baseRefName,headRefName,number,headRefOid';

function toPRInfo(owner: string, repo: string, d: any): PRInfo {
  return {
    owner,
    repo,
    number: d.number,
    url: d.url,
    title: d.title,
    author: d.author.login,
    baseBranch: d.baseRefName,
    headBranch: d.headRefName,
    headSha: d.headRefOid,
  };
}

export function getPRInfo(owner: string, repo: string, number: number): PRInfo {
  const raw = gh(['pr', 'view', String(number), '--repo', `${owner}/${repo}`, '--json', PR_JSON_FIELDS]);
  return toPRInfo(owner, repo, JSON.parse(raw));
}

// ── GraphQL 동기화 (스레드 resolve · head SHA · PR 상태) ────

export interface SyncThread {
  id: string;
  isResolved: boolean;
  path: string;
  line: number | null;
  /**
   * 사람이 **숨긴** 스레드인가 (minimize — duplicate·outdated·off-topic 등).
   *
   * 숨김은 "이건 없던 것으로 하라" 는 사람의 판정이다. resolve 와 달리 응답이
   * 아니므로, 숨긴 스레드를 계속 미해결로 세면 그 라운드는 영영 응답 대기에
   * 머문다. 코멘트 자체를 숨기는 경우와 리뷰 전체를 숨기는 경우가 모두 있어
   * (리뷰를 숨겨도 인라인 코멘트의 isMinimized 는 false 로 남는다) 둘 다 본다.
   */
  isHidden: boolean;
  comments: { author: string; body: string; isHidden: boolean }[];
}

export interface PRSyncData {
  status: 'OPEN' | 'CLOSED' | 'MERGED';
  headSha: string;
  /** 리뷰 대상 diff 는 `base...head` 라 base 도 전이 판정의 입력이다 */
  baseRef: string;
  threads: SyncThread[];
}

const SYNC_QUERY = `query($owner:String!,$name:String!,$num:Int!){
  rateLimit{ cost remaining }
  repository(owner:$owner,name:$name){
    pullRequest(number:$num){
      state
      headRefOid
      baseRefName
      reviewThreads(first:100){
        nodes{
          id isResolved path line originalLine
          comments(first:50){
            nodes{ author{ login } body isMinimized pullRequestReview{ isMinimized } }
          }
        }
      }
    }
  }
}`;

/** PR 의 현재 상태 + 리뷰 스레드를 한 번의 GraphQL 호출로 가져온다. */
export function fetchPRSyncData(owner: string, repo: string, number: number): PRSyncData {
  // -F (대문자) 만 @- stdin 확장을 지원한다. -f 는 "@-" 를 문자열 그대로 보낸다.
  const { data } = graphQLTolerant(
    ['-F', `owner=${owner}`, '-F', `name=${repo}`, '-F', `num=${number}`],
    SYNC_QUERY,
  );
  const pr = data.repository.pullRequest;
  return {
    status: pr.state,
    headSha: pr.headRefOid,
    baseRef: pr.baseRefName,
    threads: (pr.reviewThreads?.nodes ?? []).map((n: any) => {
      const comments = (n.comments?.nodes ?? []).map((c: any) => ({
        author: c.author?.login ?? '',
        body: c.body ?? '',
        // 코멘트를 직접 숨겼거나, 그 코멘트를 담은 리뷰가 통째로 숨겨졌거나.
        isHidden: !!c.isMinimized || !!c.pullRequestReview?.isMinimized,
      }));
      return {
        id: n.id,
        isResolved: n.isResolved,
        path: n.path,
        line: n.line ?? n.originalLine ?? null,
        // 스레드를 연 코멘트가 숨겨졌으면 스레드 전체가 없던 것이다.
        isHidden: !!comments[0]?.isHidden,
        comments,
      };
    }),
  };
}

/**
 * gh 명령의 오류에서 읽을 수 있는 메시지를 뽑는다.
 * GitHub API 오류 본문(JSON)이 stdout 으로 오므로 그걸 우선 파싱한다.
 */
export function ghErrorMessage(e: unknown): string {
  const err = e as { stdout?: unknown; message?: unknown };
  const out = typeof err?.stdout === 'string' ? err.stdout : '';
  try {
    const j = JSON.parse(out);
    const details = Array.isArray(j.errors)
      ? j.errors
          .map((x: unknown) =>
            typeof x === 'string' ? x : ((x as { message?: string })?.message ?? JSON.stringify(x)),
          )
          .join('; ')
      : '';
    const msg = [j.message, details].filter(Boolean).join(' — ');
    if (msg) return j.status ? `${msg} (HTTP ${j.status})` : msg;
  } catch {
    /* JSON 아님 — 아래로 */
  }
  const raw = e instanceof Error ? e.message : String(e);
  return raw.split('\n').find((l) => l.trim()) ?? raw;
}

// ── 배치 probe (감시 루프용) ────────────────────────────────

/** probe 로 얻는 PR 1건의 요약. */
export interface PRProbe extends PRInfo {
  status: 'OPEN' | 'CLOSED' | 'MERGED';
  updatedAt: string;
  isDraft: boolean;
  labels: string[];
  /** 라벨이 조회 상한을 넘어 일부만 담긴 경우 true — 라벨 필터 판정이 부정확해진다 */
  labelsTruncated: boolean;
  /** 스레드 상태를 함께 조회한 경우에만 채워진다 (resolve 감지용). */
  threads?: { id: string; isResolved: boolean }[];
}

export interface RepoProbe {
  prs: PRProbe[];
  /** 이 레포의 열린 PR 총 개수 (PROBE_PAGE 초과분 감지용) */
  totalOpen: number;
  /** 열린 PR 이 PROBE_PAGE 를 넘어 일부만 조회된 경우 true */
  truncated: boolean;
  /** GitHub 이 계산한 이 쿼리의 실제 비용 */
  cost: number;
  remaining: number;
}

/**
 * 한 쿼리에 붙일 스레드 alias 개수. 상한이 아니라 **청크 크기**다.
 * 초과분은 버리지 않고 추가 쿼리로 나눠 조회한다 (조용히 누락되면
 * 그 PR 의 resolve 를 영영 감지하지 못한다).
 */
export const THREAD_ALIAS_CHUNK = 20;

/** 한 레포에서 1회에 조회하는 열린 PR 개수. 초과분은 totalCount 로 감지해 알린다. */
export const PROBE_PAGE = 50;

/**
 * 라벨 조회 상한. GitHub 의 PR 당 라벨 한도와 같으므로 실질적으로 잘리지 않지만,
 * 잘렸을 때 라벨 필터가 PR 을 **조용히 제외**하지 않도록 totalCount 로 감지한다.
 */
const PROBE_LABEL_PAGE = 100;

const PROBE_PR_FIELDS = `number title url state updatedAt headRefOid baseRefName headRefName isDraft
        author{ login } labels(first:${PROBE_LABEL_PAGE}){ totalCount nodes{ name } }`;

// ── GraphQL 사용량 집계 ─────────────────────────────────────
//
// 폴링 주기를 실제 소모량에 맞추려면 probe 뿐 아니라 전체 동기화·닫힘 확인 등
// 모든 GraphQL 경로의 비용을 세야 한다. 호출부가 일일이 합산하면 경로가 하나만
// 늘어도 과소평가가 생기므로, 여기서 중앙 집계한다.

let graphqlSpent = 0;
let graphqlRemaining = -1;

function recordUsage(rateLimit: { cost?: number; remaining?: number } | undefined): void {
  graphqlSpent += rateLimit?.cost ?? 1; // rateLimit 미조회 쿼리도 최소 1 로 센다
  if (typeof rateLimit?.remaining === 'number') graphqlRemaining = rateLimit.remaining;
}

/** 마지막 집계 이후의 GraphQL 소모량을 가져오고 카운터를 리셋한다. */
export function takeGraphQLUsage(): { cost: number; remaining: number } {
  const usage = { cost: graphqlSpent, remaining: graphqlRemaining };
  graphqlSpent = 0;
  return usage;
}

/**
 * GraphQL 쿼리를 실행하되 **부분 응답을 살린다.**
 *
 * alias 로 지정한 PR 번호 중 하나라도 존재하지 않으면 GitHub 은 data 와 errors 를
 * 함께 반환하고 gh 는 비정상 종료한다. 그대로 두면 오래된 컨텍스트 하나가 그
 * 레포의 스캔 전체를 죽인다. data 가 있으면 경고만 남기고 진행한다.
 */
function graphQLTolerant(args: string[], query: string): { data: any; errors?: any[] } {
  try {
    const raw = gh(['api', 'graphql', ...args, '-F', 'query=@-'], {
      input: query,
      maxBuffer: 10 * 1024 * 1024,
      captureStderr: true,
    });
    const parsed = JSON.parse(raw);
    recordUsage(parsed?.data?.rateLimit);
    return parsed;
  } catch (e) {
    const out = (e as { stdout?: unknown })?.stdout;
    if (typeof out === 'string') {
      try {
        const parsed = JSON.parse(out);
        if (parsed?.data) {
          recordUsage(parsed.data.rateLimit); // 부분 응답도 비용은 발생했다
          return parsed;
        }
      } catch {
        /* JSON 아님 — 원래 오류를 던진다 */
      }
    }
    throw e;
  }
}

/**
 * 레포 1개의 감시 스냅샷을 **GraphQL 1회**로 가져온다.
 *
 * 열린 PR 목록에 더해, `threadsFor` 로 지정한 PR 들의 리뷰 스레드 resolve 상태를
 * alias 로 함께 조회한다. 실측 결과 목록 + alias 여러 개를 합쳐도 cost 는 1 이므로,
 * 스캔 1회 비용이 PR 개수와 무관한 상수가 된다.
 *
 * 주의: PR.updatedAt 은 스레드 resolve 로 갱신되지 않는다(실측). 따라서
 * resolve 감지가 필요한 PR 은 반드시 threadsFor 에 포함시켜야 한다.
 */
export function fetchRepoProbe(ownerSlashRepo: string, threadsFor: number[] = []): RepoProbe {
  const [owner, repo] = ownerSlashRepo.split('/');

  // alias 를 청크로 나눈다. 첫 쿼리에만 PR 목록을 싣고, 나머지 청크는 스레드만.
  const chunks: number[][] = [];
  for (let i = 0; i < threadsFor.length; i += THREAD_ALIAS_CHUNK) {
    chunks.push(threadsFor.slice(i, i + THREAD_ALIAS_CHUNK));
  }
  if (chunks.length === 0) chunks.push([]);

  const runQuery = (ids: number[], withList: boolean): any => {
    const aliases = ids
      .map(
        (n) =>
          `    t${n}: pullRequest(number:${n}){ reviewThreads(first:100){ nodes{ id isResolved } } }`,
      )
      .join('\n');
    const listPart = withList
      ? `    prs: pullRequests(states:OPEN, first:${PROBE_PAGE}, orderBy:{field:UPDATED_AT,direction:DESC}){
      totalCount
      nodes{ ${PROBE_PR_FIELDS} }
    }\n`
      : '';
    const query = `query($owner:String!,$name:String!){
  rateLimit{ cost remaining }
  repository(owner:$owner,name:$name){
${listPart}${aliases}
  }
}`;
    return graphQLTolerant(['-F', `owner=${owner}`, '-F', `name=${repo}`], query);
  };

  let cost = 0;
  let remaining = -1;
  let prs: PRProbe[] = [];
  let totalOpen = 0;

  chunks.forEach((ids, i) => {
    const { data, errors } = runQuery(ids, i === 0);
    if (errors?.length) {
      // 보통 추적 중이던 PR 이 사라진 경우. 나머지 결과는 그대로 쓴다.
      console.log(
        chalk.yellow(`  ⚠ ${ownerSlashRepo} probe 일부 실패 (${errors.length}건) — 나머지로 진행`),
      );
    }
    const repoNode = data.repository;
    cost += data.rateLimit?.cost ?? 1;
    remaining = data.rateLimit?.remaining ?? remaining;

    if (i === 0) {
      totalOpen = repoNode.prs?.totalCount ?? 0;
      prs = (repoNode.prs?.nodes ?? []).map((n: any) => ({
        ...toPRInfo(owner, repo, n),
        status: n.state,
        updatedAt: n.updatedAt,
        isDraft: !!n.isDraft,
        labels: (n.labels?.nodes ?? []).map((l: any) => l.name),
        labelsTruncated: (n.labels?.totalCount ?? 0) > (n.labels?.nodes?.length ?? 0),
      }));
    }

    // alias 로 딸려온 스레드 상태를 해당 PR 에 붙인다
    for (const n of ids) {
      const node = repoNode[`t${n}`];
      if (!node) continue;
      const target = prs.find((p) => p.number === n);
      if (!target) continue;
      target.threads = (node.reviewThreads?.nodes ?? []).map((t: any) => ({
        id: t.id,
        isResolved: t.isResolved,
      }));
    }
  });

  return { prs, totalOpen, truncated: totalOpen > prs.length, cost, remaining };
}

// ── 레포 탐색 (계정 단위 감시용) ───────────────────────────

export interface RepoSearchResult {
  /** 열린 PR 이 하나라도 있는 'owner/repo' 목록 */
  repos: string[];
  /**
   * 검색에 걸린 PR 의 신원. 레포로 축약해 버리면 "리뷰 요청된 PR 만" 같은
   * 조건이 레포 단위로 번져 요청하지 않은 PR 까지 대상이 된다.
   */
  prs: { slug: string; number: number }[];
  /** 검색에 걸린 PR 총 개수 */
  total: number;
  /** 페이지 상한에 걸려 일부만 훑은 경우 true */
  truncated: boolean;
  cost: number;
  remaining: number;
}

/** 검색 페이지네이션 상한 — 100건 × 10페이지 = PR 1,000건. */
const SEARCH_MAX_PAGES = 10;

const REPO_SEARCH_QUERY = `query($q:String!,$after:String){
  rateLimit{ cost remaining }
  search(query:$q, type:ISSUE, first:100, after:$after){
    issueCount
    pageInfo{ hasNextPage endCursor }
    nodes{ ... on PullRequest { number repository{ nameWithOwner } } }
  }
}`;

/**
 * 검색으로 "열린 PR 이 있는 레포" 를 찾는다 (계정/조직 단위 감시의 입구).
 *
 * 실측 cost 는 페이지당 1 point 다. 폴링 자체(fetchRepoProbe)는 레포 단위로
 * 살아있는 데이터를 읽고, 이 함수는 **대상 목록만** 정한다. 검색 인덱스는
 * 반영 지연이 있어 새 커밋 감지에는 쓸 수 없기 때문에 역할을 나눈 것이다.
 */
export function searchPRRepos(searchQuery: string): RepoSearchResult {
  const repos = new Set<string>();
  const prs: { slug: string; number: number }[] = [];
  let cursor: string | null = null;
  let total = 0;
  let cost = 0;
  let remaining = -1;
  let truncated = false;

  for (let page = 0; page < SEARCH_MAX_PAGES; page++) {
    // JSON.stringify 를 쓰면 안 된다. 셸이 있을 때는 그 따옴표를 셸이 벗겨줬지만
    // 이제 셸이 없으므로 gh 가 따옴표까지 값으로 받는다 (검색이 통째로 어긋난다).
    const args = ['-f', `q=${searchQuery}`, ...(cursor ? ['-f', `after=${cursor}`] : [])];
    const { data } = graphQLTolerant(args, REPO_SEARCH_QUERY);
    const search = data?.search;
    if (!search) break;

    cost += data.rateLimit?.cost ?? 1;
    remaining = data.rateLimit?.remaining ?? remaining;
    total = search.issueCount ?? total;
    for (const n of search.nodes ?? []) {
      const slug = n?.repository?.nameWithOwner;
      if (!slug || typeof n.number !== 'number') continue;
      repos.add(slug);
      prs.push({ slug, number: n.number });
    }

    if (!search.pageInfo?.hasNextPage) break;
    cursor = search.pageInfo.endCursor;
    truncated = page === SEARCH_MAX_PAGES - 1;
  }

  return { repos: [...repos].sort(), prs, total, truncated, cost, remaining };
}

let viewerLoginCache: string | null = null;

/**
 * 커밋의 부모 SHA 들 — 머지 커밋이면 2개, 보통 커밋이면 1개. 조회 실패면 null.
 *
 * GraphQL 이 아니라 REST 다. 이 조회는 head 가 움직인 컨텍스트에서만, 그것도
 * 머지 여부를 가릴 때만 나가므로 주기 비용(레포당 1 point)에 얹히지 않는다.
 *
 * 실패를 null 로 떨어뜨린다 — 부모를 모르면 "머지인지 아닌지 모른다" 이고,
 * 모를 때의 기본 방향은 **평소대로 재리뷰**다 (absorbsReviewedMerge 참고).
 */
export function fetchCommitParents(owner: string, repo: string, sha: string): string[] | null {
  try {
    const raw = gh(['api', `repos/${owner}/${repo}/commits/${sha}`, '-q', '.parents[].sha'], {
      captureStderr: true, // 10초 주기 경로다 — 부분 실패 메시지로 로그를 덮지 않는다
    });
    const parents = raw
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    return parents.length > 0 ? parents : null;
  } catch {
    return null;
  }
}

/**
 * 이 PR 을 **GitHub 이 머지하며 만든 커밋** (머지되지 않았으면 null).
 *
 * `merged` 를 반드시 함께 본다. 열린 PR 의 `merge_commit_sha` 는 GitHub 이
 * 미리 계산해 둔 **테스트 머지** 커밋이라 실제 머지 결과가 아니다
 * (실측: 열린 PR 33 이 merged=false 인데도 sha 를 갖고 있었다).
 */
export function fetchMergeCommit(owner: string, repo: string, number: number): string | null {
  try {
    const raw = gh(
      ['api', `repos/${owner}/${repo}/pulls/${number}`, '-q', '[.merged, .merge_commit_sha] | @tsv'],
      { captureStderr: true },
    );
    const [merged, sha] = raw.trim().split('\t');
    return merged === 'true' && sha ? sha : null;
  } catch {
    return null;
  }
}

/** 현재 gh 인증 계정의 로그인 아이디 (캐시됨). */
export function getViewerLogin(): string {
  if (!viewerLoginCache) {
    viewerLoginCache = gh(['api', 'user', '-q', '.login']).trim();
  }
  return viewerLoginCache;
}

// ── PR 반응 ────────────────────────────────────────────────

export type PullRequestReaction = 'eyes' | '+1';

export interface PullRequestReactionRecord {
  id: number;
  content: string;
  user?: { login?: string } | null;
}

/** GitHub reactions API 에 보낼 본문 (순수 함수). */
export function buildPullRequestReactionPayload(content: PullRequestReaction): string {
  return JSON.stringify({ content });
}

/** PR 자체에 반응을 남긴다. PR 은 reactions API 에서 issue 번호로 다룬다. */
export function addPullRequestReaction(
  owner: string,
  repo: string,
  number: number,
  content: PullRequestReaction,
): void {
  gh(
    [
      'api',
      `repos/${owner}/${repo}/issues/${number}/reactions`,
      '--method',
      'POST',
      '--input',
      '-',
      '-H',
      'Accept: application/vnd.github+json',
    ],
    { input: buildPullRequestReactionPayload(content), captureStderr: true },
  );
}

/** 조회 결과에서 현재 사용자가 남긴 특정 반응 id만 고른다. */
export function viewerReactionIds(
  reactions: PullRequestReactionRecord[],
  content: PullRequestReaction,
  viewer: string,
): number[] {
  const login = viewer.toLowerCase();
  return reactions
    .filter(
      (reaction) =>
        reaction.content === content && reaction.user?.login?.toLowerCase() === login,
    )
    .map((reaction) => reaction.id);
}

/** 현재 gh 인증 사용자가 PR에 남긴 특정 반응을 모두 제거한다. */
export function removePullRequestReaction(
  owner: string,
  repo: string,
  number: number,
  content: PullRequestReaction,
): void {
  const endpoint = `repos/${owner}/${repo}/issues/${number}/reactions`;
  const raw = gh(
    [
      'api',
      endpoint,
      '--method',
      'GET',
      '-f',
      `content=${content}`,
      '-f',
      'per_page=100',
      '--paginate',
      '--slurp',
      '-H',
      'Accept: application/vnd.github+json',
    ],
    { captureStderr: true },
  );
  const parsed = JSON.parse(raw) as PullRequestReactionRecord[][] | PullRequestReactionRecord[];
  const reactions = Array.isArray(parsed[0])
    ? (parsed as PullRequestReactionRecord[][]).flat()
    : (parsed as PullRequestReactionRecord[]);

  for (const id of viewerReactionIds(reactions, content, getViewerLogin())) {
    gh(
      [
        'api',
        `${endpoint}/${id}`,
        '--method',
        'DELETE',
        '-H',
        'Accept: application/vnd.github+json',
      ],
      { captureStderr: true },
    );
  }
}

// ── Diff 파싱 ───────────────────────────────────────────────

export function fetchDiff(owner: string, repo: string, number: number): string {
  return gh(['pr', 'diff', String(number), '--repo', `${owner}/${repo}`], {
    maxBuffer: 10 * 1024 * 1024,
  });
}

/**
 * **특정 커밋 기준** diff. 3-dot 이라 PR diff 와 같은 merge-base 를 쓴다.
 *
 * `gh pr diff` 는 언제나 현재 head 를 준다. 응답을 기다리는 2~15분 사이에 새 커밋이
 * 들어오면, 검토한 커밋에 리뷰를 고정해 놓고 라인 검증만 새 diff 로 하게 된다.
 */
export function fetchDiffAt(owner: string, repo: string, base: string, sha: string): string {
  return gh(
    [
      'api',
      `repos/${owner}/${repo}/compare/${base}...${sha}`,
      '-H',
      'Accept: application/vnd.github.v3.diff',
    ],
    { maxBuffer: 10 * 1024 * 1024 },
  );
}

/**
 * unified-diff 텍스트를 파싱하여
 * 파일별로 new-side 에 존재하는 라인 번호 집합을 반환한다.
 */
export function parseDiffHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let curPath = '';
  let curLines = new Set<number>();
  let newLine = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      if (curPath) hunks.push({ path: curPath, lines: curLines });
      curPath = line.slice(6);
      curLines = new Set();
      continue;
    }

    const hunkHeader = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkHeader) {
      newLine = +hunkHeader[1];
      continue;
    }

    if (!curPath) continue;

    if (line.startsWith('+')) {
      curLines.add(newLine);
      newLine++;
    } else if (line.startsWith('-')) {
      /* 삭제 라인 — newLine 유지 */
    } else {
      // 컨텍스트 라인 또는 빈 줄
      curLines.add(newLine);
      newLine++;
    }
  }
  if (curPath) hunks.push({ path: curPath, lines: curLines });
  return hunks;
}

// ── 리뷰 게시 ───────────────────────────────────────────────

/**
 * 리뷰 게시 페이로드 (순수 함수).
 *
 * `commit_id` 를 빼면 GitHub 은 **게시 시점의 최신 커밋**에 리뷰를 붙인다. 응답을
 * 기다리는 2~15분 사이에 새 커밋이 들어오면, 모델이 본 적 없는 커밋에 APPROVE 가
 * 직접 달린다. 검토한 커밋을 알면 반드시 고정한다.
 */
export function buildReviewPayload(
  body: string,
  event: string,
  comments: ReviewComment[],
  commitId?: string | null,
): string {
  return JSON.stringify({
    body,
    event: event.toUpperCase(),
    ...(commitId ? { commit_id: commitId } : {}),
    ...(comments.length > 0
      ? { comments: comments.map((c) => ({ path: c.path, line: c.line, body: c.body })) }
      : {}),
  });
}

function submitReview(owner: string, repo: string, number: number, payload: string): void {
  gh(
    ['api', `repos/${owner}/${repo}/pulls/${number}/reviews`, '--method', 'POST', '--input', '-'],
    { input: payload },
  );
}

/** 인라인 코멘트 포함 리뷰 게시. */
export function postReview(
  owner: string,
  repo: string,
  number: number,
  body: string,
  event: string,
  comments: ReviewComment[],
  commitId?: string | null,
): void {
  submitReview(owner, repo, number, buildReviewPayload(body, event, comments, commitId));
}

/** 본문만 있는 단순 리뷰 게시. */
export function postSimpleReview(
  owner: string,
  repo: string,
  number: number,
  body: string,
  event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES' = 'COMMENT',
  commitId?: string | null,
): void {
  submitReview(owner, repo, number, buildReviewPayload(body, event, [], commitId));
}
