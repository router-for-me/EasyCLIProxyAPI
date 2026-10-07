import { useI18n } from '../i18n';
import { resetCountdown } from '../services/accountDashboard';
import type { Availability } from '../services/quotaAvailability';

export function QuotaAvailabilityNotice({ state, now }: { state: Availability; now: number }) {
  const { t } = useI18n();
  return <div className={`quota-availability quota-availability-${state.kind}`}>
    <strong><span aria-hidden="true">{state.kind === 'exhausted' || state.kind === 'unavailable' ? '⊘' : state.kind === 'available' ? '✓' : '•'}</span> {t(`availability.${state.kind}`)}</strong>
    {(state.kind === 'exhausted' || state.kind === 'creditBacked') && !state.groups && <span>{state.recoveryAt ? t(state.includedOnly ? 'credits.renews' : 'availability.wait', { time: resetCountdown(state.recoveryAt, now) }) : t('accountDashboard.noReset')}</span>}
    {state.kind === 'creditBacked' && <small>{state.creditBalance !== undefined ? t('credits.balance', { count: new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(state.creditBalance) }) : t('credits.reported')} · {t('credits.hint')}</small>}
    {!!state.resetsAvailable && <small>{t('credits.resets', { count: state.resetsAvailable })}</small>}
    {!!state.blockers.length && <small>{state.blockers.map(row => row.label).join(' · ')}</small>}
    {state.recoveryAt && !state.groups && <time dateTime={new Date(state.recoveryAt).toISOString()}>{new Date(state.recoveryAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>}
    {state.uncertainty && <small>{t(`ux.${state.uncertainty}`)}</small>}
    {state.reason && <small>{t(`availability.${state.reason}`)}</small>}
    {state.updating && <small>{t('accountDashboard.refreshing')}</small>}
    {state.groups?.map(group => <small key={group.id} className={`quota-group-state quota-availability-${group.kind}`}>
      {group.label}: {t(`availability.${group.kind}`)}
      {group.recoveryAt ? ` · ${t('availability.wait', { time: resetCountdown(group.recoveryAt, now) })}` : ''}
    </small>)}
  </div>;
}
