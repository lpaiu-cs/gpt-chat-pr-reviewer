/**
 * GitHub 연동 — `gh` CLI 래퍼.
 *
 * PR 정보 조회, diff 파싱, 리뷰 게시, GraphQL 스레드 동기화를 담당한다.
 */

import { execSync } from 'node:child_process';
import type { PRInfo, DiffHunk, ReviewComment } from './types.js';

// ── PR 식별 ─────────────────────────────────────────────────

/**
 * 사용자 입력(URL / owner/repo#N / 단순 숫자)을 파싱하여
 * { owner, repo, number } 를 반환한다.
 */
export function parsePRInput(input: string): { owner: string; repo: string; number: number } {
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
    const info = execSync('gh repo view --json owner,name -q ".owner.login+\\"/\\"+.name"', {
      encoding: 'utf-8',
    }).trim();
    const [owner, repo] = info.split('/');
    return { owner, repo, number: +input.trim() };
  }

  throw new Error(`PR 식별 불가: "${input}"\n  URL · owner/repo#number · PR번호 중 하나를 입력해주세요.`);
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
  const raw = execSync(
    `gh pr view ${number} --repo ${owner}/${repo} --json ${PR_JSON_FIELDS}`,
    { encoding: 'utf-8' },
  );
  return toPRInfo(owner, repo, JSON.parse(raw));
}

/** 열린 PR 목록 반환. */
export function listOpenPRs(ownerSlashRepo: string): PRInfo[] {
  const raw = execSync(
    `gh pr list --repo ${ownerSlashRepo} --state open --json ${PR_JSON_FIELDS} --limit 50`,
    { encoding: 'utf-8' },
  );
  const [owner, repo] = ownerSlashRepo.split('/');
  return (JSON.parse(raw) as any[]).map((d) => toPRInfo(owner, repo, d));
}

// ── GraphQL 동기화 (스레드 resolve · head SHA · PR 상태) ────

export interface SyncThread {
  id: string;
  isResolved: boolean;
  path: string;
  line: number | null;
  comments: { author: string; body: string }[];
}

export interface PRSyncData {
  status: 'OPEN' | 'CLOSED' | 'MERGED';
  headSha: string;
  threads: SyncThread[];
}

const SYNC_QUERY = `query($owner:String!,$name:String!,$num:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$num){
      state
      headRefOid
      reviewThreads(first:100){
        nodes{
          id isResolved path line originalLine
          comments(first:50){ nodes{ author{ login } body } }
        }
      }
    }
  }
}`;

/** PR 의 현재 상태 + 리뷰 스레드를 한 번의 GraphQL 호출로 가져온다. */
export function fetchPRSyncData(owner: string, repo: string, number: number): PRSyncData {
  // -F (대문자) 만 @- stdin 확장을 지원한다. -f 는 "@-" 를 문자열 그대로 보낸다.
  const raw = execSync(
    `gh api graphql -F owner=${owner} -F name=${repo} -F num=${number} -F query=@-`,
    { encoding: 'utf-8', input: SYNC_QUERY, maxBuffer: 10 * 1024 * 1024 },
  );
  const pr = JSON.parse(raw).data.repository.pullRequest;
  return {
    status: pr.state,
    headSha: pr.headRefOid,
    threads: (pr.reviewThreads?.nodes ?? []).map((n: any) => ({
      id: n.id,
      isResolved: n.isResolved,
      path: n.path,
      line: n.line ?? n.originalLine ?? null,
      comments: (n.comments?.nodes ?? []).map((c: any) => ({
        author: c.author?.login ?? '',
        body: c.body ?? '',
      })),
    })),
  };
}

/**
 * execSync 로 실행한 gh 명령의 오류에서 읽을 수 있는 메시지를 뽑는다.
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

let viewerLoginCache: string | null = null;

/** 현재 gh 인증 계정의 로그인 아이디 (캐시됨). */
export function getViewerLogin(): string {
  if (!viewerLoginCache) {
    viewerLoginCache = execSync('gh api user -q .login', { encoding: 'utf-8' }).trim();
  }
  return viewerLoginCache;
}

// ── Diff 파싱 ───────────────────────────────────────────────

export function fetchDiff(owner: string, repo: string, number: number): string {
  return execSync(`gh pr diff ${number} --repo ${owner}/${repo}`, {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  });
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

/** 인라인 코멘트 포함 리뷰 게시. */
export function postReview(
  owner: string,
  repo: string,
  number: number,
  body: string,
  event: string,
  comments: ReviewComment[],
): void {
  const payload = JSON.stringify({
    body,
    event: event.toUpperCase(),
    comments: comments.map((c) => ({ path: c.path, line: c.line, body: c.body })),
  });
  execSync(`gh api repos/${owner}/${repo}/pulls/${number}/reviews --method POST --input -`, {
    encoding: 'utf-8',
    input: payload,
  });
}

/** 본문만 있는 단순 리뷰 게시. */
export function postSimpleReview(
  owner: string,
  repo: string,
  number: number,
  body: string,
  event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES' = 'COMMENT',
): void {
  const payload = JSON.stringify({ body, event });
  execSync(`gh api repos/${owner}/${repo}/pulls/${number}/reviews --method POST --input -`, {
    encoding: 'utf-8',
    input: payload,
  });
}
