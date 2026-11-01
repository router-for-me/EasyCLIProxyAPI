import { useI18n } from '../../i18n';
import { Switch } from '../../components/Switch';
import type { RoutingSettings } from '../../services/routing';

export function PolicyStrip({ settings, disabled, onChange }: {
  settings: RoutingSettings; disabled: boolean; onChange: (settings: RoutingSettings) => void;
}) {
  const { t } = useI18n();
  const set = <Key extends keyof RoutingSettings>(key: Key, value: RoutingSettings[Key]) => onChange({ ...settings, [key]: value });
  return <section className="panel surface-panel routing-policy">
    <div className="routing-policy-main">
      <label>{t('routing.strategy')}<select disabled={disabled} value={settings.strategy} onChange={event => set('strategy', event.target.value as RoutingSettings['strategy'])}>
        {(['round-robin', 'weighted-round-robin', 'fill-first'] as const).map(strategy => <option key={strategy} value={strategy}>{t(`routing.${strategy}`)}</option>)}
      </select></label>
      <label className="routing-toggle">{t('routing.session_affinity')}<Switch checked={settings.session_affinity} disabled={disabled} onChange={event => set('session_affinity', event.target.checked)} /></label>
      {settings.session_affinity && <label>{t('routing.session_affinity_ttl')}<input disabled={disabled} placeholder="1h" value={settings.session_affinity_ttl} onChange={event => set('session_affinity_ttl', event.target.value)} /></label>}
    </div>
    <details><summary>{t('routing.failover')}</summary><div className="routing-policy-main">
      {(['request_retry', 'max_retry_credentials', 'max_retry_interval', 'transient_error_cooldown_seconds'] as const).map(key => <label key={key}>{t(`routing.${key}`)}<input type="number" min={key === 'transient_error_cooldown_seconds' ? -1 : 0} max={2147483647} step={1} value={Number.isNaN(settings[key]) ? '' : settings[key]} disabled={disabled} onChange={event => set(key, event.target.valueAsNumber)} /></label>)}
      <label className="routing-toggle">{t('routing.disable_cooling')}<Switch disabled={disabled} checked={settings.disable_cooling} onChange={event => set('disable_cooling', event.target.checked)} /></label>
    </div></details>
  </section>;
}
