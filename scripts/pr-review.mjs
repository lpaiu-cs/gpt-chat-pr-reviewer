#!/usr/bin/env node
/**
 * 전역 `pr-review` 명령의 진입점. **소스가 있으면 소스를 쓴다** (daemon.mjs 의 launch 와 같은 규칙).
 *
 * bin 이 `dist/cli.js` 를 가리키던 때, 체크아웃을 npm link 한 명령은 pull 한 뒤에도 마지막으로
 * build 한 코드를 돌렸다. 버전은 package.json 을 런타임에 읽어 새 값이 찍히므로 낡은 줄 몰랐다 —
 * 2026-10-14 `pr-review -- serve` 가 10-07 빌드(v0.6.2)를 돌려 en-US 고정 이전 코드로 한국어
 * 사이드바에서 프로젝트를 못 찾았다. 그동안 `npm run dev` 는 같은 체크아웃에서 멀쩡했다.
 * 배포 패키지에는 src 가 없으므로 그때만 dist 를 쓴다.
 */
import { existsSync } from 'node:fs';

const src = new URL('../src/cli.ts', import.meta.url);
if (existsSync(src)) {
  const { register } = await import('tsx/esm/api');
  register();
  await import(src.href);
} else {
  await import(new URL('../dist/cli.js', import.meta.url).href);
}
