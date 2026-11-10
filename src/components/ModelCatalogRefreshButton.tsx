import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { FloatingNotice, useAppNotice } from '../appNotice';
import { useI18n } from '../i18n';
import { refreshModelCatalogs } from '../services/modelCatalogs';

export function ModelCatalogRefreshButton({ disabled, onRefreshed }: {
  disabled: boolean;
  onRefreshed: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const feedback = useAppNotice();

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refresh = async () => {
    if (disabled || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    feedback.clearNotice();
    try {
      const response = await refreshModelCatalogs();
      if (!mounted.current) return;
      onRefreshed();
      const providers = [...new Set(response.changed_providers ?? [])].join(', ');
      feedback.showNotice(providers
        ? { key: 'home.catalog.updated', variables: { providers } }
        : { key: 'home.catalog.success' });
    } catch (error) {
      if (mounted.current) feedback.showNotice({
        key: 'home.catalog.failed',
        variables: { error: error instanceof Error ? error.message : String(error) },
      }, 'error');
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return <>
    <button type="button" className="secondary-button small-button model-catalog-refresh"
      disabled={disabled || busy} aria-busy={busy} title={t('home.catalog.hint')}
      onClick={() => { void refresh(); }}>
      <RefreshCw size={14} className={busy ? 'spin' : undefined} aria-hidden="true" />
      {t(busy ? 'home.catalog.refreshing' : 'home.catalog.refresh')}
    </button>
    <FloatingNotice key={feedback.revision} notice={feedback.notice} onDismiss={feedback.clearNotice} />
  </>;
}
