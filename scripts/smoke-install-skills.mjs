#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  const metadataFile = path.join(skillDir, 'agents', 'openai.yaml');
  assert.ok(existsSync(metadataFile), 'Codex 에이전트 메타데이터가 누락됨');
  const metadata = readFileSync(metadataFile, 'utf-8');
  assert.match(metadata, /allow_implicit_invocation:\s*false/, '암시적 스킬 호출이 차단되지 않음');
  assert.ok(!body.includes('"review this PR"'), '일반 PR 리뷰 문구가 트리거에 남음');
  assert.ok(!existsSync(path.join(destination, 'pr-watch')), '선택하지 않은 스킬이 설치됨');

  const dryDestination = path.join(temp, 'dry-run');
  const dry = run(['--dest', dryDestination, '--skill', 'chatgpt-pr-review', '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr || dry.stdout);
  assert.ok(!existsSync(dryDestination), 'dry-run이 파일을 생성함');

  const invalid = run(['--target', 'unknown']);
  assert.notEqual(invalid.status, 0, '알 수 없는 target을 성공으로 처리함');

  console.log('  ✓ 사용자 지정 경로에 chatgpt-pr-review만 설치');
  console.log('  ✓ {{DAEMON}} 절대 경로 치환');
  console.log('  ✓ agents/openai.yaml 번들 복사');
  console.log('  ✓ 명시 호출 전용 정책·트리거 경계');
  console.log('  ✓ dry-run 무쓰기 보장');
  console.log('  ✓ 잘못된 target 거부');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
