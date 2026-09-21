import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('usage records background refresh', () => {
  it('keeps refresh triggers active when the document is hidden', () => {
    const source = readFileSync(
      new URL('../src/pages/UsageRecordsPage.tsx', import.meta.url),
      'utf8',
    );
    const refreshStart = source.indexOf('const refresh = () => {');
    const refreshEnd = source.indexOf("listen('usage-records-updated'", refreshStart);
    const refreshBlock = source.slice(refreshStart, refreshEnd);

    expect(refreshStart).toBeGreaterThanOrEqual(0);
    expect(refreshEnd).toBeGreaterThan(refreshStart);
    expect(refreshBlock).toContain('if (!disposed) void loadData(true, true);');
    expect(refreshBlock).not.toContain('document.hidden');
  });

  it('keeps the trend tooltip while the pointer stays over the plot', () => {
    const source = readFileSync(
      new URL('../src/pages/UsageRecordsPage.tsx', import.meta.url),
      'utf8',
    );
    expect(source).toContain('hoveredRatio');
    expect(source).toContain('isClientPointInsideRect');
    expect(source).toContain('addEventListener(\'pointermove\', onWindowPointerMove)');
    expect(source).not.toContain('setHoveredIndex(null)');
  });

  it('disables WebView background suspension for the desktop window', () => {
    const config = JSON.parse(
      readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
    );
    const mainWindow = config.app.windows.find((window: { label?: string }) => window.label === 'main');
    const browserArgs = String(mainWindow?.additionalBrowserArgs ?? '').split(/\s+/);

    expect(mainWindow?.backgroundThrottling).toBe('disabled');
    expect(browserArgs).toContain('--disable-background-timer-throttling');
    expect(browserArgs).toContain('--disable-renderer-backgrounding');
    expect(browserArgs).toContain('--disable-backgrounding-occluded-windows');
  });
});
