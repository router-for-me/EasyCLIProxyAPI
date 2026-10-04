import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../../src/i18n';
import { QuotaCard } from '../../src/pages/QuotaPage';
import { quotaRowsFor } from '../../src/services/quotaService';
import '../../src/styles/index.css';

localStorage.setItem('easy-cli-proxy-api.locale', 'en');
const rows = quotaRowsFor('kimi', {
  limits: [{ window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' }, detail: { limit: 100, remaining: 80 } }],
  usage: { limit: 100, remaining: 60 },
});

createRoot(document.getElementById('root')!).render(
  <I18nProvider>
    <main className="content" style={{ width: 1100, padding: 0 }}>
      <section className="page quota-page">
        <div className="real-quota-grid">
          {[1, 2, 3, 4, 5, 6].map((id) => <QuotaCard key={id} file={{ name: `kimi-${id}-long-credential-name@example.com.json`, provider: 'kimi' }} quota={{ status: 'success', rows }} onRefresh={() => {}} />)}
        </div>
        <div className="real-quota-grid">
          <QuotaCard file={{ name: 'codex.json', provider: 'codex' }} quota={{ status: 'success', rows, resetCredits: 2, resetCreditsApplicable: 2, plan: 'team', subscriptionActiveUntil: '2030-10-17T13:58:00Z', resetCreditsEarliestExpiry: '2030-10-23T05:10:00Z' }} onRefresh={() => {}} onReset={() => {}} />
          <QuotaCard file={{ name: 'failed.json', provider: 'kimi' }} quota={{ status: 'error', rows: [], error: 'Quota request failed' }} onRefresh={() => {}} />
          <QuotaCard file={{ name: 'loading.json', provider: 'kimi' }} quota={{ status: 'loading', rows: [] }} onRefresh={() => {}} />
          <QuotaCard file={{ name: 'idle.json', provider: 'kimi' }} quota={{ status: 'idle', rows: [] }} onRefresh={() => {}} />
        </div>
      </section>
    </main>
  </I18nProvider>,
);
