import { expect, test } from 'bun:test';
import { downloadReleaseBytes } from '../scripts/download-release.mjs';

const url = 'https://example.test/checksums.txt';
const quiet = { wait: async () => {}, warn: () => {} };

test('retries gateway failures with exponential backoff and returns the complete body', async () => {
  let calls = 0;
  const delays: number[] = [];
  const bytes = await downloadReleaseBytes(url, {
    ...quiet,
    wait: async (delay: number) => { delays.push(delay); },
    fetchImpl: async (_url: string, options: RequestInit) => {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      calls += 1;
      return calls < 3 ? new Response('gateway timeout', { status: 504 }) : new Response('verified bytes');
    },
  });
  expect(bytes.toString()).toBe('verified bytes');
  expect(delays).toEqual([2000, 4000]);
});

test('retries network and interrupted body transfers', async () => {
  let calls = 0;
  const bytes = await downloadReleaseBytes(url, {
    ...quiet,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      if (calls === 2) return { ok: true, arrayBuffer: async () => { throw new Error('connection reset'); } };
      return new Response('complete');
    },
  });
  expect(calls).toBe(3);
  expect(bytes.toString()).toBe('complete');
});

test('fails immediately on missing assets', async () => {
  let calls = 0;
  await expect(downloadReleaseBytes(url, {
    ...quiet,
    fetchImpl: async () => { calls += 1; return new Response('', { status: 404 }); },
  })).rejects.toThrow('HTTP 404');
  expect(calls).toBe(1);
});

test('stops after five transient failures', async () => {
  let calls = 0;
  await expect(downloadReleaseBytes(url, {
    ...quiet,
    fetchImpl: async () => { calls += 1; return new Response('', { status: 504 }); },
  })).rejects.toThrow('failed after 5 attempt(s): HTTP 504');
  expect(calls).toBe(5);
});
