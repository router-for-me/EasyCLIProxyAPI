import { isRecord, readString } from './managementApi';

export const decodeQuotaToken = (value: unknown): Record<string, unknown> | null => {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    if (isRecord(parsed)) return parsed;
  } catch {  }
  const segment = value.trim().split('.')[1];
  if (!segment) return null;
  try {
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/')
      .padEnd(Math.ceil(segment.length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const quotaAuthRecords = (file: Record<string, unknown>) =>
  [file, file.metadata, file.attributes].filter(isRecord);

const tokenClaims = (record: Record<string, unknown>, keys: string[]) =>
  keys.flatMap((key) => {
    const payload = decodeQuotaToken(record[key]);
    if (!payload) return [];
    return [payload, payload['https://api.openai.com/auth']].filter(isRecord);
  });

export const codexMetadataFor = (file: Record<string, unknown>) => {
  const authRecords = quotaAuthRecords(file);
  const records = authRecords.flatMap((record) => [
    record,
    ...tokenClaims(record, ['id_token', 'idToken', 'access_token', 'accessToken']),
  ]);
  const first = (...keys: string[]) => records.map((record) => readString(record, ...keys)).find(Boolean);
  const explicitlyClearedExpiry = authRecords.some((record) =>
    (Object.prototype.hasOwnProperty.call(record, 'subscription_active_until') && record.subscription_active_until === null)
    || (Object.prototype.hasOwnProperty.call(record, 'subscriptionActiveUntil') && record.subscriptionActiveUntil === null),
  );
  const expiry = explicitlyClearedExpiry
    ? ''
    : first(
      'subscription_active_until', 'subscriptionActiveUntil',
      'chatgpt_subscription_active_until', 'chatgptSubscriptionActiveUntil',
    ) || records.map((record) => readString(record.subscription, 'active_until', 'activeUntil')).find(Boolean);
  return {
    accountId: first('chatgpt_account_id', 'chatgptAccountId', 'account_id', 'accountId') || '',
    plan: first('chatgpt_plan_type', 'chatgptPlanType', 'plan_type', 'planType')?.toLowerCase(),
    subscriptionActiveUntil: expiry && expiry !== '0' ? expiry : undefined,
  };
};

const organizationIdFromRecord = (record: Record<string, unknown>): string => {
  const direct = readString(
    record,
    'organization_id', 'organizationId',
    'chatgpt_organization_id', 'chatgptOrganizationId',
    'chatgpt_org_id', 'chatgptOrgId',
    'org_id', 'orgId',
    'poid', 'POID',
  );
  if (direct) return direct;
  if (Array.isArray(record.organizations)) {
    const orgs = record.organizations.filter(isRecord);
    const defaultOrg = orgs.find((org) => org.is_default === true) ?? orgs[0];
    if (defaultOrg) return readString(defaultOrg, 'id');
  }
  return '';
};

export const codexOrganizationIdFor = (file: Record<string, unknown>): string => {
  const authRecords = quotaAuthRecords(file);
  // Prefer access_token claims over id_token claims, matching Codex workspace authority.
  const ordered = [
    ...authRecords.flatMap((record) => tokenClaims(record, ['access_token', 'accessToken'])),
    ...authRecords,
    ...authRecords.flatMap((record) => tokenClaims(record, ['id_token', 'idToken'])),
  ];
  return ordered.map(organizationIdFromRecord).find(Boolean) || '';
};

export const antigravityProjectFor = (file: Record<string, unknown>): string => {
  const records = [...quotaAuthRecords(file), file.installed, file.web].filter(isRecord);
  return records.map((record) => readString(record, 'project_id', 'projectId', 'gemini_virtual_project'))
    .find(Boolean) || '';
};

export const isPaidXaiFile = (file: Record<string, unknown>): boolean => {
  const records: Record<string, unknown>[] = [];
  const visited = new Set<Record<string, unknown>>();
  const visit = (value: unknown, depth: number) => {
    if (!isRecord(value) || visited.has(value) || depth > 2) return;
    visited.add(value);
    records.push(value);
    for (const key of ['metadata', 'attributes', 'oauth', 'raw', 'credential', 'auth']) {
      visit(value[key], depth + 1);
    }
  };
  visit(file, 0);
  const usingApi = records.some((record) =>
    ['true', '1', 'yes', 'y', 'on'].includes(String(record.using_api ?? record.usingApi).trim().toLowerCase()));
  if (usingApi && records.some((record) => readString(record, 'prefix').toLowerCase() === 'paid')) return true;
  return records.some((record) => ['access_token', 'accessToken', 'id_token', 'idToken', 'token'].some((key) => {
    const payload = decodeQuotaToken(record[key]);
    if (!payload) return false;
    return Object.entries(payload).some(([claim, tier]) =>
      /(?:^|[/:])tier$/i.test(claim) && (typeof tier === 'number' || typeof tier === 'string') && Number(tier) >= 1);
  }));
};
