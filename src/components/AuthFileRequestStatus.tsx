import { useId, useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import { authFileRequestStats, requestRateColor } from '../services/authFileRequests';
import './AuthFileRequestStatus.css';

export function AuthFileRequestStatus({ file, compact = false, summary = false }: {
  file: Record<string, unknown>;
  compact?: boolean;
  summary?: boolean;
}) {
  const { t, formatNumber } = useI18n();
  const stats = useMemo(() => authFileRequestStats(file), [file]);
  const [active, setActive] = useState<number | null>(null);
  const tooltipId = useId();
  const rateText = (rate: number | null) => rate === null ? '—' : formatNumber(rate, {
    style: 'percent', maximumFractionDigits: 1,
  });
  const countText = (count: number | null) => count === null ? '—' : formatNumber(count);
  const compactLayout = compact && !summary;
  const successLabel = t('authFiles.requests.success', { count: countText(stats.success) });
  const failureLabel = t('authFiles.requests.failure', { count: countText(stats.failure) });
  const rateClass = stats.recentRate === null ? ''
    : stats.recentRate >= 0.9 ? 'success' : stats.recentRate >= 0.5 ? 'mixed' : 'failure';
  const detail = active === null ? null : stats.buckets[active];
  const latestRequest = [...stats.buckets].reverse().find((bucket) => bucket.rate !== null);
  const bucketLabel = (index: number) => {
    const bucket = stats.buckets[index];
    const time = bucket.time || t('authFiles.requests.interval', { index: index + 1 });
    return bucket.rate === null
      ? `${time} · ${t('authFiles.requests.empty')}`
      : `${time} · ${t('authFiles.requests.success', { count: formatNumber(bucket.success) })} · ${t('authFiles.requests.failure', { count: formatNumber(bucket.failure) })} · ${t('authFiles.requests.rate', { rate: rateText(bucket.rate) })}`;
  };

  return (
    <div className={`auth-file-requests${compactLayout ? ' auth-file-requests-compact' : ''}${summary ? ' auth-file-requests-summary' : ''}`} role="group" aria-label={t('authFiles.requests.title')}>
      {compactLayout ? <div className="auth-file-requests-latest" title={t('authFiles.requests.window')}>{latestRequest?.time || '—'}</div> : <div className="auth-file-requests-heading">
        <span>{t('authFiles.requests.title')}</span>
        <span className="auth-file-requests-counts" title={t('authFiles.requests.totalsHint')}>
          <span className={stats.success ? 'success' : ''} title={summary ? successLabel : undefined}>{successLabel}</span>
          <span className={stats.failure ? 'failure' : ''} title={summary ? failureLabel : undefined}>{failureLabel}</span>
        </span>
        {stats.recentAvailable && !summary ? <span className="auth-file-requests-window">{t('authFiles.requests.window')}</span> : null}
      </div>}
      {stats.recentAvailable ? (
        <div className="auth-file-requests-timeline" title={summary ? t('authFiles.requests.window') : undefined}>
          <div className="auth-file-requests-chart">
            <div className="auth-file-requests-blocks" onMouseLeave={() => setActive(null)}>
              {stats.buckets.map((bucket, index) => (
                <button
                  key={index}
                  type="button"
                  className={`auth-file-request-block${active === index ? ' active' : ''}`}
                  style={bucket.rate === null ? undefined : { backgroundColor: requestRateColor(bucket.rate) }}
                  aria-label={bucketLabel(index)}
                  aria-describedby={active === index ? tooltipId : undefined}
                  onMouseEnter={() => setActive(index)}
                  onFocus={() => setActive(index)}
                  onBlur={() => setActive(null)}
                  onClick={() => setActive(index)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setActive(null);
                    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                      event.preventDefault();
                      const next = event.key === 'ArrowLeft'
                        ? event.currentTarget.previousElementSibling : event.currentTarget.nextElementSibling;
                      if (next instanceof HTMLButtonElement) next.focus();
                    }
                  }}
                />
              ))}
            </div>
            {detail && active !== null ? (
              <div className={`auth-file-requests-tooltip ${active < 7 ? 'start' : active > 12 ? 'end' : ''}`} id={tooltipId} role="tooltip">
                <strong>{detail.time || t('authFiles.requests.interval', { index: active + 1 })}</strong>
                {detail.rate === null ? <span>{t('authFiles.requests.empty')}</span> : <>
                  <span className="auth-file-requests-counts">
                    <span className="success">{t('authFiles.requests.success', { count: formatNumber(detail.success) })}</span>
                    <span className="failure">{t('authFiles.requests.failure', { count: formatNumber(detail.failure) })}</span>
                  </span>
                  <span>{t('authFiles.requests.rate', { rate: rateText(detail.rate) })}</span>
                </>}
              </div>
            ) : null}
          </div>
          {!compactLayout ? <span className={`auth-file-requests-rate ${rateClass}`} title={t('authFiles.requests.recentRate')}
            aria-label={summary ? t('authFiles.requests.rate', { rate: rateText(stats.recentRate) }) : undefined}>
            {rateText(stats.recentRate)}
          </span> : null}
          {stats.recentRate === null && !summary ? <span>{t('authFiles.requests.empty')}</span> : null}
        </div>
      ) : summary ? <div className="auth-file-requests-timeline">
        <span className="auth-file-requests-unavailable">{t('authFiles.requests.unavailable')}</span>
        <span className="auth-file-requests-rate" title={t('authFiles.requests.recentRate')}
          aria-label={t('authFiles.requests.rate', { rate: '—' })}>—</span>
      </div> : <span className="auth-file-requests-unavailable">{t('authFiles.requests.unavailable')}</span>}
    </div>
  );
}
