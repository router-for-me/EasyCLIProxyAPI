import { isOAuthCredentialFile } from './authFiles';
import { isRecord, managementApi, readString } from './managementApi';
import { codexMetadataFor } from './quotaMetadata';
import { quotaResetInstant } from './quotaTime';

export const CODEX_ACCOUNTS_CHECK_URL = 'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27';
export const CODEX_SUBSCRIPTION_URL = 'https://chatgpt.com/backend-api/subscriptions';
export const CODEX_ACCOUNTS_CHECK_PATH = '/backend-api/accounts/check/v4-2023-04-27';
export const CODEX_SUBSCRIPTION_PATH = '/backend-api/subscriptions';
export const CHATGPT_WEB_REFERER = 'https://chatgpt.com/';
export const CHATGPT_WEB_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

export const CODEX_SUBSCRIPTION_STORAGE_KEY = 'easy-cli-proxy-api.codex-subscriptions';
let storageKey = CODEX_SUBSCRIPTION_STORAGE_KEY;

export function selectCodexSubscriptionStore(endpoint: string | null) {
  storageKey = endpoint ? `${CODEX_SUBSCRIPTION_STORAGE_KEY}:${endpoint}` : CODEX_SUBSCRIPTION_STORAGE_KEY;
}

export type CodexSubscriptionSnapshot = {
  accountId?: string;
  plan?: string;
  subscriptionActiveUntil?: string;
  confirmedFree?: boolean;
};

export type StoredCodexSubscription = CodexSubscriptionSnapshot & {
  updatedAt: number;
};

type AccountCheckRecord = {
  key?: string;
  node: Record<string, unknown>;
};

export const codexSubscriptionHeaders = (targetPath: string): Record<string, string> => ({
  Authorization: 'Bearer $TOKEN$',
  Accept: 'application/json',
  Referer: CHATGPT_WEB_REFERER,
  'User-Agent': CHATGPT_WEB_USER_AGENT,
  'x-openai-target-path': targetPath,
  'x-openai-target-route': targetPath,
});

export const codexAccountsCheckUrl = (timezoneOffsetMin = new Date().getTimezoneOffset()): string => {
  const offset = Number.isFinite(timezoneOffsetMin) ? Math.trunc(timezoneOffsetMin) || 0 : 0;
  return `${CODEX_ACCOUNTS_CHECK_URL}?timezone_offset_min=${encodeURIComponent(String(offset))}`;
};

export const codexSubscriptionsUrl = (accountId: string): string =>
  `${CODEX_SUBSCRIPTION_URL}?account_id=${encodeURIComponent(accountId)}`;

const normalizeOptional = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const extractSubscriptionExpiry = (record: unknown, keys: string[]): string | undefined => {
  if (!isRecord(record)) return undefined;
  for (const key of keys) {
    const ms = quotaResetInstant(record[key]);
    if (ms !== undefined) return new Date(ms).toISOString();
  }
  return undefined;
};

const isSubscriptionActive = (value: string | undefined, nowMs = Date.now()): boolean => {
  const ms = value ? quotaResetInstant(value) : undefined;
  return ms !== undefined && ms > nowMs;
};

export const isFreeWithoutActiveSubscription = (
  snapshot: CodexSubscriptionSnapshot | null | undefined,
  nowMs = Date.now(),
): boolean => Boolean(
  snapshot
  && snapshot.plan?.toLowerCase() === 'free'
  && !isSubscriptionActive(snapshot.subscriptionActiveUntil, nowMs),
);

const collectAccountCheckRecords = (payload: unknown): AccountCheckRecord[] => {
  const records: AccountCheckRecord[] = [];
  if (isRecord(payload)) {
    const accounts = payload.accounts;
    if (Array.isArray(accounts)) {
      for (const item of accounts) {
        if (isRecord(item)) records.push({ node: item });
      }
    } else if (isRecord(accounts)) {
      for (const [key, value] of Object.entries(accounts)) {
        if (isRecord(value)) records.push({ key, node: value });
      }
    }
  }
  if (records.length === 0 && Array.isArray(payload)) {
    for (const item of payload) {
      if (isRecord(item)) records.push({ node: item });
    }
  }
  return records;
};

const accountCheckParts = (item: AccountCheckRecord) => {
  const accountRecord = isRecord(item.node.account) ? item.node.account : item.node;
  const entitlement = isRecord(item.node.entitlement) ? item.node.entitlement : null;
  return { accountRecord, entitlement };
};

const accountCheckPlanType = (item: AccountCheckRecord): string | undefined => {
  const { accountRecord, entitlement } = accountCheckParts(item);
  const plan = readString(entitlement, 'subscription_plan', 'subscriptionPlan')
    || readString(accountRecord, 'plan_type', 'planType');
  return plan ? plan.toLowerCase() : undefined;
};

const accountCheckIsDefault = (item: AccountCheckRecord): boolean =>
  accountCheckParts(item).accountRecord.is_default === true;

const accountCheckWorkspaceId = (
  item: AccountCheckRecord,
  expectedAccountId?: string,
): string | undefined => {
  const { accountRecord } = accountCheckParts(item);
  const explicit = readString(accountRecord, 'account_id', 'id', 'chatgpt_account_id', 'workspace_id');
  if (explicit) return explicit;
  // Map keys can be organization IDs as well as workspace IDs; only treat the
  // key as a workspace ID when it matches the known account ID.
  if (expectedAccountId && item.key?.trim() === expectedAccountId) return expectedAccountId;
  return undefined;
};

export const parseCodexAccountCheckSnapshot = (
  payload: unknown,
  identity: { accountId?: string; organizationId?: string } = {},
  nowMs = Date.now(),
): CodexSubscriptionSnapshot | null => {
  const records = collectAccountCheckRecords(payload);
  if (records.length === 0) return null;

  const preferredOrganizationId = normalizeOptional(identity.organizationId);
  const preferredAccountId = normalizeOptional(identity.accountId);

  const organizationMatches = (item: AccountCheckRecord) =>
    Boolean(preferredOrganizationId && item.key?.trim() === preferredOrganizationId);

  const selected = records.find(organizationMatches)
    ?? (preferredAccountId
      ? records.find((item) => accountCheckWorkspaceId(item, preferredAccountId) === preferredAccountId)
      : undefined)
    ?? records.find(accountCheckIsDefault)
    ?? records.find((item) => {
      const plan = accountCheckPlanType(item);
      return Boolean(plan && plan !== 'free');
    })
    ?? records[0];

  const { accountRecord, entitlement } = accountCheckParts(selected);
  const resolvedAccountId = accountCheckWorkspaceId(selected, preferredAccountId);

  if (preferredAccountId && resolvedAccountId !== preferredAccountId && !organizationMatches(selected)) {
    // The default record can belong to another workspace. Keep the target
    // account ID so the follow-up /subscriptions query probes the right workspace.
    return { accountId: preferredAccountId };
  }

  const subscriptionActiveUntil = extractSubscriptionExpiry(entitlement, ['expires_at', 'expiresAt'])
    ?? extractSubscriptionExpiry(accountRecord, ['expires_at', 'expiresAt']);
  const accountPlan = readString(accountRecord, 'plan_type', 'planType').toLowerCase() || undefined;
  const entitlementPlan = readString(entitlement, 'subscription_plan', 'subscriptionPlan').toLowerCase() || undefined;
  const expiredEntitlement = subscriptionActiveUntil !== undefined && !isSubscriptionActive(subscriptionActiveUntil, nowMs);
  const plan = expiredEntitlement && accountPlan === 'free'
    ? accountPlan
    : (entitlementPlan || accountPlan);

  return {
    ...(resolvedAccountId ? { accountId: resolvedAccountId } : {}),
    ...(plan ? { plan } : {}),
    ...(subscriptionActiveUntil ? { subscriptionActiveUntil } : {}),
  };
};

export const parseCodexSubscriptionSnapshot = (
  payload: unknown,
  fallbackAccountId?: string,
): CodexSubscriptionSnapshot => {
  if (!isRecord(payload)) {
    const accountId = normalizeOptional(fallbackAccountId);
    return accountId ? { accountId } : {};
  }
  const accountId = normalizeOptional(fallbackAccountId);
  const plan = readString(payload, 'subscription_plan', 'subscriptionPlan', 'plan_type', 'planType').toLowerCase() || undefined;
  const subscriptionActiveUntil = extractSubscriptionExpiry(payload, [
    'active_until', 'activeUntil', 'expires_at', 'expiresAt',
  ]);
  return {
    ...(accountId ? { accountId } : {}),
    ...(plan ? { plan } : {}),
    ...(subscriptionActiveUntil ? { subscriptionActiveUntil } : {}),
  };
};

export async function resolveCodexSubscriptionStatus(
  identity: { accountId?: string; organizationId?: string },
  fetchAccountCheck: () => Promise<unknown>,
  fetchSubscriptions: (accountId: string) => Promise<unknown>,
  nowMs = Date.now(),
): Promise<CodexSubscriptionSnapshot | undefined> {
  const preferredAccountId = normalizeOptional(identity.accountId);
  let accountCheck: CodexSubscriptionSnapshot | null = null;
  try {
    accountCheck = parseCodexAccountCheckSnapshot(await fetchAccountCheck(), identity, nowMs);
  } catch {
    accountCheck = null;
  }

  // accounts/check can confirm a downgrade to Free when /subscriptions no
  // longer accepts the token or omits active_until.
  if (isFreeWithoutActiveSubscription(accountCheck, nowMs)) {
    return {
      ...(accountCheck?.accountId ? { accountId: accountCheck.accountId } : {}),
      plan: 'free',
      confirmedFree: true,
    };
  }

  const hasActiveEntitlement = isSubscriptionActive(accountCheck?.subscriptionActiveUntil, nowMs);
  const effectiveAccountId = accountCheck?.accountId || preferredAccountId;

  if (effectiveAccountId) {
    try {
      const subscriptions = parseCodexSubscriptionSnapshot(
        await fetchSubscriptions(effectiveAccountId),
        effectiveAccountId,
      );
      const subscriptionActiveUntil = subscriptions.subscriptionActiveUntil ?? accountCheck?.subscriptionActiveUntil;
      const plan = hasActiveEntitlement
        ? accountCheck?.plan
        : (subscriptions.plan ?? accountCheck?.plan);
      if (isFreeWithoutActiveSubscription({ plan, subscriptionActiveUntil }, nowMs)) {
        return {
          accountId: effectiveAccountId,
          plan: 'free',
          confirmedFree: true,
        };
      }
      if (subscriptionActiveUntil || plan) {
        return {
          accountId: effectiveAccountId,
          ...(plan ? { plan } : {}),
          ...(subscriptionActiveUntil ? { subscriptionActiveUntil } : {}),
          confirmedFree: false,
        };
      }
    } catch {
      if (accountCheck?.subscriptionActiveUntil) {
        return {
          accountId: effectiveAccountId,
          ...(accountCheck.plan ? { plan: accountCheck.plan } : {}),
          subscriptionActiveUntil: accountCheck.subscriptionActiveUntil,
          confirmedFree: false,
        };
      }
      return undefined;
    }
  }

  if (accountCheck?.subscriptionActiveUntil) {
    return {
      ...(accountCheck.accountId ? { accountId: accountCheck.accountId } : {}),
      ...(accountCheck.plan ? { plan: accountCheck.plan } : {}),
      subscriptionActiveUntil: accountCheck.subscriptionActiveUntil,
      confirmedFree: false,
    };
  }
  return undefined;
}

const readStoredMap = (): Map<string, StoredCodexSubscription> => {
  if (typeof localStorage === 'undefined') return new Map();
  try {
    const payload: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    if (!isRecord(payload)) return new Map();
    const entries: Array<[string, StoredCodexSubscription]> = [];
    for (const [name, raw] of Object.entries(payload)) {
      if (!isRecord(raw) || typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) continue;
      const accountId = readString(raw, 'accountId') || undefined;
      const plan = readString(raw, 'plan').toLowerCase() || undefined;
      const subscriptionActiveUntil = extractSubscriptionExpiry(raw, ['subscriptionActiveUntil']);
      const confirmedFree = raw.confirmedFree === true;
      if (!subscriptionActiveUntil && !confirmedFree && !plan) continue;
      entries.push([name, {
        ...(accountId ? { accountId } : {}),
        ...(plan ? { plan } : {}),
        ...(subscriptionActiveUntil ? { subscriptionActiveUntil } : {}),
        ...(confirmedFree ? { confirmedFree: true } : {}),
        updatedAt: raw.updatedAt,
      }]);
    }
    return new Map(entries);
  } catch {
    return new Map();
  }
};

export const saveCodexSubscription = (
  file: Record<string, unknown>,
  snapshot: StoredCodexSubscription,
): void => {
  const name = readString(file, 'name');
  if (!name || typeof localStorage === 'undefined') return;
  const accountId = normalizeOptional(snapshot.accountId) ?? normalizeOptional(codexMetadataFor(file).accountId);
  const plan = normalizeOptional(snapshot.plan)?.toLowerCase();
  const subscriptionActiveUntil = extractSubscriptionExpiry(snapshot, ['subscriptionActiveUntil']);
  const confirmedFree = snapshot.confirmedFree === true;
  if (!subscriptionActiveUntil && !confirmedFree && !plan) return;
  try {
    const stored = readStoredMap();
    stored.set(name, {
      ...(accountId ? { accountId } : {}),
      ...(plan ? { plan } : {}),
      ...(subscriptionActiveUntil ? { subscriptionActiveUntil } : {}),
      ...(confirmedFree ? { confirmedFree: true } : {}),
      updatedAt: snapshot.updatedAt,
    });
    localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(stored)));
  } catch {
    /* Ignore localStorage quota or sandbox errors. */
  }
};

export const resolveCodexMetadata = (file: Record<string, unknown>) => {
  const metadata = codexMetadataFor(file);
  const name = readString(file, 'name');
  if (!name) return metadata;
  const stored = readStoredMap().get(name);
  if (!stored) return metadata;

  if (stored.accountId && metadata.accountId && stored.accountId !== metadata.accountId) {
    return metadata;
  }

  const metadataExpiryMs = quotaResetInstant(metadata.subscriptionActiveUntil);
  if (stored.confirmedFree) {
    // If the credential file later received a brand-new token with a future
    // expiry minted after we confirmed Free, prefer the newer token metadata.
    if (metadataExpiryMs !== undefined && metadataExpiryMs > stored.updatedAt) {
      return metadata;
    }
    return {
      accountId: metadata.accountId || stored.accountId || '',
      plan: stored.plan || 'free',
      subscriptionActiveUntil: undefined,
    };
  }

  const storedExpiryMs = quotaResetInstant(stored.subscriptionActiveUntil);
  if (storedExpiryMs !== undefined && metadataExpiryMs !== undefined && metadataExpiryMs > storedExpiryMs) {
    return metadata;
  }

  return {
    accountId: metadata.accountId || stored.accountId || '',
    plan: stored.plan || metadata.plan,
    subscriptionActiveUntil: stored.subscriptionActiveUntil ?? metadata.subscriptionActiveUntil,
  };
};

export const buildCodexSubscriptionFieldPatch = (
  file: Record<string, unknown>,
  snapshot: CodexSubscriptionSnapshot,
): Record<string, unknown> | null => {
  if (!isOAuthCredentialFile(file)) return null;
  const name = readString(file, 'name');
  if (!name) return null;
  const patch: Record<string, unknown> = { name };
  let hasField = false;

  if (snapshot.confirmedFree === true) {
    patch.subscription_active_until = null;
    hasField = true;
  } else {
    const expiry = extractSubscriptionExpiry(snapshot, ['subscriptionActiveUntil']);
    if (expiry) {
      patch.subscription_active_until = expiry;
      hasField = true;
    }
  }

  const plan = normalizeOptional(snapshot.plan)?.toLowerCase();
  if (plan) {
    patch.chatgpt_plan_type = plan;
    hasField = true;
  }

  return hasField ? patch : null;
};

export const syncCodexSubscriptionToCredentialFile = async (
  file: Record<string, unknown>,
  snapshot: CodexSubscriptionSnapshot,
  api: Pick<typeof managementApi, 'patch'> = managementApi,
): Promise<boolean> => {
  const patch = buildCodexSubscriptionFieldPatch(file, snapshot);
  if (!patch) return false;
  try {
    await api.patch('/credentials/fields', patch);
    return true;
  } catch {
    return false;
  }
};
