/**
 * 리뷰 슬롯 — 빈 슬롯이 생기면 바로 채운다.
 *
 * 예전 실행기는 N건을 한꺼번에 시작하고 N건이 **다** 끝나야 다시 스캔했다. 라운드
 * 편차가 2~25분이라 가장 느린 1건이 나머지 슬롯을 통째로 묶었다. 여기서는 라운드마다
 * 끝나는 대로 슬롯을 비우고(`settled`) 호출부가 곧바로 다시 `fill` 한다.
 *
 * `live` 는 진행 중인 항목이다. 스캔이 이걸 보고 **진행 중인 PR 을 건드리지 않는다**
 * (cli.ts 의 scan). 스캔과 라운드가 겹쳐도 되는 유일한 조건이다.
 */

export interface RoundPoolOptions<T, Tab> {
  /** 같은 항목을 두 번 시작하지 않기 위한 키 */
  key: (item: T) => string;
  /** 지금 동시에 돌릴 수 있는 수 — 설정이 바뀌면 다음 fill 부터 따른다 */
  capacity: () => number;
  /** 슬롯이 쓸 탭. 던지면 그 항목은 시작하지 않고 이번 fill 을 멈춘다 */
  lease: (slot: number) => Promise<Tab>;
  /** 도는 라운드가 하나도 없을 때 빌린 탭을 돌려준다 */
  release: () => Promise<void>;
  run: (item: T, tab: Tab, index: number, total: number) => Promise<string>;
  /** 라운드가 끝나고 슬롯을 비운 뒤 (성공·실패 무관) */
  settled: (item: T, outcome: string) => void;
  /** lease 실패를 알린다 */
  onLeaseError?: (error: unknown, remaining: number) => void;
}

export function createRoundPool<T, Tab>(o: RoundPoolOptions<T, Tab>) {
  const live = new Map<string, T>();
  const busy = new Set<number>();
  const rounds = new Set<Promise<void>>();

  const start = (item: T, slot: number, tab: Tab, index: number, total: number): void => {
    const key = o.key(item);
    live.set(key, item);
    busy.add(slot);
    const done: Promise<void> = o.run(item, tab, index, total)
      .catch(() => 'failed') // run 은 던지지 않게 만들지만, 새어 나와도 슬롯은 비운다
      .then(async (outcome) => {
        live.delete(key);
        busy.delete(slot);
        if (live.size === 0) await o.release().catch(() => {});
        rounds.delete(done);
        o.settled(item, outcome);
      });
    rounds.add(done);
  };

  return {
    live,
    /** 진행 중인 라운드의 완료 — --once 가 남은 것을 기다린다 */
    rounds,
    /**
     * 빈 슬롯만큼 큐 앞에서부터 시작한다. 시작한 항목은 `queue` 에서 빠진다.
     * 탭은 **시작 전에** 빌린다 — 라운드 안에서 탭을 못 열면 탭 사정을 PR 이
     * 오류·재시도 횟수로 떠안는다. @returns 시작한 수
     */
    async fill(queue: T[]): Promise<number> {
      const total = queue.length;
      let started = 0;
      while (queue.length > 0 && live.size < o.capacity()) {
        const item = queue[0];
        if (live.has(o.key(item))) { queue.shift(); continue; }
        let slot = 0;
        while (busy.has(slot)) slot++;
        let tab: Tab;
        try {
          tab = await o.lease(slot);
        } catch (e) {
          o.onLeaseError?.(e, queue.length);
          break;
        }
        queue.shift();
        start(item, slot, tab, total - queue.length - 1, total);
        started++;
      }
      return started;
    },
  };
}
