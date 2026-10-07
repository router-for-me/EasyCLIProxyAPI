import { useI18n } from '../i18n';
import { failureKind } from '../services/connectionPresentation';
import type { DashboardRequest } from '../services/dashboardActivity';
import { navigateHelp } from '../services/uxNavigation';

export function RequestFailureAction({ record }: { record: Pick<DashboardRequest, 'failure_status' | 'failure_body'> }) {
  const { t } = useI18n();
  const kind = failureKind(record);
  return <button type="button" className="secondary-button compact-button" onClick={() => navigateHelp(kind === 'auth' ? 'oauth' : kind === 'limit' ? 'home' : 'agents')}>
    {t(kind === 'auth' ? 'ux.reviewAccounts' : kind === 'limit' ? 'ux.checkQuota' : 'ux.reviewConnection')}
  </button>;
}
