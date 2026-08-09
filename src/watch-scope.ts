/**
 * 감시 범위 해석 — "어떤 레포를 폴링할 것인가" 를 정한다.
 *
 * 설정의 `watch` 블록(계정 단위 + 글롭 include/exclude + 필터)을 레포 목록으로
 * 바꾼다. 실제 폴링(fetchRepoProbe)은 레포 단위이므로, 계정 모드는 검색으로
 * "열린 PR 이 있는 레포" 를 먼저 발견한 뒤 그 목록을 넘긴다.
 *
 * 검색과 폴링의 역할을 나눈 이유: 검색 인덱스는 반영 지연이 있어 새 커밋 감지에
 * 쓸 수 없다. 발견은 느린 주기로 검색이, 감지는 10초 주기로 레포 probe 가 맡는다.
 */

import chalk from 'chalk';
import { searchPRRepos } from './github.js';
import type { AppConfig, WatchFilters, WatchScope } from './types.js';

/** 레포 재탐색 기본 주기 — 새 레포가 5분 안에 감시 범위에 들어온다. */
export const DEFAULT_DISCOVERY_INTERVAL_MS = 5 * 60_000;

// ── 글롭 ────────────────────────────────────────────────────

/**
 * 'owner/repo' 슬러그용 글롭을 정규식으로 바꾼다.
 * `*` 는 슬래시를 넘지 않는다 ('lpaiu-cs/*' 가 다른 계정을 삼키지 않도록).
 * 슬래시가 없는 패턴은 'owner' → 'owner/*' 로 해석한다.
 */
export function globToRegExp(pattern: string): RegExp {
  const p = pattern.includes('/') ? pattern : `${pattern}/*`;
  const body = p
    .split('*')
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${body}$`, 'i'); // GitHub 슬러그는 대소문자를 구분하지 않는다
}

/** include 에 걸리고 exclude 에 걸리지 않으면 true. include 가 비면 전부 통과. */
export function matchesScope(slug: string, include: string[], exclude: string[] = []): boolean {
  const included = include.length === 0 || include.some((p) => globToRegExp(p).test(slug));
  if (!included) return false;
  return !exclude.some((p) => globToRegExp(p).test(slug));
}

// ── 범위 해석 ───────────────────────────────────────────────

/**
 * 설정에서 감시 범위를 뽑는다. 대상을 특정할 수 없으면 null.
 *
 * `watch.include` 가 비어 있으면 구버전 `watchRepos` 로 폴백한다
 * (필터·exclude 는 watch 블록에 적힌 것을 그대로 이어받는다).
 */
export function resolveWatchScope(cfg: AppConfig): WatchScope | null {
  const w = cfg.watch;
  const include = w?.include?.filter((s) => s.trim()) ?? [];

  if (w && include.length > 0) {
    return { ...w, include, exclude: w.exclude ?? [] };
  }
  // review-requested 는 검색 자체가 범위이므로 include 없이도 성립한다
  if (w?.mode === 'review-requested') {
    return { ...w, include: [], exclude: w.exclude ?? [] };
  }
  if (cfg.watchRepos.length > 0) {
    return {
      mode: 'repos',
      include: [...cfg.watchRepos],
      exclude: w?.exclude ?? [],
      filters: w?.filters,
      discoveryIntervalMs: w?.discoveryIntervalMs,
    };
  }
  return null;
}

/** 글롭에서 검색에 쓸 소유자(org/user)를 뽑는다. 소유자 자리가 글롭이면 못 쓴다. */
function ownersFromPatterns(include: string[]): { owners: string[]; skipped: string[] } {
  const owners = new Set<string>();
  const skipped: string[] = [];
  for (const p of include) {
    const owner = (p.includes('/') ? p.split('/')[0] : p).trim();
    if (!owner || owner.includes('*')) skipped.push(p);
    else owners.add(owner);
  }
  return { owners: [...owners], skipped };
}

export interface DiscoveryResult {
  repos: string[];
  /** 검색 페이지 상한에 걸려 일부만 훑었는지 */
  truncated: boolean;
  /** 이번 탐색이 쓴 GraphQL point */
  cost: number;
}

/**
 * 감시 대상 레포 목록을 구한다.
 *
 * repos 모드는 설정에 적힌 그대로 쓰고, 나머지는 GraphQL 검색으로 발견한다
 * (실측 cost 는 페이지당 1 point).
 */
export function discoverRepos(scope: WatchScope): DiscoveryResult {
  const exclude = scope.exclude ?? [];

  if (scope.mode === 'repos') {
    // 글롭은 검색 없이 펼칠 수 없다. 조용히 버리면 감시 대상이 통째로 빠진다.
    const globs = scope.include.filter((p) => p.includes('*'));
    if (globs.length > 0) {
      console.log(
        chalk.yellow(
          `  ⚠ repos 모드에서는 글롭을 펼칠 수 없습니다 — 무시: ${globs.join(', ')}`,
        ),
      );
      console.log(chalk.dim('    글롭을 쓰려면 watch.mode 를 "account" 로 바꾸세요.'));
    }
    const literal = scope.include.filter((p) => !p.includes('*'));
    return { repos: literal.filter((s) => matchesScope(s, [], exclude)), truncated: false, cost: 0 };
  }

  const queries: string[] = [];
  if (scope.mode === 'review-requested') {
    queries.push('is:pr is:open archived:false review-requested:@me');
  } else {
    const { owners, skipped } = ownersFromPatterns(scope.include);
    if (skipped.length > 0) {
      console.log(
        chalk.yellow(`  ⚠ 소유자를 특정할 수 없는 패턴은 검색할 수 없습니다 — 무시: ${skipped.join(', ')}`),
      );
    }
    for (const o of owners) queries.push(`is:pr is:open archived:false org:${o}`);
  }

  const found = new Set<string>();
  let truncated = false;
  let cost = 0;
  for (const q of queries) {
    try {
      const r = searchPRRepos(q);
      r.repos.forEach((s) => found.add(s));
      truncated ||= r.truncated;
      cost += r.cost;
    } catch {
      console.log(chalk.yellow(`  ⚠ 레포 탐색 실패 (${q}) — 이전 목록을 유지합니다.`));
    }
  }

  return {
    repos: [...found].filter((s) => matchesScope(s, scope.include, exclude)).sort(),
    truncated,
    cost,
  };
}

// ── 재탐색 캐시 ─────────────────────────────────────────────

export interface RepoSource {
  /** 필요하면 재탐색하고 현재 대상 목록을 돌려준다. */
  list(): string[];
  /** 마지막 탐색에서 결과가 잘렸는지 */
  truncated: boolean;
  /** 마지막 탐색 시각 (0 = 아직 없음) */
  lastAt: number;
}

/**
 * 레포 목록을 주기적으로만 재탐색한다.
 *
 * 폴링은 10초 주기지만 새 레포가 생기는 빈도는 그보다 훨씬 낮다. 매 tick
 * 검색하면 point 만 낭비하므로 discoveryIntervalMs(기본 5분)로 늦춘다.
 * 탐색이 실패하면 직전 목록을 그대로 쓴다 — 일시적 오류로 감시가 멈추면 안 된다.
 */
export function createRepoSource(scope: WatchScope): RepoSource {
  const interval = scope.discoveryIntervalMs ?? DEFAULT_DISCOVERY_INTERVAL_MS;
  let cached: string[] = [];
  const source: RepoSource = {
    truncated: false,
    lastAt: 0,
    list() {
      const stale = Date.now() - source.lastAt >= interval;
      if (source.lastAt > 0 && !stale) return cached;

      const r = discoverRepos(scope);
      source.lastAt = Date.now();
      source.truncated = r.truncated;
      // 탐색이 실패해 0건이 나왔는데 직전 목록이 있으면 그것을 유지한다
      if (r.repos.length === 0 && cached.length > 0) {
        console.log(chalk.yellow('  ⚠ 레포 탐색 결과가 비었습니다 — 직전 목록을 유지합니다.'));
        return cached;
      }
      const added = r.repos.filter((s) => !cached.includes(s));
      const removed = cached.filter((s) => !r.repos.includes(s));
      cached = r.repos;
      if (added.length > 0) console.log(chalk.dim(`    감시 추가: ${added.join(', ')}`));
      if (removed.length > 0) console.log(chalk.dim(`    감시 해제: ${removed.join(', ')}`));
      if (r.truncated) {
        console.log(
          chalk.yellow('  ⚠ 검색 결과가 페이지 상한에 걸렸습니다 — 일부 레포가 빠졌을 수 있습니다.'),
        );
      }
      return cached;
    },
  };
  return source;
}

// ── 필터 ────────────────────────────────────────────────────

export interface FilterVerdict {
  ok: boolean;
  /** ok=false 일 때 사람이 읽을 사유 */
  reason?: string;
}

/** 필터 판정 대상 — probe 가 주는 필드 중 필터가 쓰는 것만. */
export interface FilterablePR {
  author: string;
  isDraft: boolean;
  labels: string[];
}

/**
 * PR 이 리뷰 큐에 오를 자격이 있는지 판정한다.
 *
 * draft 는 기본 제외다. 초안은 작성 중이라 리뷰가 곧 낡고, 계정 전체를 감시하면
 * 초안까지 대화 한도를 먹는다. `filters.draft: true` 로 되돌릴 수 있다.
 */
export function passesFilters(pr: FilterablePR, filters?: WatchFilters): FilterVerdict {
  if (pr.isDraft && !(filters?.draft ?? false)) {
    return { ok: false, reason: '초안(draft)' };
  }

  const authors = filters?.authors;
  if (authors && authors.length > 0) {
    const allow = new Set(authors.map((a) => a.toLowerCase()));
    if (!allow.has(pr.author.toLowerCase())) {
      return { ok: false, reason: `작성자 ${pr.author} 는 대상 아님` };
    }
  }

  const labels = filters?.labels;
  if (labels && labels.length > 0) {
    const want = new Set(labels.map((l) => l.toLowerCase()));
    if (!pr.labels.some((l) => want.has(l.toLowerCase()))) {
      return { ok: false, reason: `라벨 없음 (${labels.join(' | ')})` };
    }
  }

  return { ok: true };
}

/** watch 시작 시 한 줄로 요약해 보여줄 범위 설명. */
export function describeScope(scope: WatchScope): string {
  const parts = [`mode=${scope.mode}`];
  if (scope.include.length > 0) parts.push(`include=${scope.include.join(',')}`);
  if (scope.exclude && scope.exclude.length > 0) parts.push(`exclude=${scope.exclude.join(',')}`);
  const f = scope.filters;
  if (f?.authors?.length) parts.push(`authors=${f.authors.join(',')}`);
  if (f?.labels?.length) parts.push(`labels=${f.labels.join(',')}`);
  parts.push(f?.draft ? 'draft=포함' : 'draft=제외');
  return parts.join(' · ');
}
