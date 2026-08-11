#!/usr/bin/env node

/**
 * `skills/` 의 스킬을 `~/.claude/skills/` 로 설치한다.
 *
 * 스킬을 쓰는 세션은 **다른 레포**에서 일한다. 그래서 이 레포 안의
 * `.claude/skills/` 에 두면 정작 필요한 곳에서 안 보인다 — 전역으로 복사해야
 * 한다.
 *
 * 복사하면서 `{{DAEMON}}` 를 `scripts/daemon.mjs` 의 **절대 경로**로 바꾼다.
 * 심링크나 홈 디렉터리 포인터 파일을 두는 방식은 쓰지 않았다: 심링크는
 * Windows 에서 권한이 필요하고, 포인터 파일은 한 겹 늘어난 만큼 낡을 자리가
 * 생긴다. 경로를 박아 넣으면 레포를 옮겼을 때 다시 설치해야 하지만, 그건
 * 눈에 보이게 실패한다.
 *
 *   npm run install-skills
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'skills');
const DEST = path.join(os.homedir(), '.claude', 'skills');

// 명령줄에 들어가므로 역슬래시를 피한다 (셸·인용부호에 따라 이스케이프로 먹힌다).
const DAEMON = path.join(ROOT, 'scripts', 'daemon.mjs').replace(/\\/g, '/');

if (!existsSync(SRC)) {
  console.error(`skills/ 디렉터리가 없습니다: ${SRC}`);
  process.exit(1);
}

const names = readdirSync(SRC, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

if (names.length === 0) {
  console.error('설치할 스킬이 없습니다.');
  process.exit(1);
}

console.log(`\n  스킬 설치  ${SRC}\n           → ${DEST}\n`);

for (const name of names) {
  const from = path.join(SRC, name, 'SKILL.md');
  if (!existsSync(from)) {
    console.log(`  ⚠ ${name} — SKILL.md 가 없어 건너뜁니다`);
    continue;
  }
  const body = readFileSync(from, 'utf-8').replaceAll('{{DAEMON}}', DAEMON);
  if (body.includes('{{')) {
    console.log(`  ⚠ ${name} — 치환되지 않은 자리표시자가 남아 있습니다`);
  }
  const dir = path.join(DEST, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), body, 'utf-8');
  console.log(`  ✓ ${name}`);
}

console.log(`\n  데몬 경로: ${DAEMON}`);
console.log(`  레포를 옮기면 다시 실행하세요.\n`);
