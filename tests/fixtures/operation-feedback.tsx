import { StrictMode, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { I18nProvider } from '../../src/i18n';
import { FloatingNotice, MessageNotice, useAppNotice } from '../../src/appNotice';
import { UsageRecordsPage } from '../../src/pages/UsageRecordsPage';
import { AgentConfigurationFeedback } from '../../src/pages/AgentControls';
import { useConfirmation } from '../../src/components/ConfirmationDialog';
import { QuotaActionFeedback } from '../../src/components/QuotaActionFeedback';
import '../../src/styles.css';

const params = new URLSearchParams(location.search);
localStorage.setItem('easy-cli-proxy-api.locale', params.get('locale') ?? 'zh-CN');
localStorage.setItem('cpa-gui.usage-records-tab.v1', 'pricing');
document.documentElement.dataset.theme = params.get('theme') ?? 'light';
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
  if (cmd === 'sync_usage_model_prices') {
    if (fixture.feedbackFixture.failSync) throw new Error('price sync failed');
    return { imported: 77, skipped: 0, unmatched: ['test-model'], usedBuiltin: false };
  }
  if (cmd === 'save_usage_model_price' || cmd === 'delete_usage_model_price') return null;
  throw new Error('Unexpected fixture command: ' + cmd);
}, { shouldMockEvents: true });

function Fixture() {
  const first = useAppNotice();
  const second = useAppNotice();
  const [agent, setAgent] = useState(false);
  const [quota, setQuota] = useState(false);
  const [nativeError, setNativeError] = useState('');
  const { askConfirmation, confirmationDialog } = useConfirmation();
  const [mounted, setMounted] = useState(true);
  const dialog = useRef<HTMLDialogElement>(null);
  return <main style={{ padding: 24 }}>
    <div data-testid="toolbar" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <button onClick={() => first.showNotice('Saved', 'success')}>Success</button>
      <button onClick={() => first.showNotice('Failure '.repeat(120), 'error')}>Error</button>
      <button onClick={() => second.showNotice('Second result', 'info')}>Second</button>
      <button onClick={() => { first.clearNotice(); second.clearNotice(); setAgent(false); setQuota(false); }}>Clear</button>
      <button onClick={() => setAgent(true)}>Agent result</button>
      <button onClick={() => setQuota(true)}>Quota result</button>
      <button onClick={() => dialog.current?.showModal()}>Native dialog</button>
      <button onClick={() => void askConfirmation({ title: "Confirm test", message: "Confirm the operation", confirmText: "Confirm" })}>Confirmation dialog</button>
      <button onClick={() => setMounted(value => !value)}>Toggle source</button>
    </div>
    <section data-testid="panel" style={{ transform: 'translateZ(0)', overflow: 'hidden', height: 210, marginTop: 16, border: '1px solid gray' }}>
      {mounted && <><FloatingNotice key={first.revision} notice={first.notice} onDismiss={first.clearNotice} />
        <FloatingNotice key={second.revision} notice={second.notice} onDismiss={second.clearNotice} /></>}
      <div data-testid="before">Existing form</div>
      <AgentConfigurationFeedback pending={agent} notice={agent ? 'Agent saved' : ''} error="" description={agent ? 'Persistent description '.repeat(40) : ''} />
      {quota && <QuotaActionFeedback name="test.json" quota={{ status: 'success', rows: [], actionResult: { action: 'reset', status: 'refresh-error', error: 'query failed' } }} />}
      <input data-testid="after" defaultValue="Keep focus" />
    </section>
    {confirmationDialog}
    <dialog ref={dialog} className="agent-backup-modal" style={{ width: 400, height: 'calc(100vh - 48px)' }}>
      <h2>Native backup dialog</h2>
      <button onClick={() => setNativeError('Native modal error')}>Native error</button>
      <MessageNotice message={nativeError} onDismiss={() => setNativeError('')} />
      <button data-testid="native-footer" style={{ position: 'absolute', right: 20, bottom: 20 }} onClick={() => dialog.current?.close()}>Close dialog</button>
    </dialog>
  </main>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><I18nProvider>
  {params.get('scenario') === 'pricing' ? <UsageRecordsPage /> : <Fixture />}
</I18nProvider></StrictMode>);
