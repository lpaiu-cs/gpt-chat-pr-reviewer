import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewBody } from '../src/poster.js';

test('buildReviewBody includes the current review round', () => {
  const body = buildReviewBody({
    summary: '요약입니다',
    approval: 'comment',
    comments: [],
    raw: '',
    parsed: true,
  }, { round: 3 });

  assert.match(body, /## gpt-chat-pr-reviewer 3차 리뷰/);
});

// 봇 고지 (메인테이너 지시로 오독되던 문제)
//
// 봇은 메인테이너 토큰으로 게시하므로 GitHub 상에서 사람의 리뷰와
// 구별되지 않는다. 다른 에이전트가 이걸 메인테이너 지시로 읽지
// 않도록, 고지는 **판정보다 먼저** 나와야 한다.

const review = {
  summary: '요약입니다',
  approval: 'request_changes' as const,
  comments: [],
  raw: '',
  parsed: true,
};

test('buildReviewBody: 봇 리뷰임을 밝힌다', () => {
  const body = buildReviewBody(review, { round: 1 });
  assert.match(body, /자동화 봇에 의한 gpt 리뷰/);
  assert.match(body, /사용자 의견이나 판단을 담지 않습니다/);
});

test('buildReviewBody: 고지가 판정보다 먼저 온다', () => {
  const body = buildReviewBody(review, { round: 1 });
  assert.ok(body.indexOf('자동화 봇') < body.indexOf('**판정:'));
});

test('buildReviewBody: self PR 안내문은 더 이상 붙지 않는다', () => {
  // 게시 형식(COMMENT 하향)은 운영 상세이지 리뷰 내용이 아니다.
  assert.doesNotMatch(buildReviewBody(review, { round: 1 }), /self PR/);
});

test('buildReviewBody: 전체 본문 모양', () => {
  assert.equal(
    buildReviewBody(review, { round: 1 }),
    [
      '## gpt-chat-pr-reviewer 1차 리뷰',
      '',
      '> 이 리뷰는 자동화 봇에 의한 gpt 리뷰이며, 사용자 의견이나 판단을 담지 않습니다.',
      '',
      '**판정: 🔧 request_changes — 수정 필요**',
      '',
      '요약입니다',
    ].join('\n'),
  );
});
