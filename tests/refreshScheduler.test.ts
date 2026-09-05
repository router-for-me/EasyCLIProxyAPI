import { describe, expect, it } from 'bun:test';
import { createRefreshScheduler } from '../src/services/refreshScheduler';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

describe('refresh scheduler', () => {
  it('runs one request at a time and retains only the latest trailing request', async () => {
    const scheduler = createRefreshScheduler(0);
    const firstGate = deferred();
    const calls: number[] = [];
    const first = scheduler.schedule(async () => {
      calls.push(1);
      await firstGate.promise;
    });
    const replaced = scheduler.schedule(async () => { calls.push(2); });
    let latest = replaced;
    for (let index = 3; index <= 1000; index += 1) {
      latest = scheduler.schedule(async () => { calls.push(index); });
      expect(latest).toBe(replaced);
    }
    expect(calls).toEqual([1]);
    firstGate.resolve();
    await Promise.all([first, replaced, latest]);
    expect(calls).toEqual([1, 1000]);
  });

  it('waits between background refreshes but lets an explicit refresh bypass the delay', async () => {
    const scheduler = createRefreshScheduler(30);
    await scheduler.schedule(async () => {});
    const calls: string[] = [];
    const queued = scheduler.schedule(async () => { calls.push('background'); });
    expect(calls).toEqual([]);
    await scheduler.schedule(async () => { calls.push('manual'); }, true);
    await queued;
    expect(calls).toEqual(['manual']);
    const started = performance.now();
    await scheduler.schedule(async () => { calls.push('delayed'); });
    expect(performance.now() - started).toBeGreaterThanOrEqual(25);
  });

  it('cancels queued work during navigation and accepts a fresh request', async () => {
    const scheduler = createRefreshScheduler(0);
    const gate = deferred();
    const active = scheduler.schedule(() => gate.promise);
    let obsoleteRan = false;
    const obsolete = scheduler.schedule(async () => { obsoleteRan = true; });
    scheduler.cancelPending();
    await obsolete;
    let freshRan = false;
    const fresh = scheduler.schedule(async () => { freshRan = true; }, true);
    gate.resolve();
    await Promise.all([active, fresh]);
    expect(obsoleteRan).toBe(false);
    expect(freshRan).toBe(true);
  });

  it('continues after a failed refresh', async () => {
    const scheduler = createRefreshScheduler(0);
    await expect(scheduler.schedule(async () => { throw new Error('query failed'); })).rejects.toThrow('query failed');
    let ran = false;
    await scheduler.schedule(async () => { ran = true; });
    expect(ran).toBe(true);
  });
});
