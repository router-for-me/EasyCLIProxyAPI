import type { CSSProperties, ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { useI18n } from '../i18n';
import { requestRateColor } from '../services/authFileRequests';
import type { HomeOverviewSnapshot } from '../services/homeOverview';

export function HomeOverviewCards({ snapshot, loading, coreReady, onRefresh, actions }: {
  snapshot: HomeOverviewSnapshot | null;
  loading: boolean;
  coreReady: boolean;
  onRefresh: () => void;
  actions?: ReactNode;
}) {
  const { t, formatNumber } = useI18n();
  const usage = snapshot?.usage;
  const credentials = snapshot?.credentials;
  const rate = usage?.successRate;
  const unavailable = (remote: boolean) => t(loading ? 'common.loading' : remote && !coreReady ? 'home.overview.offline' : 'home.overview.unavailable');
  const cards = [
    {
      id: 'usage', label: t('home.overview.successRate'),
      value: rate == null ? '—' : `${formatNumber(rate, { maximumFractionDigits: 1 })}%`,
      description: usage ? t(usage.totalRequests ? 'home.overview.requests' : 'home.overview.noRequests', { count: formatNumber(usage.totalRequests) }) : unavailable(false),
      tone: 'neutral',
      error: snapshot?.errors.usage,
      percent: rate ?? null,
      meterLabel: t('home.overview.successRate'),
      meterColor: rate == null ? undefined : requestRateColor(rate / 100),
    },
    {
      id: 'credentials', label: t('home.overview.credentials'),
      value: credentials ? formatNumber(credentials.total) : '—',
      description: credentials ? t('home.overview.credentialSummary', credentials)
        + (credentials.unknown ? ` · ${t('home.overview.unknownCredentials', { count: credentials.unknown })}` : '') : unavailable(true),
      tone: credentials?.available ? 'success' : credentials?.unavailable ? 'warning' : 'neutral',
      error: snapshot?.errors.credentials,
      percent: credentials && credentials.total > 0 && credentials.unknown < credentials.total
        ? credentials.available / credentials.total * 100 : null,
      meterLabel: t('home.overview.credentialAvailability'),
    },
    {
      id: 'providerKeys', label: t('home.overview.providerKeys'),
      value: snapshot?.providerKeys == null ? '—' : formatNumber(snapshot.providerKeys),
      description: snapshot?.providerKeys == null ? unavailable(true) : t('home.overview.providerKeysHint'),
      tone: 'neutral', error: snapshot?.errors.providerKeys,
    },
    {
      id: 'models', label: t('home.overview.models'),
      value: snapshot?.models == null ? '—' : formatNumber(snapshot.models.length),
      description: snapshot?.models == null ? unavailable(true) : t('home.overview.modelsHint'),
      tone: 'neutral', error: snapshot?.errors.models,
    },
  ];
  return (
    <section className="home-overview" aria-labelledby="home-overview-title" aria-busy={loading}>
      <div className="home-overview-heading">
        <div className="home-overview-label"><h2 id="home-overview-title">{t('home.overview.title')}</h2><span>{t('home.overview.period')}</span></div>
        <div className="home-overview-actions">{actions}<button type="button" className="icon-button quiet" aria-label={t('home.overview.refresh')} title={t('home.overview.refresh')} disabled={loading} onClick={onRefresh}><RefreshCw size={14} className={loading ? 'spin' : undefined} /></button></div>
      </div>
      <div className="home-stat-grid">
        {cards.map((card) => <article className={`home-stat-card ${card.tone}`} key={card.id} data-stat={card.id} style={'meterColor' in card && card.meterColor ? { '--stat-color': card.meterColor } as CSSProperties : undefined}>
          <h3>{card.label}</h3>
          <strong className="home-stat-value">{card.value}</strong>
          {'percent' in card && <div
            className="home-stat-track"
            role={card.percent != null ? 'meter' : undefined}
            aria-hidden={card.percent == null ? true : undefined}
            aria-label={card.percent != null ? card.meterLabel : undefined}
            aria-valuemin={card.percent != null ? 0 : undefined}
            aria-valuemax={card.percent != null ? 100 : undefined}
            aria-valuenow={card.percent != null ? Math.max(0, Math.min(100, card.percent)) : undefined}
          ><span style={{ width: `${Math.max(0, Math.min(100, card.percent ?? 0))}%` }} /></div>}
          <p title={card.error || undefined}>{card.description}</p>
        </article>)}
      </div>
    </section>
  );
}
