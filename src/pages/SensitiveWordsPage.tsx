import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, RefreshCw, ShieldAlert } from 'lucide-react';
import { useI18n } from '../i18n';

type SensitiveWordsSettings = {
  antigravitySensitiveWords: string[];
  devinSensitiveWords: string[];
};

const wordsFromText = (text: string): string[] => text.split(/\r?\n/).map((word) => word.trim()).filter(Boolean);

export function SensitiveWordsPage() {
  const { t } = useI18n();
  const [saved, setSaved] = useState<SensitiveWordsSettings | null>(null);
  const [antigravityDraft, setAntigravityDraft] = useState('');
  const [devinDraft, setDevinDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedNotice, setSavedNotice] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await invoke<SensitiveWordsSettings>('get_core_sensitive_words_settings');
      setSaved(result);
      setAntigravityDraft(result.antigravitySensitiveWords.join('\n'));
      setDevinDraft(result.devinSensitiveWords.join('\n'));
      setSavedNotice(false);
    } catch (cause) {
      setSaved(null);
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const antigravitySensitiveWords = wordsFromText(antigravityDraft);
  const devinSensitiveWords = wordsFromText(devinDraft);
  const dirty = saved !== null && (
    JSON.stringify(antigravitySensitiveWords) !== JSON.stringify(saved.antigravitySensitiveWords)
    || JSON.stringify(devinSensitiveWords) !== JSON.stringify(saved.devinSensitiveWords)
  );

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setError('');
    try {
      const result = await invoke<SensitiveWordsSettings>('save_core_sensitive_words_settings', {
        settings: { antigravitySensitiveWords, devinSensitiveWords },
      });
      setSaved(result);
      setAntigravityDraft(result.antigravitySensitiveWords.join('\n'));
      setDevinDraft(result.devinSensitiveWords.join('\n'));
      setSavedNotice(true);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="panel config-sensitive-words-panel">
      <div className="config-panel-heading">
        <div className="config-heading-title">
          <ShieldAlert size={18} aria-hidden="true" />
          <h2>{t('config.sensitiveWords.title')}</h2>
        </div>
        <div className="config-heading-actions">
          {dirty ? <span className="state-pill">{t('config.network.unsaved')}</span>
            : savedNotice ? <span className="state-pill success">{t('config.network.saved')}</span> : null}
          <button type="button" className="icon-button quiet" title={t('common.refresh')} aria-label={t('common.refresh')}
            disabled={loading || saving} onClick={() => void load()}>
            <RefreshCw size={16} aria-hidden="true" />
          </button>
          <button type="button" className="primary-button compact-button" disabled={loading || saving || !dirty}
            onClick={() => void save()}>
            <Check size={16} aria-hidden="true" />
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
      <p className="config-sensitive-words-intro">{t('config.sensitiveWords.intro')}</p>
      {error ? <div className="config-form-message error" role="alert">{error}</div> : null}
      {loading ? <p>{t('common.loading')}</p> : saved === null ? (
        <button type="button" className="secondary-button compact-button" onClick={() => void load()}>{t('common.retry')}</button>
      ) : (
        <div className="config-sensitive-words-grid">
          <div className="config-sensitive-words-card">
            <label htmlFor="config-antigravity-sensitive-words">{t('config.sensitiveWords.antigravity')}</label>
            <p>{t('config.sensitiveWords.antigravityDescription')}</p>
            <textarea id="config-antigravity-sensitive-words" className="config-network-input config-sensitive-words-input"
              value={antigravityDraft} disabled={saving} placeholder={t('config.sensitiveWords.antigravityPlaceholder')}
              onChange={(event) => { setAntigravityDraft(event.currentTarget.value); setSavedNotice(false); }} />
            <small>{t('config.sensitiveWords.antigravityHint')}</small>
          </div>
          <div className="config-sensitive-words-card">
            <label htmlFor="config-devin-sensitive-words">{t('config.sensitiveWords.devin')}</label>
            <p>{t('config.sensitiveWords.devinDescription')}</p>
            <textarea id="config-devin-sensitive-words" className="config-network-input config-sensitive-words-input"
              value={devinDraft} disabled={saving} placeholder={t('config.sensitiveWords.devinPlaceholder')}
              onChange={(event) => { setDevinDraft(event.currentTarget.value); setSavedNotice(false); }} />
            <small>{t('config.sensitiveWords.devinHint')}</small>
          </div>
        </div>
      )}
      {saved ? <small className="config-sensitive-words-intro">{t('config.sensitiveWords.restartHint')}</small> : null}
    </section>
  );
}
