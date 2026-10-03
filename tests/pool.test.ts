import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoundPool } from '../src/pool.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('슬롯이 비면 나머지 라운드를 기다리지 않고 바로 채운다', async () => {
  const finish = new Map<string, () => void>();
  const leased: number[] = [];
  const settled: string[] = [];
  const leaseErrors: number[] = [];
  let released = 0;
  let failLease = false;
  let capacity = 2;
  const pool = createRoundPool<string, number>({
    key: (s) => s,
    capacity: () => capacity,
    canStart: () => true,
    lease: async (slot) => {
      if (failLease) throw new Error('탭을 못 열었다');
      leased.push(slot);
      return slot;
    },
    release: async () => { released++; },
    run: (item) => new Promise((resolve) => finish.set(item, () => resolve('posted'))),
    settled: (item) => settled.push(item),
    onLeaseError: (_e, remaining) => leaseErrors.push(remaining),
  });

  const queue = ['a', 'b', 'c', 'd'];
  assert.equal(await pool.fill(queue), 2);
  assert.deepEqual([...pool.live.keys()], ['a', 'b']);
  assert.deepEqual(queue, ['c', 'd']);
  assert.equal(await pool.fill(['b']), 0, '진행 중인 항목은 다시 시작하지 않는다');

  finish.get('b')!();
  await flush();
  assert.deepEqual(settled, ['b']);
  assert.equal(released, 0, 'a 가 아직 돌고 있으면 탭을 반납하지 않는다');
  assert.equal(await pool.fill(queue), 1, 'a 를 기다리지 않고 빈 슬롯을 채운다');
  assert.deepEqual([...pool.live.keys()], ['a', 'c']);
  assert.deepEqual(leased, [0, 1, 1], '빈 슬롯 번호를 다시 쓴다');

  // 탭을 못 열면 그 항목은 시작하지 않고 큐에 남는다 (다음 스캔이 다시 채운다).
  capacity = 3;
  failLease = true;
  assert.equal(await pool.fill(queue), 0);
  assert.deepEqual(queue, ['d']);
  assert.deepEqual(leaseErrors, [1]);

  finish.get('a')!();
  finish.get('c')!();
  await flush();
  assert.equal(pool.live.size, 0);
  assert.equal(pool.rounds.size, 0);
  assert.equal(released, 1, '마지막 라운드가 끝나면 한 번 반납한다');
});

test('탭을 빌리는 사이 게이트가 닫히면 시작하지 않고 큐에 남긴다 (#53 리뷰)', async () => {
  // 옆 라운드가 쿼터로 끝나거나 중지·일시정지가 들어오는 것은 탭 임대(await) 도중일 수 있다.
  let open = true;
  let released = 0;
  const started: string[] = [];
  const pool = createRoundPool<string, number>({
    key: (s) => s,
    capacity: () => 2,
    canStart: () => open,
    lease: async (slot) => { open = false; return slot; }, // 빌리는 동안 게이트가 닫힌다
    release: async () => { released++; },
    run: async (item) => { started.push(item); return 'posted'; },
    settled: () => {},
  });
  const queue = ['a', 'b'];
  assert.equal(await pool.fill(queue), 0);
  assert.deepEqual(started, []);
  assert.deepEqual(queue, ['a', 'b'], '시작하지 않은 항목은 큐에 남는다');
  assert.equal(released, 1, '도는 라운드가 없으면 방금 빌린 탭을 반납한다');

  // 닫혀 있으면 탭도 빌리지 않는다.
  assert.equal(await pool.fill(queue), 0);
  assert.equal(released, 1);
});
