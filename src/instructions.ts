/**
 * 맞춤 리뷰 지침 — instructions.md 파일의 내용이
 * 매 리뷰 프롬프트의 {{instructions}} 자리에 주입된다.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { AppConfig } from './types.js';

const TEMPLATE = `# 리뷰 맞춤 지침

이 파일의 내용은 매 리뷰 프롬프트에 그대로 포함됩니다.
프로젝트 규칙 · 중점 검토 항목 · 리뷰 톤 등을 자유롭게 작성하세요.
(비워두면 기본 지침만으로 리뷰합니다)

## 예시 — 필요에 맞게 수정하세요

- 코멘트 앞에 심각도를 표기: [P1] 버그·보안 / [P2] 로직·성능 / [P3] 스타일
- 스타일 지적은 최소화하고 버그 · 보안 · 성능 위주로 검토
- 테스트 누락 여부를 확인
- 기존 코드베이스의 컨벤션과 일치하는지 확인
`;

/** 지침 파일이 없으면 템플릿으로 생성하고 경로를 반환한다. */
export function ensureInstructionsFile(cfg: AppConfig): string {
  const f = cfg.customInstructionsFile;
  if (!existsSync(f)) writeFileSync(f, TEMPLATE, 'utf-8');
  return f;
}

/** 지침 내용을 읽는다 (없으면 빈 문자열). */
export function loadInstructions(cfg: AppConfig, overridePath?: string): string {
  const f = overridePath ?? cfg.customInstructionsFile;
  if (!existsSync(f)) return '';
  return readFileSync(f, 'utf-8').trim();
}
