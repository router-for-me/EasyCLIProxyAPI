import { useCallback } from 'react';
import { useI18n } from '../i18n';
import { resetCodexQuotaWithConfirmation } from '../services/quotaActions';
import { fileName, formatQuotaTimestamp, type AuthFile, type QuotaState } from '../services/quotaService';
import type { ConfirmationOptions } from './ConfirmationDialog';

export function useCodexQuotaReset(
  askConfirmation: (options: ConfirmationOptions) => Promise<boolean>,
  setError: (message: string) => void,
) {
  const { locale, t } = useI18n();
  return useCallback(async (file: AuthFile, quota: QuotaState) => {
    setError('');
    try {
      await resetCodexQuotaWithConfirmation(file, () => askConfirmation({
        title: t('quota.reset'),
        message: t('quota.confirm.title', { name: fileName(file) }),
        confirmText: t('quota.confirm.button'),
        details: [
          { label: t('quota.resetCredits'), value: String(quota.resetCredits ?? '—') },
          { label: t('quota.earliestExpiry'), value: formatQuotaTimestamp(quota.resetCreditsEarliestExpiry, locale) },
        ],
        warning: t('quota.confirm.warning'),
      }));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    }
  }, [askConfirmation, locale, setError, t]);
}
