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
      if (obj && typeof obj.summary === 'string' && obj.summary.trim() &&
          ['approve', 'request_changes', 'comment'].includes(obj.approval) &&
          Array.isArray(obj.comments) && obj.comments.every(isComment) &&
          (obj.reviewedHeadSha === undefined || typeof obj.reviewedHeadSha === 'string') &&
          (obj.reviewedBaseSha === undefined || typeof obj.reviewedBaseSha === 'string')) {
        return {
          summary: obj.summary,
          approval: obj.approval,
          comments: obj.comments,
          reviewedHeadSha: obj.reviewedHeadSha,
          reviewedBaseSha: obj.reviewedBaseSha,
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

function isComment(c: unknown): c is ReviewComment {
  if (!c || typeof c !== 'object') return false;
  const v = c as Record<string, unknown>;
  return typeof v.path === 'string' && v.path.trim().length > 0 &&
    typeof v.body === 'string' && v.body.trim().length > 0 &&
    Number.isSafeInteger(v.line) && (v.line as number) > 0;
}
