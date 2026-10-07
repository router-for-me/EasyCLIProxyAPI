import { requestClient, type DashboardRequest } from './dashboardActivity';

export type ConnectionStatus = {
  id: string; installed: boolean; supportedPlatform: boolean; configValid: boolean;
  connectionState: string; codexNativeOauth: boolean; error: string | null;
};
export function connectionEvidence(status: ConnectionStatus | null, items: DashboardRequest[], now: number) {
  const client = status?.id === 'claude-desktop' ? 'Claude Desktop'
    : status?.id === 'claude-code' ? 'Claude Code CLI' : status?.id === 'codex' ? 'Codex' : null;
  const latest = client ? items.filter(item => requestClient(item) === client && !item.canceled
    && Number.isFinite(Date.parse(item.timestamp)) && Date.parse(item.timestamp) <= now)
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0] : undefined;
  const recent = latest && now - Date.parse(latest.timestamp) <= 5 * 60_000;
  const stage = !status ? 'checking' : !status.supportedPlatform ? 'unsupported'
    : !status.installed ? 'notDetected' : status.error || !status.configValid || status.connectionState === 'invalid' ? 'attention'
    : status.codexNativeOauth ? 'native' : status.connectionState === 'needs-update' ? 'attention'
    : status.connectionState !== 'configured' ? 'detected'
    : recent && !latest.failed ? 'verified' : 'configured';
  return { stage, latest } as const;
}
