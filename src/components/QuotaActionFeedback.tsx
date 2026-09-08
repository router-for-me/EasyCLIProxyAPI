import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { useI18n } from '../i18n';
import type { QuotaState } from '../services/quotaService';

export function QuotaActionFeedback({ quota }: { quota: QuotaState }) {
  const { t } = useI18n();
  const result = quota.actionResult;
  if (!result) return null;
  const successful = result.status === 'success';
  const message = t(successful ? 'quota.resetResult.submitted' : result.status === 'refresh-error'
      ? 'quota.resetResult.refreshFailed' : 'quota.resetResult.failed', { error: result.error ?? '' });
  return (
    <div className={successful ? 'quota-action-feedback success' : 'quota-action-feedback error'} role={successful ? 'status' : 'alert'}>
      {successful ? <CheckCircle2 size={16} aria-hidden="true" /> : <AlertCircle size={16} aria-hidden="true" />}
      <span>{message}</span>
    </div>
  );
}
