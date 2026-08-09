/**
 * tsc 는 .html 을 옮기지 않는다 — 대시보드 템플릿만 dist 로 복사한다.
 * (없어도 서버는 src 경로로 폴백하지만, 배포본에 src 가 없을 수 있다.)
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(path.join(root, 'dist', 'ui'), { recursive: true });
copyFileSync(path.join(root, 'src', 'ui', 'app.html'), path.join(root, 'dist', 'ui', 'app.html'));
