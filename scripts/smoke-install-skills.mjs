#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER = path.join(ROOT, 'scripts', 'install-skills.mjs');
const temp = mkdtempSync(path.join(os.tmpdir(), 'pr-review-skills-'));

function run(args) {
  return spawnSync(process.execPath, [INSTALLER, ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    windowsHide: true,
  });
}

try {
  const destination = path.join(temp, 'installed');
  const result = run(['--dest', destination, '--skill', 'chatgpt-pr-review']);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const skillDir = path.join(destination, 'chatgpt-pr-review');
  const body = readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
  const daemon = path.join(ROOT, 'scripts', 'daemon.mjs').replace(/\\/g, '/');
  assert.ok(body.includes(`node "${daemon}"`), '데몬 절대 경로가 주입되지 않음');
  assert.ok(!body.includes('{{DAEMON}}'), '치환되지 않은 데몬 자리표시자가 남음');
  assert.ok(existsSync(path.join(skillDir, 'agents', 'openai.yaml')), 'Codex 에이전트 메타데이터가 누락됨');
  assert.ok(!existsSync(path.join(destination, 'pr-watch')), '선택하지 않은 스킬이 설치됨');

  const legacyDir = path.join(destination, 'pr-review');
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(
    path.join(legacyDir, 'SKILL.md'),
    'ChatGPT 웹 대화창을 이용한 GitHub PR 자동 리뷰\nnode "scripts/daemon.mjs"',
    'utf-8',
  );
  const migrate = run(['--dest', destination, '--skill', 'chatgpt-pr-review', '--replace-legacy']);
  assert.equal(migrate.status, 0, migrate.stderr || migrate.stdout);
  assert.ok(!existsSync(legacyDir), '확인된 레거시 스킬이 제거되지 않음');

  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(path.join(legacyDir, 'SKILL.md'), 'unrelated pr-review skill', 'utf-8');
  const preserve = run(['--dest', destination, '--skill', 'chatgpt-pr-review', '--replace-legacy']);
  assert.equal(preserve.status, 0, preserve.stderr || preserve.stdout);
  assert.ok(existsSync(legacyDir), '알 수 없는 레거시 스킬을 잘못 제거함');

  const dryDestination = path.join(temp, 'dry-run');
  const dry = run(['--dest', dryDestination, '--skill', 'chatgpt-pr-review', '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr || dry.stdout);
  assert.ok(!existsSync(dryDestination), 'dry-run이 파일을 생성함');

  const invalid = run(['--target', 'unknown']);
  assert.notEqual(invalid.status, 0, '알 수 없는 target을 성공으로 처리함');

  console.log('  ✓ 사용자 지정 경로에 chatgpt-pr-review만 설치');
  console.log('  ✓ {{DAEMON}} 절대 경로 치환');
  console.log('  ✓ agents/openai.yaml 번들 복사');
  console.log('  ✓ 정확히 확인된 레거시만 제거');
  console.log('  ✓ dry-run 무쓰기 보장');
  console.log('  ✓ 잘못된 target 거부');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
