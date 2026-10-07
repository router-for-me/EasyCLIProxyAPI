type RecordValue = Record<string, unknown>;
const future = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

/** Fictional accounts exercise pagination, long labels and independently failing quotas. */
export function createQuotaMockFiles(): RecordValue[] {
  const seeds: Array<[string, string, RecordValue]> = [
    ['antigravity', 'team-with-a-long-account-name', {}],
    ['kimi', 'personal', {}],
    ['xai', 'subscription', { user_id: 'mock-xai-user' }],
    ['devin', 'team', {}],
    ['codex', 'disabled', { disabled: true }],
    ['codex', 'exhausted', { cooldowns: [{ scope: 'model', model_key: 'gpt-5.2-codex', reason: 'quota', http_status: 429, retry_at: future(1), remaining_seconds: 3600 }] }],
    ['claude', 'expired', { status: 'error', status_message: 'Mock OAuth token has expired; sign in again.' }],
    ['xai', 'paid-api', { using_api: true, prefix: 'paid' }],
    ['antigravity', 'empty-quota', {}],
    ['codex', 'unknown-quota', {}],
    ['codex', 'idle', {}],
  ];
  return seeds.map(([provider, label, extra], index) => ({
    name: `${provider}-${label}.json`, provider, type: provider, source: 'file',
    auth_index: `mock-${provider}-${label}`, email: `${label}@example.test`,
    account_id: `mock-account-${index}`, project_id: 'mock-project',
    plan_type: 'pro', subscription_active_until: future(24 * 30),
    disabled: false, status: 'active', priority: index % 3,
    size: 1500 + index * 100, modtime: Date.now() - index * 60_000,
    note: 'Fictional browser preview account. Changes stay in memory until reload.',
    success: label === 'idle' ? 0 : 250 + index * 97, failed: label === 'idle' ? 0 : index,
    recent_requests: label === 'idle' ? [] : Array.from({ length: 20 }, (_, bucket) => ({
      time: new Date(Date.now() - (19 - bucket) * 600_000).toISOString(),
      success: bucket % 4 + 1, failed: bucket % 7 === 0 ? 1 : 0,
    })),
    ...extra,
  }));
}

/** Each runtime owns its own balances; refreshing or mutating one account cannot affect another. */
export function createQuotaMock() {
  const spent = new Map<string, number>();
  const redeemed = new Set<string>();
  return (body: RecordValue) => {
    const url = new URL(String(body.url));
    const path = url.pathname.toLowerCase();
    const auth = String(body.authIndex ?? '');
    const used = spent.get(auth) ?? 0;
    const remaining = Math.max(0, 2 - used);
    const success = (payload: unknown) => ({ status_code: 200, header: { Date: new Date().toUTCString() }, body: payload });
    if (auth.endsWith('-expired')) return { status_code: 401, body: { error: { message: 'Mock OAuth token expired' } } };
    const consume = () => {
      const data = JSON.parse(String(body.data || '{}')) as RecordValue;
      const id = String(data.redeem_request_id ?? data.request_id ?? '');
      const key = `${auth}:${id}`;
      if (id && redeemed.has(key)) return true;
      if (!remaining) return false;
      spent.set(auth, used + 1);
      if (id) redeemed.add(key);
      return true;
    };
    if (path.endsWith('/rate-limit-reset-credits/consume')) {
      if (body.method !== 'POST') throw new Error('Browser Mock: credit consumption requires POST');
      return consume() ? success({ status: 'ok' }) : { status_code: 409, body: { error: 'No reset credits remaining' } };
    }
    if (path.endsWith('/rate-limit-reset-credits')) return success({
      available_count: remaining, applicable_available_count: remaining,
      credits: Array.from({ length: remaining }, (_, index) => ({ id: `mock-credit-${index + used}`, reset_type: 'codex_rate_limits', status: 'available', expires_at: future(24 * (index + 1)) })),
    });
    if (path.endsWith('/wham/usage')) return success({
      plan_type: 'pro', credits: { balance: '12.50', unlimited: false },
      rate_limit_reset_credits: { available_count: remaining },
      rate_limit: {
        primary_window: { used_percent: auth.endsWith('-unknown-quota') ? null : used ? 0 : auth.endsWith('-exhausted') ? 100 : 28, reset_after_seconds: 7200, limit_window_seconds: 18000 },
        secondary_window: { used_percent: used ? 0 : 42, reset_after_seconds: 345600, limit_window_seconds: 604800 },
      },
    });
    if (path.endsWith('/api/oauth/profile')) return success({ account: { has_claude_pro: true }, organization: { uuid: '00000000-0000-4000-8000-000000000001' } });
    if (path.endsWith('/reset_rate_limits')) {
      if (body.method !== 'POST') throw new Error('Browser Mock: quota reset requires POST');
      return success({ result: consume() ? 'reset' : 'already_used' });
    }
    if (path.endsWith('/api/oauth/usage')) return success({
      five_hour: { utilization: used ? 0 : 24, resets_at: future(3) },
      seven_day: { utilization: used ? 0 : 41, resets_at: future(72) },
      cedar_ember: { eligible: true, at_limit: false, next_grant_id: remaining ? 'mock-grant' : null,
        grants: [{ id: 'mock-grant', label: 'Preview quota resets', resets_total: 2, resets_left: remaining, ends_at: future(72), clears: ['five_hour', 'seven_day'], usable_now: remaining > 0, use_requires_limit: false }] },
    });
    if (path.endsWith(':loadcodeassist')) return success({ currentTier: { id: 'g1-pro-tier', name: 'Pro' } });
    if (path.endsWith(':retrieveuserquotasummary')) return success({ groups: auth.endsWith('-empty-quota') ? [] : ['Gemini Models', 'Claude Models'].map((displayName, index) => ({
      displayName, description: 'Models within this group share quota. The limit fully resets at the time shown above.',
      buckets: ['Five Hour Limit Remaining', 'Weekly Limit Remaining'].map((window, bucket) => ({
        window, remainingFraction: index ? 0.06 : bucket ? 0.84 : 0.75,
        resetTime: future(bucket ? 72 : 3),
      })),
    })) });
    if (url.hostname === 'api.kimi.com' && path.endsWith('/usages')) return success({
      usage: { used: 64, limit: 100 },
      limits: [{ window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' }, detail: { limit: 100, remaining: 80, reset_in: 3600 } }],
    });
    if (path.endsWith('/getuserstatus')) return success({ userStatus: { planStatus: {
      planInfo: { planName: 'Devin Pro' }, dailyQuotaRemainingPercent: 63, weeklyQuotaRemainingPercent: 42,
      dailyQuotaResetAtUnix: Math.floor(Date.now() / 1000) + 3600, weeklyQuotaResetAtUnix: Math.floor(Date.now() / 1000) + 259200,
      planEnd: future(24 * 30),
    } } });
    if (path.endsWith('/billing')) return success({ currentPeriod: { type: 'weekly', start: future(-120), end: future(48) }, creditUsagePercent: 36, productUsage: [{ product: 'Grok Code', usagePercent: 31 }] });
    return undefined;
  };
}
