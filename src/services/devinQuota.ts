import { isRecord } from './managementApi';

export const DEVIN_QUOTA_URL = 'https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus';
export const DEVIN_QUOTA_HEADERS = {
  'Content-Type': 'application/json',
  'Connect-Protocol-Version': '1',
};
export const DEVIN_QUOTA_DATA = JSON.stringify({
  metadata: {
    ideName: 'chisel',
    ideVersion: '3000.10.21',
    apiKey: '$TOKEN$',
    locale: 'en',
    os: 'darwin',
    extensionVersion: '3000.10.21',
    clientName: 'chisel',
  },
});

const percentValue = (value: unknown): number | null => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const percent = Number(value);
  return Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null;
};

const unixInstant = (value: unknown): number | undefined => {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return undefined;
  const seconds = Number(value);
  const ms = seconds * 1000;
  return Number.isSafeInteger(seconds) && ms > 0 && Number.isFinite(new Date(ms).getTime())
    ? ms : undefined;
};

export const readDevinQuota = (payload: unknown) => {
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      payload = null;
    }
  }
  const userStatus = isRecord(payload) && isRecord(payload.userStatus) ? payload.userStatus : {};
  const planStatus = isRecord(userStatus.planStatus) ? userStatus.planStatus : {};
  const planInfo = isRecord(planStatus.planInfo) ? planStatus.planInfo : {};
  const windows = (['daily', 'weekly'] as const).map((id) => ({
    id,
    remainingPercent: percentValue(planStatus[id + 'QuotaRemainingPercent']),
    resetAtMs: unixInstant(planStatus[id + 'QuotaResetAtUnix']),
  }));
  const observed = windows.some((window) => window.remainingPercent !== null || window.resetAtMs !== undefined);
  const planEnd = planStatus.planEnd;
  return {
    windows: observed ? windows : [],
    plan: typeof planInfo.planName === 'string' ? planInfo.planName.trim() || undefined : undefined,
    subscriptionActiveUntil: typeof planEnd === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(planEnd)
      && Number.isFinite(Date.parse(planEnd)) ? planEnd : undefined,
  };
};
