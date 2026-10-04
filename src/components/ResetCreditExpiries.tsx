import { useI18n } from '../i18n';
import { formatQuotaTimestamp, quotaResetExpiries, type QuotaState } from '../services/quotaService';
import './ResetCreditExpiries.css';

export function ResetCreditExpiries({ quota }: { quota: QuotaState }) {
  const { locale, t } = useI18n();
  const expiries = quotaResetExpiries(quota);
  if (!expiries.length) return null;
  return <div className="reset-credit-expiries">
    <strong>{t('quota.resetCreditExpiries')}</strong>
    <ol>{expiries.map((expiry, index) => <li key={`${expiry}-${index}`}>
      <span>{t('quota.resetCreditExpiry', { index: index + 1 })}</span>
      <span>{formatQuotaTimestamp(expiry, locale)}</span>
    </li>)}</ol>
  </div>;
}
