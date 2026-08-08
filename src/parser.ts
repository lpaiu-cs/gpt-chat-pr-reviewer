/**
 * ChatGPT 응답 텍스트 → 구조화된 ReviewResult 파서.
 *
 * JSON 추출 시도 → 실패하면 전문을 summary 로 fallback.
 */

import type { ReviewResult, ReviewComment } from './types.js';

export function parseGPTResponse(raw: string): ReviewResult {
  const json = extractJSON(raw);
  if (json) {
    try {
      const obj = JSON.parse(json);
      // summary/comments 중 하나도 없으면 리뷰 JSON 이 아니라고 본다
      if (obj && (obj.summary !== undefined || obj.comments !== undefined)) {
        return {
          summary: String(obj.summary ?? '리뷰 요약 없음'),
          approval: normalizeApproval(obj.approval),
          comments: normalizeComments(obj.comments),
          raw,
          parsed: true,
        };
      }
    } catch {
      /* JSON.parse 실패 */
    }
  }

  // 파싱 실패 — 호출부가 게시를 거부해야 한다.
  return { summary: raw.slice(0, 3000), approval: 'comment', comments: [], raw, parsed: false };
}

/** GPT 가 PR 접근 실패를 보고했는지 판별. */
export function isAccessFailure(r: ReviewResult): boolean {
  return r.parsed && r.summary.trim().toUpperCase().startsWith('ACCESS_FAILED');
}

// ── JSON 추출 ───────────────────────────────────────────────

function extractJSON(text: string): string | null {
  // 1) ```json … ```
  const fenced = text.match(/```json\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();

  // 2) ``` … ``` (내부가 JSON)
  const code = text.match(/```\s*([\s\S]*?)```/);
  if (code) {
    const inner = code[1].trim();
    if (inner.startsWith('{')) return inner;
  }

  // 3) 중괄호 범위 추출
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) {
    const candidate = text.slice(first, last + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      /* 유효하지 않음 */
    }
  }

  return null;
}

// ── 정규화 ──────────────────────────────────────────────────

function normalizeApproval(v: unknown): ReviewResult['approval'] {
  if (typeof v !== 'string') return 'comment';
  const s = v.toLowerCase().replace(/[\s_-]/g, '');
  if (s.includes('request') || s.includes('change')) return 'request_changes';
  if (s.includes('approve') && !s.includes('request')) return 'approve';
  return 'comment';
}

function normalizeComments(arr: unknown): ReviewComment[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((c): c is Record<string, unknown> => c !== null && typeof c === 'object')
    .map((c) => ({
      path: String(c.path ?? ''),
      line: typeof c.line === 'number' ? c.line : parseInt(String(c.line), 10) || 0,
      body: String(c.body ?? ''),
    }))
    .filter((c) => c.path && c.body);
}
