import { createRequire } from 'node:module';

// 시작할 때 한 번 읽는다. 실행 중 파일이 바뀌어도 데몬의 버전은 바뀌지 않는다.
export const VERSION: string = createRequire(import.meta.url)('../package.json').version;
