import { expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import { HomeOverviewCards } from '../src/pages/HomeOverviewCards';
import { requestRateColor } from '../src/services/authFileRequests';
import type { HomeOverviewSnapshot } from '../src/services/homeOverview';

const snapshot = (rate: number | null): HomeOverviewSnapshot => ({
  usage: {
    totalRequests: rate == null ? 0 : 100,
    successCount: rate ?? 0,
    failureCount: rate == null ? 0 : 100 - rate,
    canceledCount: 0,
    successRate: rate,
  },
  credentials: null,
  providerKeys: null,
  models: null,
  errors: {},
});

const render = (rate: number | null) => renderToStaticMarkup(
  <I18nProvider>
    <HomeOverviewCards snapshot={snapshot(rate)} loading={false} coreReady onRefresh={() => {}} />
  </I18nProvider>,
);

it('colors the success meter continuously from red through yellow to green', () => {
  expect(render(100)).toContain(`--stat-color:${requestRateColor(1)}`);
  expect(render(50)).toContain(`--stat-color:${requestRateColor(0.5)}`);
  expect(render(0)).toContain(`--stat-color:${requestRateColor(0)}`);
  expect(render(95)).not.toContain('home-stat-card warning');
  expect(render(null)).not.toContain('--stat-color');
});

it('colors credential availability with the same scale and keeps unknown availability empty', () => {
  for (const available of [0, 5, 10]) {
    const data = { ...snapshot(null), credentials: { total: 10, available, unavailable: 10 - available, unknown: 0 } };
    const html = renderToStaticMarkup(<I18nProvider><HomeOverviewCards snapshot={data} loading={false} coreReady onRefresh={() => {}} /></I18nProvider>);
    expect(html).toContain(`--stat-color:${requestRateColor(available / 10)}`);
  }
  const data = { ...snapshot(null), credentials: { total: 10, available: 0, unavailable: 0, unknown: 10 } };
  const html = renderToStaticMarkup(<I18nProvider><HomeOverviewCards snapshot={data} loading={false} coreReady onRefresh={() => {}} /></I18nProvider>);
  expect(html).not.toContain('--stat-color');
  expect(html).not.toContain('role="meter"');
});
