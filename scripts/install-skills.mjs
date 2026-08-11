#!/usr/bin/env node

/**
 * `skills/` 의 스킬을 Codex·Claude Code 또는 지정한 skills 디렉터리에
 * 설치한다. 설치할 때 `{{DAEMON}}` 을 이 설치본의 `scripts/daemon.mjs`
 * 절대 경로로 바꾼다. 저장소를 옮겼으면 이 스크립트를 다시 실행한다.
 */

import {
  copyFileSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'skills');

// 명령줄에 들어가므로 역슬래시를 피한다 (셸·인용부호에 따라 이스케이프로 먹힌다).
const DAEMON = path.join(ROOT, 'scripts', 'daemon.mjs').replace(/\\/g, '/');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const values = (name) => {
  const found = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name && argv[i + 1]) found.push(...argv[++i].split(','));
  }
  return found.map((v) => v.trim()).filter(Boolean);
};
const value = (name) => values(name).at(-1) ?? null;

const hostRoots = {
  codex: path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex')),
  claude: path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')),
};
const legacyNames = {
  'chatgpt-pr-review': ['pr-review'],
};

function usage() {
  console.log(`
  PR reviewer 스킬 설치

    npm run install-skills -- [옵션]

  옵션
    --target codex|claude|all   설치할 에이전트 (반복·쉼표 가능)
    --dest <skills-dir>         사용자 지정 skills 디렉터리
    --skill <name>              이 스킬만 설치 (반복·쉼표 가능)
    --replace-legacy             이 프로젝트의 이전 스킬 이름을 검증 후 제거
    --dry-run                   파일을 쓰지 않고 대상만 표시
    --help                      도움말

  --target과 --dest를 생략하면 이미 존재하는 Codex/Claude 홈을
  감지해 설치하고, 둘 다 없으면 Codex를 기본으로 삼습니다.
`);
}

function die(message) {
  console.error(`  ✗ ${message}`);
  process.exit(1);
}

function selectedTargets() {
  const custom = value('--dest');
  const requested = values('--target').flatMap((v) => (v === 'all' ? ['codex', 'claude'] : [v]));
  if (custom && requested.length > 0) die('--dest와 --target은 함께 쓸 수 없습니다.');
  if (custom) return [{ name: 'custom', dir: path.resolve(custom) }];

  const names = requested.length > 0
    ? requested
    : Object.entries(hostRoots)
        .filter(([, root]) => existsSync(root))
        .map(([name]) => name);
  if (names.length === 0) names.push('codex');

  const unknown = names.filter((name) => !(name in hostRoots));
  if (unknown.length > 0) die(`알 수 없는 target: ${unknown.join(', ')}`);

  const seen = new Set();
  return [...new Set(names)].flatMap((name) => {
    const dir = path.join(hostRoots[name], 'skills');
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ name, dir }];
  });
}

function copySkill(from, to, relative = '') {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const destination = path.join(to, entry.name);
    const childRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      copySkill(source, destination, childRelative);
    } else if (childRelative === 'SKILL.md') {
      const body = readFileSync(source, 'utf-8').replaceAll('{{DAEMON}}', DAEMON);
      if (body.includes('{{DAEMON}}')) die(`${source}에 치환되지 않은 {{DAEMON}}이 남았습니다.`);
      writeFileSync(destination, body, 'utf-8');
    } else {
      copyFileSync(source, destination);
    }
  }
}

function isLegacyProjectSkill(skillFile) {
  try {
    const body = readFileSync(skillFile, 'utf-8');
    return body.includes('scripts/daemon.mjs') && (
      body.includes('gpt-chat-pr-reviewer') ||
      body.includes('ChatGPT 웹 대화창을 이용한 GitHub PR 자동 리뷰')
    );
  } catch {
    return false;
  }
}

function handleLegacyNames(target, installedName) {
  for (const legacyName of legacyNames[installedName] ?? []) {
    const legacyDir = path.resolve(target.dir, legacyName);
    if (path.dirname(legacyDir) !== path.resolve(target.dir)) {
      die(`잘못된 레거시 스킬 경로: ${legacyDir}`);
    }
    const legacySkill = path.join(legacyDir, 'SKILL.md');
    if (!existsSync(legacySkill)) continue;

    if (!flag('--replace-legacy')) {
      console.log(`    ⚠ ${legacyName} 이름의 스킬이 남아 있습니다 — 이 프로젝트의 이전 스킬이면 --replace-legacy로 교체하세요.`);
      continue;
    }
    if (!isLegacyProjectSkill(legacySkill)) {
      console.log(`    ⚠ ${legacyName} 은 이 프로젝트의 이전 스킬임을 확인할 수 없어 유지합니다.`);
      continue;
    }
    if (flag('--dry-run')) {
      console.log(`    · 레거시 ${legacyName} 제거 예정`);
    } else {
      rmSync(legacyDir, { recursive: true, force: true });
      console.log(`    ✓ 레거시 ${legacyName} 제거`);
    }
  }
}

if (flag('--help') || flag('-h')) {
  usage();
  process.exit(0);
}

if (!existsSync(SRC)) {
  die(`skills/ 디렉터리가 없습니다: ${SRC}`);
}

const names = readdirSync(SRC, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

if (names.length === 0) {
  die('설치할 스킬이 없습니다.');
}

const requestedSkills = values('--skill');
const installNames = requestedSkills.length > 0 ? [...new Set(requestedSkills)] : names;
const unknownSkills = installNames.filter((name) => !names.includes(name));
if (unknownSkills.length > 0) die(`알 수 없는 스킬: ${unknownSkills.join(', ')}`);

const targets = selectedTargets();
console.log(`\n  스킬 ${flag('--dry-run') ? '설치 예정' : '설치'}  ${SRC}`);
for (const target of targets) {
  console.log(`  대상 ${target.name.padEnd(6)}  ${target.dir}`);
  for (const name of installNames) {
    const from = path.join(SRC, name);
    const skillFile = path.join(from, 'SKILL.md');
    if (!existsSync(skillFile)) {
      console.log(`    ⚠ ${name} — SKILL.md가 없어 건너뜁니다`);
      continue;
    }
    if (!flag('--dry-run')) copySkill(from, path.join(target.dir, name));
    console.log(`    ${flag('--dry-run') ? '·' : '✓'} ${name}`);
    handleLegacyNames(target, name);
  }
}

console.log(`\n  데몬 경로  ${DAEMON}`);
console.log('  저장소를 옮겼으면 이 설치 명령을 다시 실행하세요.\n');
