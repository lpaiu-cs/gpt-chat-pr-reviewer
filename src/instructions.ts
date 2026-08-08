/**
 * 맞춤 리뷰 지침 — instructions.md 파일의 내용이
 * 매 리뷰 프롬프트의 {{instructions}} 자리에 주입된다.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { AppConfig } from './types.js';

// HTML 주석은 프롬프트에서 제거된다 — 파일 사용법 설명이 GPT 에게 전달되지 않도록.
const TEMPLATE = `<!--
이 파일의 내용은 매 리뷰 프롬프트에 "리뷰 지침" 으로 주입됩니다.
프로젝트 규칙 · 중점 검토 항목 · 리뷰 톤 등을 자유롭게 작성하세요.
비워두면 기본 지침만으로 리뷰합니다.
이 주석 블록은 프롬프트에서 자동으로 제거됩니다.
-->

- 코멘트 앞에 심각도를 표기: [P1] 버그·보안 / [P2] 로직·성능 / [P3] 스타일
- 스타일 지적은 최소화하고 버그 · 보안 · 성능 위주로 검토
- 테스트 누락 여부를 확인
- 기존 코드베이스의 컨벤션과 일치하는지 확인
- 확실하지 않은 추측은 사실처럼 지적하지 말고 전제를 밝힐 것
`;

/** 지침 파일이 없으면 템플릿으로 생성하고 경로를 반환한다. */
export function ensureInstructionsFile(cfg: AppConfig): string {
  const f = cfg.customInstructionsFile;
  if (!existsSync(f)) writeFileSync(f, TEMPLATE, 'utf-8');
  return f;
}

/** 지침 내용을 읽는다 — HTML 주석은 제거된다 (없으면 빈 문자열). */
export function loadInstructions(cfg: AppConfig, overridePath?: string): string {
  const f = overridePath ?? cfg.customInstructionsFile;
  if (!existsSync(f)) return '';
  return readFileSync(f, 'utf-8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
