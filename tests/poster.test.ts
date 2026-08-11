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
