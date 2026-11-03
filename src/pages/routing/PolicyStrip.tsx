import { useI18n } from '../../i18n';
import { Switch } from '../../components/Switch';
import { SegmentedControl } from '../../components/SegmentedControl';
import type { RoutingSettings } from '../../services/routing';

const strategies = ['round-robin', 'weighted-round-robin', 'fill-first'] as const;
const descriptions = { 'round-robin': 'routing.roundRobinDesc', 'weighted-round-robin': 'routing.weightedRoundRobinDesc', 'fill-first': 'routing.fillFirstDesc' } as const;

function StrategyGlyph({ strategy }: { strategy: RoutingSettings['strategy'] }) {
  const lanes = strategy === 'fill-first' ? [3, 0] : strategy === 'weighted-round-robin' ? [2, 1] : [2, 2];
  return <span className="routing-strategy-glyph" aria-hidden="true">{lanes.map((count, lane) => <span key={lane}>{[0, 1, 2].map(dot => <i key={dot} className={dot < count ? 'routing-dot' : 'routing-dot-idle'} />)}</span>)}</span>;
}

export function PolicyStrip({ settings, disabled, onChange }: {
  settings: RoutingSettings; disabled: boolean; onChange: (settings: RoutingSettings) => void;
}) {
  const { t } = useI18n();
  const set = <Key extends keyof RoutingSettings>(key: Key, value: RoutingSettings[Key]) => onChange({ ...settings, [key]: value });
  return <section className="panel surface-panel routing-policy">
    <header><h2>{t('routing.policyTitle')}</h2><p>{t('routing.policyDescription')}</p></header>
    <div className="routing-policy-strategy"><span className="routing-policy-label">{t('routing.strategy')}</span>
      <SegmentedControl className="routing-segmented" aria-label={t('routing.strategy')} disabled={disabled} value={settings.strategy} onChange={value => set('strategy', value)} items={strategies.map(strategy => ({ value: strategy, label: <><StrategyGlyph strategy={strategy} /><span>{t(`routing.${strategy}`)}</span></> }))} />
      <p className="routing-policy-hint">{t(descriptions[settings.strategy])}</p>
    </div>
    <div className="routing-setting-row"><div><strong>{t('routing.session_affinity')}</strong><p>{t('routing.affinityDesc')}</p></div><Switch disabled={disabled} checked={settings.session_affinity} aria-label={t('routing.session_affinity')} onChange={event => set('session_affinity', event.target.checked)} /></div>
    {settings.session_affinity && <label className="routing-ttl">{t('routing.session_affinity_ttl')}<input disabled={disabled} placeholder="1h" value={settings.session_affinity_ttl} onChange={event => set('session_affinity_ttl', event.target.value)} /></label>}
    <details className="routing-failover-details"><summary><strong>{t('routing.failover')}</strong><span className="routing-summary-pill">{t('routing.failoverSummary', { rounds: settings.request_retry, credentials: settings.max_retry_credentials || t('routing.unlimited') })}</span></summary>
      <div className="routing-failover-fields">{(['request_retry', 'max_retry_credentials', 'max_retry_interval', 'transient_error_cooldown_seconds'] as const).map(key => <label className="routing-setting-row" key={key}><span>{t(`routing.${key}`)}</span><input type="number" step={1} min={key === 'transient_error_cooldown_seconds' ? -1 : 0} max={2147483647} disabled={disabled} value={Number.isNaN(settings[key]) ? '' : settings[key]} onChange={event => set(key, event.target.valueAsNumber)} /></label>)}
        <div className="routing-setting-row"><span>{t('routing.disable_cooling')}</span><Switch disabled={disabled} checked={settings.disable_cooling} aria-label={t('routing.disable_cooling')} onChange={event => set('disable_cooling', event.target.checked)} /></div>
      </div>
    </details>
  </section>;
}
