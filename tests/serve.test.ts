import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('background delegates to ensure, opens its actual URL once, and supports no-open', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'serve-cli-'));
  const preload = path.join(dir, 'preload.mjs');
  writeFileSync(preload, `
    import cp from 'node:child_process';
    import { promisify } from 'node:util';
    import { EventEmitter } from 'node:events';
    import { syncBuiltinESMExports } from 'node:module';
    cp.execFile = Object.assign(() => { throw new Error('unexpected execFile'); }, {
      [promisify.custom]: async (file, args, opts) => {
        if (file !== process.execPath || !args[0].endsWith('daemon.mjs') ||
            args.slice(1).join(' ') !== 'ensure --json' || !opts.windowsHide) throw new Error('bad delegation');
        console.log('ENSURE');
        if (process.env.FAIL_ENSURE) throw Object.assign(new Error('command failed'), { stdout: JSON.stringify({ error: 'startup failed' }) });
        return { stdout: JSON.stringify({ ui: process.env.UI_URL || 'http://127.0.0.1:4491', started: false, mode: 'review' }) };
      }
    });
    cp.spawn = (cmd, args, opts) => {
      if (!opts.windowsHide || !opts.detached) throw new Error('visible console');
      console.log('OPEN ' + args.at(-1));
      const child = new EventEmitter(); child.unref = () => {};
      if (process.env.FAIL_OPEN) setImmediate(() => child.emit('error', new Error('no browser')));
      return child;
    };
    syncBuiltinESMExports();
  `);
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const loader = new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href;
  const run = (args: string[], env = {}) => execFileSync(process.execPath,
    ['--import', pathToFileURL(preload).href, '--import', loader, cli, ...args],
    { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 10_000, env: { ...process.env, ...env }, stdio: 'pipe' });
  try {
    const out = run(['serve', '-b']);
    assert.equal(out.split('\n').filter(line => line === 'ENSURE').length, 1);
    assert.equal(out.split('\n').filter(line => line === 'OPEN http://127.0.0.1:4491').length, 1);
    assert.match(out, /pr-review stop/);
    assert.doesNotMatch(run(['watch', '--background', '--no-open']), /OPEN /);
    assert.match(run(['serve', '-b'], { FAIL_OPEN: '1' }), /기존 데몬/);
    assert.throws(() => run(['serve', '-b'], { FAIL_ENSURE: '1' }), (e: any) => {
      assert.match(e.stderr, /startup failed/);
      assert.doesNotMatch(e.stdout, /OPEN /); return true;
    });
    assert.throws(() => run(['serve', '-b'], { UI_URL: 'http://127.0.0.1:4491/?x=&other' }), (e: any) => {
      assert.doesNotMatch(e.stdout, /OPEN /); return true;
    });
    for (const option of ['--observe', '--once', '--dry-run', '--headless', '--no-ui', '--ui-port=9000']) {
      assert.throws(() => run(['serve', '-b', option]), (e: any) => {
        assert.doesNotMatch(e.stdout, /ENSURE|OPEN /); return true;
      });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
