import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { I18nProvider } from '../../src/i18n';
import { FloatingNotice, MessageNotice, useAppNotice } from '../../src/appNotice';
import { UsageRecordsPage } from '../../src/pages/UsageRecordsPage';
import { AgentConfigurationFeedback } from '../../src/pages/AgentControls';
import { useConfirmation } from '../../src/components/ConfirmationDialog';
import { Dialog } from '../../src/components/Dialog';
import { QuotaActionFeedback } from '../../src/components/QuotaActionFeedback';
import { themeRegistry } from '../../src/themes/registry';
import { createThemeApplicator } from '../../src/themes/applyTheme';
import type { PlatformWindowMaterial } from '../../src/themes/types';
import '../../src/styles/index.css';

const params = new URLSearchParams(location.search);
localStorage.setItem('easy-cli-proxy-api.locale', params.get('locale') ?? 'zh-CN');
localStorage.setItem('cpa-gui.usage-records-tab.v1', 'pricing');
const themeId = params.get('themeId');
if (themeId) {
  const theme = themeRegistry.get(themeId);
  const material = params.get('material') as PlatformWindowMaterial | null;
  if (theme) createThemeApplicator(document, () => material)(theme);
} else {
  document.documentElement.dataset.theme = params.get('theme') ?? 'light';
  if (params.get('material')) document.documentElement.dataset.windowMaterial = params.get('material')!;
}
const fixture = window as typeof window & { feedbackFixture: { failSync: boolean } };
fixture.feedbackFixture = { failSync: false };
mockIPC(async (cmd) => {
  if (cmd === 'set_app_locale') return null;
  if (cmd === 'get_usage_collector_status') return { state: 'collecting', totalRecords: 1 };
  if (cmd === 'get_usage_analysis') return { models: [], providers: [], sources: [], apiKeys: [] };
  if (cmd === 'get_usage_pricing') return {
    rows: [{ model: 'test-model', requests: 1, totalTokens: 100, estimatedCost: 0, price: null }],
    totalCost: 0, totalRequests: 1, pricedRequests: 0, savedPrices: 0,
  };
  if (cmd === 'preview_usage_model_prices') {
    if (fixture.feedbackFixture.failSync) throw new Error('price sync failed');
    return {
      source: 'Models.dev', sourceUrl: 'https://models.dev/api.json', unmatched: [],
      matches: [{ model: 'test-model', prompt: 2, completion: 6, cache: 0, cacheRead: 0, cacheCreation: 0,
        promptConfigured: true, completionConfigured: true, cacheReadConfigured: false, cacheCreationConfigured: false,
        source: 'models.dev', sourceModelId: 'openai/test-model', updatedAtMs: 0 }],
    };
  }
  if (cmd === 'apply_usage_model_prices') return { imported: 1 };
  if (cmd === 'save_usage_model_price' || cmd === 'delete_usage_model_price') return null;
  throw new Error('Unexpected fixture command: ' + cmd);
}, { shouldMockEvents: true });

function Fixture() {
  const first = useAppNotice();
  const second = useAppNotice();
  const [agent, setAgent] = useState(false);
  const [quota, setQuota] = useState(false);
  const [dialogError, setDialogError] = useState('');
  const { askConfirmation, confirmationDialog } = useConfirmation();
  const [mounted, setMounted] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  return <main style={{ padding: 24 }}>
    <div data-testid="toolbar" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <button onClick={() => first.showNotice('Saved', 'success')}>Success</button>
      <button onClick={() => first.showNotice('Failure '.repeat(120), 'error')}>Error</button>
      <button onClick={() => first.showNotice('Saved settings for sample-credential-12345678-1234-1234-1234-123456789012.json', 'success')}>Wrapped</button>
      <button onClick={() => second.showNotice('Second result', 'info')}>Second</button>
      <button onClick={() => { first.clearNotice(); second.clearNotice(); setAgent(false); setQuota(false); }}>Clear</button>
      <button onClick={() => setAgent(true)}>Agent result</button>
      <button onClick={() => setQuota(true)}>Quota result</button>
      <button onClick={() => setDialogOpen(true)}>Tall dialog</button>
      <button onClick={() => void askConfirmation({ title: "Confirm test", message: "Confirm the operation", confirmText: "Confirm" })}>Confirmation dialog</button>
      <button onClick={() => setMounted(value => !value)}>Toggle source</button>
    </div>
    <section data-testid="panel" style={{ transform: 'translateZ(0)', overflow: 'hidden', height: 210, marginTop: 16, border: '1px solid gray' }}>
      {mounted && <><FloatingNotice key={first.revision} notice={first.notice} onDismiss={first.clearNotice} />
        <FloatingNotice key={second.revision} notice={second.notice} onDismiss={second.clearNotice} /></>}
      <div data-testid="before">Existing form</div>
      <div className="agent-save-bar">
        <AgentConfigurationFeedback pending={agent} description="" />
        <div className="agent-save-actions"><button>Apply agent</button></div>
      </div>
      <MessageNotice tone="success" message={agent ? 'Agent saved' : ''} />
      {quota && <QuotaActionFeedback name="test.json" quota={{ status: 'success', rows: [], actionResult: { action: 'reset', status: 'refresh-error', error: 'query failed' } }} />}
      <input data-testid="after" defaultValue="Keep focus" />
    </section>
    {confirmationDialog}
    {dialogOpen && <Dialog className="agent-backup-modal" label="Tall backup dialog" onClose={() => setDialogOpen(false)}>
      <div style={{ position: 'relative', width: 400, height: 'calc(100vh - 96px)' }}>
        <button onClick={() => setDialogError('Dialog error')}>Dialog error</button>
        <MessageNotice message={dialogError} onDismiss={() => setDialogError('')} />
        <button data-testid="dialog-footer" style={{ position: 'absolute', right: 0, bottom: 0 }} onClick={() => setDialogOpen(false)}>Close dialog</button>
      </div>
    </Dialog>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><I18nProvider>
  {params.get('scenario') === 'pricing' ? <UsageRecordsPage /> : <Fixture />}
</I18nProvider></StrictMode>);
