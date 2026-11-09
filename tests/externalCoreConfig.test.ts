import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync('src/pages/ConfigPanel.tsx', 'utf8');
const restartConditions = [...source.matchAll(/if \(([^()\n]*coreStatus\?\.running[^()\n]*)\) \{/g)]
  .map(match => match[1]);

describe('external core configuration saves', () => {
  it('never restarts an externally managed core after a save', () => {
    expect(restartConditions).toHaveLength(3);
    for (const condition of restartConditions) {
      const shouldRestart = new Function('coreStatus', 'commercialModeChanged', 'networkChanged', `return Boolean(${condition});`);
      for (const [status, expected] of [
        [undefined, false],
        [{ running: false, external: false }, false],
        [{ running: false, external: true }, false],
        [{ running: true, external: true }, false],
        [{ running: true, external: false }, true],
        [{ running: true }, true],
      ] as const) {
        expect(shouldRestart(status, true, true)).toBe(expected);
      }
      if (condition.includes('Changed')) {
        expect(shouldRestart({ running: true, external: false }, false, false)).toBe(false);
      }
    }
  });
});
