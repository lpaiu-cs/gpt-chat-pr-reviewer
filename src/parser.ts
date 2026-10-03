/**
 * ChatGPT 응답 텍스트 → 구조화된 ReviewResult 파서.
 *
 * JSON 추출 시도 → 실패하면 전문을 summary 로 fallback.
 */

import type { ReviewResult, ReviewComment } from './types.js';

/**
 * 첨부를 인용하면 답 본문에 `:chatgpt-content-reference{index="0"}` 같은 표식이 글자로
 * 섞인다. JSON 문자열 안에 들어오면 그 큰따옴표가 JSON 을 깨뜨린다 (platelog#4 — Pro 가
 * 12분 걸려 만든 지적을 파싱 실패로 버렸다).
 *
 * 정상 JSON 은 손대지 않는다 — 원문 그대로 먼저 파싱하고, 실패할 때만 걷어낸다. 걷어내는
 * 것도 완전한 표식(`{키=값, …}`)뿐이다. `\{[^}]*\}` 로 두면 표식을 코드 예제로 언급한
 * 리뷰에서 JSON 의 따옴표·괄호까지 먹어 리뷰 전체가 거부된다 (#47 리뷰).
 */
const CITATION_ATTR = String.raw`\w+=(?:"[^"{}\n]*"|[\w.-]+)`;
const CITATION = new RegExp(String.raw`\s*:(?:chatgpt-content-reference|contentReference)(?:\[[\w:]*\])?` +
  String.raw`\{${CITATION_ATTR}(?:\s*,?\s*${CITATION_ATTR})*\}`, 'g');

export function parseGPTResponse(raw: string): ReviewResult {
  return parseReview(raw, raw) ?? parseReview(raw.replace(CITATION, ''), raw)
    // 파싱 실패 — 호출부가 게시를 거부해야 한다.
    ?? { summary: raw.slice(0, 3000), approval: 'comment', comments: [], raw, parsed: false };
}

function parseReview(text: string, raw: string): ReviewResult | null {
  const json = extractJSON(text);
  if (!json) return null;
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
  return null;
}

/** GPT 가 PR 접근 실패를 보고했는지 판별. */
export function isAccessFailure(r: ReviewResult): boolean {
  return r.parsed && r.summary.trim().toUpperCase().startsWith('ACCESS_FAILED');
}

/**
 * `ACCESS_FAILED: <무엇을 열다가 어떤 오류를 봤는지>` 의 뒷부분 (없으면 '').
 *
 * 이유 없는 ACCESS_FAILED 는 원인을 가리지 못한다 — platelog#10 은 같은 210자 답을
 * 네 번 받고도 PR URL·커밋 URL·첨부 중 무엇이 막혔는지 알 수 없었다.
 */
export function accessFailureReason(r: ReviewResult): string {
  // 한 줄로 편다 — 실패 메시지는 첫 줄만 lastError 로 남는다.
  return r.summary.trim().slice('ACCESS_FAILED'.length).replace(/^[\s:：\-—]+/, '').replace(/\s+/g, ' ').trim();
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
