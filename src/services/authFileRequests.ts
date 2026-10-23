export const AUTH_REQUEST_BUCKET_COUNT = 20;

export type AuthRequestBucket = {
  time: string;
  success: number;
  failure: number;
  rate: number | null;
};

export type AuthFileRequestStats = {
  success: number | null;
  failure: number | null;
  recentAvailable: boolean;
  buckets: AuthRequestBucket[];
  recentSuccess: number;
  recentFailure: number;
  recentRate: number | null;
};

function requestCount(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

export function authFileRequestStats(file: Record<string, unknown>): AuthFileRequestStats {
  const recent = file.recent_requests ?? file.recentRequests;
  const recentAvailable = Array.isArray(recent);
  const buckets: AuthRequestBucket[] = (recentAvailable ? recent : [])
    .slice(-AUTH_REQUEST_BUCKET_COUNT)
    .map((value: unknown) => {
      const bucket = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : {};
      const success = requestCount(bucket.success) ?? 0;
      const failure = requestCount(bucket.failed) ?? 0;
      return {
        time: typeof bucket.time === 'string' ? bucket.time.trim() : '',
        success,
        failure,
        rate: success + failure > 0 ? success / (success + failure) : null,
      };
    });
  while (buckets.length < AUTH_REQUEST_BUCKET_COUNT) {
    buckets.unshift({ time: '', success: 0, failure: 0, rate: null });
  }
  const recentSuccess = buckets.reduce((total, bucket) => total + bucket.success, 0);
  const recentFailure = buckets.reduce((total, bucket) => total + bucket.failure, 0);
  return {
    success: requestCount(file.success ?? file.successCount),
    failure: requestCount(file.failed ?? file.failureCount),
    recentAvailable,
    buckets,
    recentSuccess,
    recentFailure,
    recentRate: recentSuccess + recentFailure > 0
      ? recentSuccess / (recentSuccess + recentFailure) : null,
  };
}

export function requestRateColor(rate: number): string {
  const normalized = Number.isFinite(rate) ? Math.max(0, Math.min(1, rate)) : 0;
  const start = normalized < 0.5 ? 'low' : 'medium';
  const end = normalized < 0.5 ? 'medium' : 'high';
  const weight = (normalized < 0.5 ? normalized * 2 : (normalized - 0.5) * 2) * 100;
  return `color-mix(in srgb, var(--theme-meter-${start}) ${100 - weight}%, var(--theme-meter-${end}) ${weight}%)`;
}
