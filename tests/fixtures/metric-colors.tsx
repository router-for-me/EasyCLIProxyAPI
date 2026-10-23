import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../../src/i18n';
import { HomeOverviewCards } from '../../src/pages/HomeOverviewCards';
import { AuthFileQuotaPanel } from '../../src/components/AuthFileQuotaPanel';
import { QuotaCard } from '../../src/pages/QuotaPage';
import '../../src/styles/index.css';
import '../../src/pages/HomeDashboard.css';
import '../../src/pages/AuthFileManagementPage.css';

const rates = [0, 25, 50, 75, 100];
createRoot(document.getElementById('root')!).render(<I18nProvider>
  {rates.map(rate => <div key={rate} data-rate={rate}>
    <HomeOverviewCards snapshot={{
      usage: { totalRequests: 100, successCount: rate, failureCount: 100 - rate, canceledCount: 0, successRate: rate },
      credentials: { total: 100, available: rate, unavailable: 100 - rate, unknown: 0 },
      models: null, providerKeys: null, errors: {},
    }} loading={false} coreReady onRefresh={() => {}} />
    <AuthFileQuotaPanel file={{ name: 'fixture', provider: 'codex' }} disabled={false} compact dense
      quota={{ status: 'success', rows: [{ label: 'Window', remainingPercent: rate }] }} onRefresh={() => {}} />
    <div className="quota-page"><QuotaCard file={{ name: 'fixture', provider: 'codex' }}
      quota={{ status: 'success', rows: [{ label: 'Window', remainingPercent: rate }] }} onRefresh={() => {}} /></div>
  </div>)}
  <div data-unknown><AuthFileQuotaPanel file={{ name: 'fixture' }} disabled={false}
    quota={{ status: 'success', rows: [{ label: 'Unknown', remainingPercent: null }] }} onRefresh={() => {}} /></div>
</I18nProvider>);
