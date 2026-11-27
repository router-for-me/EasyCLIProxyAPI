import type { AppLocale } from '../../i18n';
import type {
  AccountSummary,
  QuotaMetric,
  SwitchPlatformId,
} from '../../services/accountSwitch';

export const BRAND_ICON_KEY: Record<SwitchPlatformId, string> = {
  codex: 'codex',
  claude_code: 'claude',
  antigravity: 'antigravity',
  grok: 'grok',
  kimi: 'kimi',
  github_copilot: 'copilot',
  windsurf_devin: 'devin',
  workbuddy: 'workbuddy',
  workbuddy_ai: 'workbuddy',
  zcode: 'zcode',
  claude_desktop: 'claude',
};

const MONO_DARK_ICON_PLATFORMS = new Set<SwitchPlatformId>([
  'github_copilot',
  'windsurf_devin',
  'grok',
  'kimi',
]);

export function isMonoDarkIcon(platform: SwitchPlatformId): boolean {
  return MONO_DARK_ICON_PLATFORMS.has(platform);
}

type TranslateFn = (
  key: string,
  params?: Record<string, string | number>,
) => string;

function normalizeTimestampMs(ts: number | null | undefined): number | null {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return null;
  return ts > 1_000_000_000_000 ? ts : ts * 1000;
}

export function formatLocalizedDuration(
  remainingMs: number,
  t: TranslateFn,
): string {
  if (remainingMs <= 0) return t('accountSwitch.time.resetDone');
  const totalMins = Math.ceil(remainingMs / 60_000);
  if (totalMins < 60) {
    return t('accountSwitch.time.durMinutes', { m: totalMins });
  }
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours < 24) {
    return mins > 0
      ? t('accountSwitch.time.durHoursMinutes', { h: hours, m: mins })
      : t('accountSwitch.time.durHours', { h: hours });
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0
    ? t('accountSwitch.time.durDaysHours', { d: days, h: remHours })
    : t('accountSwitch.time.durDays', { d: days });
}

export function formatRelativeTime(
  tsMs: number | null | undefined,
  t: TranslateFn,
): string {
  const ms = normalizeTimestampMs(tsMs);
  if (!ms) return '';
  const diff = Math.max(0, Date.now() - ms);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return t('accountSwitch.time.justNow');
  if (mins < 60) return t('accountSwitch.time.minutesAgo', { m: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('accountSwitch.time.hoursAgo', { h: hours });
  return t('accountSwitch.time.daysAgo', { d: Math.floor(hours / 24) });
}

export function formatResetCountdown(
  resetAtSecs: number | null | undefined,
  t: TranslateFn,
): string | null {
  const resetMs = normalizeTimestampMs(resetAtSecs);
  if (!resetMs) return null;
  return formatLocalizedDuration(resetMs - Date.now(), t);
}

export function formatAbsoluteDateTime(
  ts: number | null | undefined,
  locale: AppLocale,
  dateOnly = false,
): string | null {
  const ms = normalizeTimestampMs(ts);
  if (!ms) return null;
  try {
    return new Intl.DateTimeFormat(
      locale,
      dateOnly
        ? { year: 'numeric', month: '2-digit', day: '2-digit' }
        : {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          },
    ).format(ms);
  } catch {
    const d = new Date(ms);
    return dateOnly ? d.toISOString().slice(0, 10) : d.toLocaleString();
  }
}

export function formatShortDate(
  ts: number | null | undefined,
  locale: AppLocale,
): string | null {
  const ms = normalizeTimestampMs(ts);
  if (!ms) return null;
  try {
    return new Intl.DateTimeFormat(locale, {
      month: '2-digit',
      day: '2-digit',
    }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(5, 10);
  }
}

const KNOWN_METRIC_ID_KEYS: Record<string, string> = {
  '5h': 'accountSwitch.quota.metric.5h',
  weekly: 'accountSwitch.quota.metric.weekly',
  '7d': 'accountSwitch.quota.metric.7d',
  '7d_sonnet': 'accountSwitch.quota.metric.7dSonnet',
  '7d_opus': 'accountSwitch.quota.metric.7dOpus',
  daily: 'accountSwitch.quota.metric.daily',
  code_review: 'accountSwitch.quota.metric.codeReview',
  premium_interactions: 'accountSwitch.quota.metric.premiumRequests',
  chat: 'accountSwitch.quota.metric.chat',
  completions: 'accountSwitch.quota.metric.completions',
  status: 'accountSwitch.quota.metric.sessionStatus',
  main: 'accountSwitch.quota.metric.primary',
};

export function localizeQuotaMetricLabel(
  metric: QuotaMetric,
  t: TranslateFn,
): string {
  const idKey = KNOWN_METRIC_ID_KEYS[metric.id.trim().toLowerCase()];
  if (idKey) return t(idKey);

  const label = metric.label.trim();
  const minsMatch = /^(\d+)\s*m\s+window$/i.exec(label);
  if (minsMatch) {
    return t('accountSwitch.quota.metric.minutesWindow', {
      minutes: minsMatch[1],
    });
  }
  const winIdxMatch = /^window\s*#(\d+)$/i.exec(label);
  if (winIdxMatch) {
    return t('accountSwitch.quota.metric.windowIndex', {
      index: winIdxMatch[1],
    });
  }
  return label || metric.id;
}

export function localizeQuotaMetricDetail(
  detail: string | null | undefined,
  t: TranslateFn,
): string | null {
  if (!detail) return null;
  if (detail.trim().toLowerCase() === 'unlimited') {
    return t('accountSwitch.quota.unlimited');
  }
  return detail;
}

export type ExpiryTone = 'ok' | 'soon' | 'expired' | 'muted';

export interface AccountExpiryView {
  kind: 'plan' | 'token' | 'none';
  tone: ExpiryTone;
  /** Primary card / table text, e.g. "套餐到期 2026/12/15（剩 18 天）" */
  label: string;
  /** Compact badge text for compact rows & overview, e.g. "到期 11/29" */
  compactLabel: string;
  /** Detailed hover tooltip combining plan & token expiry */
  tooltip: string;
  /** Normalized timestamp in ms for sorting (Infinity when unknown) */
  sortMs: number;
}

export function describeAccountExpiry(
  account: AccountSummary,
  locale: AppLocale,
  t: TranslateFn,
): AccountExpiryView {
  const now = Date.now();
  const planMs = normalizeTimestampMs(account.planExpiresAt);
  const tokenMs = normalizeTimestampMs(account.tokenExpiresAt);

  const tokenTip = tokenMs
    ? tokenMs <= now
      ? account.hasRefreshToken
        ? t('accountSwitch.expiry.tokenExpiredAuto')
        : t('accountSwitch.expiry.tokenExpired')
      : t('accountSwitch.expiry.tokenValidUntil', {
          time: formatAbsoluteDateTime(tokenMs, locale, false) ?? '',
        })
    : null;

  if (planMs) {
    const deltaMs = planMs - now;
    const fullDate = formatAbsoluteDateTime(planMs, locale, true) ?? '';
    const shortDate = formatShortDate(planMs, locale) ?? fullDate;
    if (deltaMs <= 0) {
      const label = t('accountSwitch.expiry.planExpired', { date: fullDate });
      return {
        kind: 'plan',
        tone: 'expired',
        label,
        compactLabel: t('accountSwitch.expiry.compactExpired'),
        tooltip: tokenTip ? `${label} · ${tokenTip}` : label,
        sortMs: planMs,
      };
    }
    const daysLeft = Math.ceil(deltaMs / 86_400_000);
    const tone: ExpiryTone = daysLeft <= 3 ? 'soon' : 'ok';
    const remainingText =
      daysLeft <= 1
        ? formatLocalizedDuration(deltaMs, t)
        : t('accountSwitch.time.durDays', { d: daysLeft });
    const label = t('accountSwitch.expiry.planUntil', {
      date: fullDate,
      remaining: remainingText,
    });
    const compactLabel =
      daysLeft <= 7
        ? t('accountSwitch.expiry.compactDaysLeft', { remaining: remainingText })
        : t('accountSwitch.expiry.compactDate', { date: shortDate });
    return {
      kind: 'plan',
      tone,
      label,
      compactLabel,
      tooltip: tokenTip ? `${label} · ${tokenTip}` : label,
      sortMs: planMs,
    };
  }

  if (tokenMs) {
    const deltaMs = tokenMs - now;
    const absTime = formatAbsoluteDateTime(tokenMs, locale, false) ?? '';
    if (deltaMs <= 0) {
      const label = account.hasRefreshToken
        ? t('accountSwitch.expiry.tokenExpiredAuto')
        : t('accountSwitch.expiry.tokenExpired');
      return {
        kind: 'token',
        tone: account.hasRefreshToken ? 'soon' : 'expired',
        label,
        compactLabel: t('accountSwitch.expiry.compactExpired'),
        tooltip: `${label} (${absTime})`,
        sortMs: tokenMs,
      };
    }
    const remaining = formatLocalizedDuration(deltaMs, t);
    const label = account.hasRefreshToken
      ? t('accountSwitch.expiry.tokenInAuto', { remaining })
      : t('accountSwitch.expiry.tokenIn', { remaining });
    const tone: ExpiryTone =
      !account.hasRefreshToken && deltaMs < 3_600_000 ? 'soon' : 'muted';
    return {
      kind: 'token',
      tone,
      label,
      compactLabel: t('accountSwitch.expiry.compactToken', { remaining }),
      tooltip: t('accountSwitch.expiry.tokenValidUntil', { time: absTime }),
      sortMs: tokenMs,
    };
  }

  return {
    kind: 'none',
    tone: 'muted',
    label: t('accountSwitch.expiry.none'),
    compactLabel: '—',
    tooltip: t('accountSwitch.expiry.none'),
    sortMs: Number.POSITIVE_INFINITY,
  };
}

export type QuotaTone = 'high' | 'medium' | 'low' | 'critical';

export function quotaTone(percent: number | null): QuotaTone {
  if (percent === null) return 'medium';
  if (percent >= 60) return 'high';
  if (percent >= 35) return 'medium';
  if (percent >= 15) return 'low';
  return 'critical';
}

export type TierBadgeVariant =
  | 'plus'
  | 'pro'
  | 'max'
  | 'team'
  | 'free'
  | 'default';

export function tierBadgeVariant(planType: string | null): TierBadgeVariant {
  if (!planType) return 'default';
  const lower = planType.trim().toLowerCase();
  if (lower.includes('max') || lower.includes('ultra')) return 'max';
  if (lower.includes('plus')) return 'plus';
  if (
    lower.includes('team') ||
    lower.includes('enterprise') ||
    lower.includes('business')
  ) {
    return 'team';
  }
  if (lower.includes('pro')) return 'pro';
  if (lower.includes('free') || lower.includes('trial')) return 'free';
  return 'default';
}

export function averageRemainingQuota(account: AccountSummary): number {
  const metrics = account.lastQuota?.metrics ?? [];
  const valid = metrics
    .map((item) => item.remainingPercent)
    .filter(
      (value): value is number =>
        typeof value === 'number' && Number.isFinite(value),
    );
  if (valid.length === 0) return -1;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

export function effectiveExpiryMs(account: AccountSummary): number {
  return (
    normalizeTimestampMs(account.planExpiresAt) ??
    normalizeTimestampMs(account.tokenExpiresAt) ??
    Number.POSITIVE_INFINITY
  );
}

export function pickRecommendedAccount(
  accounts: readonly AccountSummary[],
  activeAccountId: string | null,
): AccountSummary | null {
  const candidates = accounts.filter(
    (account) => !account.isActive && account.id !== activeAccountId,
  );
  if (candidates.length === 0) return null;
  return [...candidates].sort((left, right) => {
    const quotaDiff = averageRemainingQuota(right) - averageRemainingQuota(left);
    if (Math.abs(quotaDiff) > 0.01) return quotaDiff;
    return (
      (right.updatedAt || right.createdAt) - (left.updatedAt || left.createdAt)
    );
  })[0];
}
