import { setTimeout as sleep } from 'node:timers/promises';

// Include reading the body in each attempt: a successful response can still stall
// or disconnect while transferring a release archive.
export async function downloadReleaseBytes(url, {
  fetchImpl = fetch,
  wait = sleep,
  warn = console.warn,
  attempts = 5,
  timeoutMs = 120_000,
} = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let retryable = true;
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        retryable = [408, 429].includes(response.status) || response.status >= 500;
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (!retryable || attempt === attempts) {
        throw new Error(`Download ${url} failed after ${attempt} attempt(s): ${error.message}`, { cause: error });
      }
      const delay = Math.min(2_000 * 2 ** (attempt - 1), 30_000);
      warn(`Download ${url} failed (${error.message}); retrying in ${delay / 1000}s (${attempt}/${attempts})`);
      await wait(delay);
    }
  }
}
