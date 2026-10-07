import { useState, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { quotaAvailability } from '../services/quotaAvailability';
import { providerForFile, quotaKey, type AuthFile, type QuotaState } from '../services/quotaService';
import { QuotaAvailabilityNotice } from './QuotaAvailabilityNotice';
import { resetCountdown } from '../services/accountDashboard';

export function QuotaProviderSummary({ accounts, quotas, name, icon, now, stale, labelFor }: {
  accounts: AuthFile[]; quotas: Record<string, QuotaState>; name: string; icon: ReactNode;
  now: number; stale: boolean; labelFor: (file: AuthFile) => string;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const states = accounts.map(file => quotaAvailability(file, quotas[quotaKey(file)], now, stale));
  const unknownReasons = [...new Set(states.filter(state => state.kind === 'unknown').map(state => state.reason))];
  const summaryReason = unknownReasons.length === 1 ? unknownReasons[0] : undefined;
  const count = (kind: string) => states.filter(state => state.kind === kind).length;
  const creditOnly = states.length > 0 && states.every(state => state.kind === 'creditBacked');
  const resets = states.flatMap(state => state.kind === 'exhausted' && state.recoveryAt ? [state.recoveryAt] : []);
  const groupBased = accounts.every(file => providerForFile(file) === 'antigravity');
  const groups = states.flatMap((state, index) => (state.groups ?? []).map(group => ({ ...group, account: accounts[index] })));
  const unconfirmed = states.every(state => state.kind === 'unknown' || state.kind === 'resetDue');
  const groupUnknown = !groups.length || groups.every(group => group.kind === 'unknown' || group.kind === 'resetDue');
  const summaryLabel = groupBased ? groups.length ? 'availability.ofGroups' : states.length === 1 ? `availability.${states[0].kind}` as const : 'availability.unknown'
    : unconfirmed ? 'availability.unknown' : 'availability.ofAccounts';
  return <div className="quota-provider-summary-cell">
    <div className="quota-summary-heading">{icon}<strong>{name}</strong><span>{accounts.length === 1 ? t('quotaLedger.credential') : t('quotaLedger.credentials', { count: accounts.length })}</span></div>
    <span className="quota-summary-label">{t(groupBased ? 'availability.reportedGroups' : 'availability.included')}</span>
    <div className="quota-summary-total"><strong className="quota-summary-value">{creditOnly ? '—' : groupBased ? (groupUnknown ? '—' : groups.filter(group => group.kind === 'available').length) : unconfirmed ? '—' : count('available')}</strong><span>{creditOnly ? t('credits.reported') : t(summaryLabel, { count: groupBased && groups.length ? groups.length : accounts.length })}</span></div>
    <div className="quota-account-states">{states.map((state, index) => <span key={quotaKey(accounts[index])} className={`quota-account-state ${state.kind}`} title={`${labelFor(accounts[index])}: ${t(`availability.${state.kind}`)}`} aria-label={`${labelFor(accounts[index])}: ${t(`availability.${state.kind}`)}`} />)}</div>
    <div className="quota-state-counts">{(['exhausted', 'creditBacked', 'limited', 'unknown', 'resetDue', 'unavailable', 'disabled'] as const).filter(kind => count(kind)).map(kind => <span key={kind} className={`quota-count-${kind}`}>{count(kind)} {kind === 'unknown' && summaryReason ? t(`availability.${summaryReason}Short`) : t(`availability.${kind}`)}</span>)}</div>
    {groupBased && <div className="quota-provider-groups">{groups.map(group => <div key={`${quotaKey(group.account)}:${group.id}`} className={`quota-availability-${group.kind}`}>
      <span>{accounts.length > 1 ? `${labelFor(group.account)} · ` : ''}{group.label}</span><strong>{t(`availability.${group.kind}`)}</strong>
      {group.recoveryAt && <small>{t('availability.wait', { time: resetCountdown(group.recoveryAt, now) })}</small>}
    </div>)}</div>}
    {!!resets.length && !groupBased && <div className="quota-summary-reset">{accounts.every(file => providerForFile(file) === 'codex') ? t('credits.renews', { time: resetCountdown(Math.min(...resets), now) }) : `${t('availability.recovery')} · ${resetCountdown(Math.min(...resets), now)}`}</div>}
    <div className="quota-summary-extra"><span>{t('availability.scopeHint')}</span><button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{t(expanded ? 'quotaLedger.hide' : 'quotaLedger.show')}</button></div>
    {expanded && <div className="quota-summary-breakdown">{accounts.map((file, index) => <div key={quotaKey(file)}><strong className="quota-summary-account-name">{labelFor(file)}</strong><QuotaAvailabilityNotice state={states[index]} now={now} /></div>)}</div>}
  </div>;
}
