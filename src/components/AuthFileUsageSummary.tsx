import { Check, Percent, Send, X } from 'lucide-react';
import { useI18n } from '../i18n';
import { authFileRequestStats } from '../services/authFileRequests';
import { formatUsageNumber } from '../services/usageNumber';
import './AuthFileUsageSummary.css';

/** Credential counters are cumulative for the current core session, not the recent request window. */
export function AuthFileUsageSummary({ file }: { file: Record<string, unknown> }) {
  const { t, locale, formatNumber } = useI18n();
  const { success, failure } = authFileRequestStats(file);
  const sum = success === null || failure === null ? null : success + failure;
  const total = sum !== null && Number.isSafeInteger(sum) ? sum : null;
  const rate = total !== null && total > 0 && success !== null ? success / total : null;
  const countText = (count: number | null) => count === null ? '—' : formatUsageNumber(count, locale);
  const exactCount = (count: number | null) => count === null ? '—' : formatNumber(count);
  const rateText = rate === null ? '—' : formatNumber(rate, { style: 'percent', maximumFractionDigits: 1 });
  const metrics = [
    { key: 'total', Icon: Send, value: countText(total), label: `${t('usage.stat.requests')}: ${exactCount(total)}` },
    { key: 'rate', Icon: Percent, value: rateText, label: t('authFiles.requests.rate', { rate: rateText }) },
    { key: 'success', Icon: Check, value: countText(success), label: t('authFiles.requests.success', { count: exactCount(success) }) },
    { key: 'failure', Icon: X, value: countText(failure), label: t('authFiles.requests.failure', { count: exactCount(failure) }) },
  ];

  return (
    <div className="auth-file-usage" role="group" aria-label={t('authFiles.usage.title')}>
      <div className="auth-file-usage-metrics">
        {metrics.map(({ key, Icon, value, label }) => (
          <span key={key} className={`auth-file-usage-metric ${key}`} role="img" title={label} aria-label={label}>
            <Icon size={13} aria-hidden="true" />
            <strong aria-hidden="true">{value}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}
