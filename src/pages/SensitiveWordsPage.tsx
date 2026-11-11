import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Plus, RefreshCw, ShieldAlert } from 'lucide-react';
import { Dialog } from '../components/Dialog';
import { SettingsHelp } from '../components/SettingsHelp';
import { useConfirmation } from '../components/ConfirmationDialog';
import { useI18n } from '../i18n';
import { sensitiveWordsMessages } from '../i18n/sensitiveWords';
import { templateText } from '../i18n/templateConfig';
import {
  getCoreSensitiveWordsSettings,
  saveCoreSensitiveWordsSettings,
  type SensitiveWordsSettings,
} from '../services/coreSettings';
import {
  fetchLatestSensitiveWordRules,
  addCloudRules,
  validateWordEntries,
  duplicateWordGroups,
  mergeDuplicateWords,
  type WordEntry,
  type SensitiveRule,
} from '../services/sensitiveWords';
const providers = ['antigravity', 'devin'] as const;
const toEntries = (settings: SensitiveWordsSettings): WordEntry[] =>
  providers.flatMap((provider) => [
    ...settings[`${provider}SensitiveWords`].map((target) => ({
      id: crypto.randomUUID(),
      provider,
      kind: 'obfuscate' as const,
      target,
      replacement: '',
    })),
    ...Object.entries(settings[`${provider}SensitiveWordsReplace`]).map(([target, replacement]) => ({
      id: crypto.randomUUID(),
      provider,
      kind: 'replace' as const,
      target,
      replacement,
    })),
  ]).filter((row) => row.target.trim());
const toSettings = (rows: WordEntry[]): SensitiveWordsSettings => {
  const settings: SensitiveWordsSettings = {
    antigravitySensitiveWords: [],
    devinSensitiveWords: [],
    antigravitySensitiveWordsReplace: {},
    devinSensitiveWordsReplace: {},
  };
  for (const row of rows) {
    if (!row.target.trim()) continue;
    if (row.kind === 'replace')
      Object.defineProperty(settings[`${row.provider}SensitiveWordsReplace`], row.target.trim(), {
        value: row.replacement,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    else settings[`${row.provider}SensitiveWords`].push(row.target.trim());
  }
  return settings;
};
export function SensitiveWordsPage({ active = true, onDirtyChange }: { active?: boolean; onDirtyChange?: (dirty: boolean) => void } = {}) {
  const { t, locale } = useI18n();
  const st = (key: keyof typeof sensitiveWordsMessages) => templateText(sensitiveWordsMessages[key], locale);
  const { askConfirmation, confirmationDialog } = useConfirmation();
  const [saved, setSaved] = useState<SensitiveWordsSettings | null>(null);
  const [rows, setRows] = useState<WordEntry[]>([]);
  const [busy, setBusy] = useState<'load' | 'save' | 'cloud' | null>('load');
  const [error, setError] = useState('');
  const [savedNotice, setSavedNotice] = useState(false);
  const [undo, setUndo] = useState<WordEntry[] | null>(null);
  const session = useRef(0);
  const invalid = validateWordEntries(rows);
  const duplicates = duplicateWordGroups(rows);
  const duplicateIds = new Set(duplicates.flatMap((group) => group.entries.map((entry) => entry.id)));
  const settings = toSettings(rows);
  const dirty = saved !== null && JSON.stringify(settings) !== JSON.stringify(saved);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!active) setRows((current) => current.filter((row) => row.target.trim()));
  }, [active]);
  const load = useCallback(async () => {
    const token = ++session.current;
    setBusy('load');
    setError('');
    setSavedNotice(false);
    try {
      const result = await getCoreSensitiveWordsSettings();
      if (token === session.current) {
        const entries = toEntries(result);
        setSaved(toSettings(entries));
        setRows(entries);
        setUndo(null);
      }
    } catch (cause) {
      if (token === session.current) setError(String(cause));
    } finally {
      if (token === session.current) setBusy(null);
    }
  }, []);
  useEffect(() => {
    void load();
    return () => {
      ++session.current;
    };
  }, [load]);
  const changed = () => {
    setSavedNotice(false);
    setError('');
  };
  const changeRule = (row: WordEntry, field: 'target' | 'replacement', value: string) => {
    setRows((current) =>
      current.map((entry) => (entry.id === row.id ? { ...entry, [field]: value } : entry)),
    );
    changed();
  };
  const add = (provider: SensitiveRule['provider'], kind: SensitiveRule['kind']) => {
    const rule = { id: crypto.randomUUID(), provider, kind, target: '', replacement: '' };
    setRows((current) => [...current, rule]);
    changed();
    requestAnimationFrame(() =>
      Array.from(document.querySelectorAll<HTMLElement>('.sw-inline-row'))
        .find((el) => el.dataset.ruleId === rule.id)
        ?.querySelector<HTMLTextAreaElement>('textarea')
        ?.focus(),
    );
  };
  const remove = (row: WordEntry) => {
    if (row.target.trim()) setUndo(rows.filter((entry) => entry.target.trim()));
    setRows((current) => current.filter((entry) => entry.id !== row.id));
    changed();
  };
  const save = async () => {
    if (!dirty || invalid || busy !== null) return;
    const token = session.current;
    setBusy('save');
    setError('');
    try {
      const result = await saveCoreSensitiveWordsSettings({ settings });
      if (token === session.current) {
        setSaved(result);
        setRows(toEntries(result));
        setUndo(null);
        setSavedNotice(true);
      }
    } catch (cause) {
      if (token === session.current) setError(String(cause));
    } finally {
      if (token === session.current) setBusy(null);
    }
  };
  const addLatest = async () => {
    if (busy !== null) return;
    const token = session.current;
    setBusy('cloud');
    setError('');
    setSavedNotice(false);
    try {
      const catalog = await fetchLatestSensitiveWordRules();
      if (token !== session.current) return;
      const merged = addCloudRules(rows, catalog.rules);
      setRows(merged);
      const validation = validateWordEntries(merged);
      if (validation) {
        setError(st('cloudNotSaved'));
        return;
      }
      const result = await saveCoreSensitiveWordsSettings({ settings: toSettings(merged) });
      if (token !== session.current) return;
      setSaved(result);
      setRows(toEntries(result));
      setUndo(null);
      setSavedNotice(true);
    } catch (cause) {
      if (token === session.current) setError(String(cause));
    } finally {
      if (token === session.current) setBusy(null);
    }
  };
  const discard = async () => {
    if (
      dirty &&
      !(await askConfirmation({
        title: t('config.sensitiveWords.discardTitle'),
        message: t('config.sensitiveWords.discardMessage'),
        confirmText: t('common.refresh'),
      }))
    )
      return;
    await load();
  };
  return (
    <section className="panel surface-bare config-sensitive-words-panel sw-library">
      {confirmationDialog}
      {error ? (
        <Dialog alert size="sm" title={st('title')} onClose={() => setError('')}>
          <p>{error}</p>
        </Dialog>
      ) : null}
      <div className="config-panel-heading">
        <div className="config-heading-title">
          <ShieldAlert size={18} aria-hidden="true" />
          <h2>{st('title')}</h2>
        </div>
        <div className="config-heading-actions">
          {undo ? (
            <button
              className="secondary-button compact-button ghost"
              disabled={busy !== null}
              onClick={() => {
                setRows(undo.filter((row) => row.target.trim()));
                setUndo(null);
                changed();
              }}
            >
              {st('undo')}
            </button>
          ) : null}
          {dirty ? (
            <span className="state-pill">{t('config.network.unsaved')}</span>
          ) : savedNotice ? (
            <span className="state-pill success">{t('config.network.saved')}</span>
          ) : null}
          <button
            className="secondary-button compact-button sw-cloud-add"
            disabled={busy !== null || saved === null}
            onClick={() => void addLatest()}
          >
            <Download size={15} />
            {busy === 'cloud' ? st('syncing') : st('addLatest')}
          </button>
          <button
            className="secondary-button compact-button"
            disabled={busy !== null}
            onClick={() => void discard()}
          >
            <RefreshCw size={15} />
            {t('common.refresh')}
          </button>
          <button
            className="primary-button compact-button sw-save"
            disabled={busy !== null || !dirty || invalid !== null}
            onClick={() => void save()}
          >
            {busy === 'save' ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
      {saved !== null ? (
        <>
          {providers.map((provider) => (
            <details className="sw-provider-section" key={provider} open>
              <summary>
                {provider === 'antigravity' ? 'Antigravity' : 'Devin'}
                <span className="sw-section-count">
                  {rows.filter((row) => row.provider === provider && row.target.trim()).length}
                </span>
              </summary>
              <div className="sw-provider-body">
                {(['replace', 'obfuscate'] as const).map((kind) => {
                  const group = rows.filter((row) => row.provider === provider && row.kind === kind);
                  const groupDuplicates = duplicates.filter(
                    (item) => item.entries[0].provider === provider && item.entries[0].kind === kind,
                  );
                  const duplicateHintId = `sw-duplicates-${provider}-${kind}`;
                  const label = st(
                    kind === 'replace' ? 'replace' : provider === 'devin' ? 'systemWords' : 'obfuscate',
                  );
                  return (
                    <section className="sw-field-group" key={kind} aria-label={`${provider} ${label}`}>
                      <div className="sw-field-heading">
                        <h3>{label}</h3>
                        <SettingsHelp
                          label={`${provider === 'antigravity' ? 'Antigravity' : 'Devin'} ${label}`}
                        >
                          {st(
                            kind === 'replace'
                              ? 'replacementHelp'
                              : provider === 'devin'
                                ? 'systemWordsHelp'
                                : 'obfuscationHelp',
                          )}
                        </SettingsHelp>
                      </div>
                      {groupDuplicates.length ? (
                        <div id={duplicateHintId} className="sw-duplicate-notices" aria-live="polite">
                          {groupDuplicates.map((duplicate) => (
                            <div className="sw-duplicate-notice" key={duplicate.entries[0].id}>
                              <span>
                                <strong>
                                  {st('duplicateWord')}：{duplicate.entries[0].target.trim()}
                                </strong>
                                <span className="sw-duplicate-detail">
                                  ×{duplicate.entries.length} · {st('caseInsensitive')}
                                  {!duplicate.canMerge ? ` · ${st('differentReplacements')}` : ''}
                                </span>
                              </span>
                              {duplicate.canMerge ? (
                                <button
                                  className="secondary-button compact-button"
                                  disabled={busy !== null}
                                  onClick={() => {
                                    setUndo(rows);
                                    setRows((current) => mergeDuplicateWords(current, duplicate));
                                    changed();
                                  }}
                                >
                                  {st('mergeDuplicates')}
                                </button>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {group.length ? (
                        <div className="sw-inline-list">
                          {kind === 'replace' ? (
                            <div className="sw-column-labels">
                              <span>{t('config.sensitiveWords.target')}</span>
                              <span>
                                {t('config.sensitiveWords.replacement')}
                                <span className="sw-field-hint">{st('emptyDeletes')}</span>
                              </span>
                            </div>
                          ) : null}
                          {group.map((row) => (
                            <div
                              className={`sw-inline-row ${kind === 'replace' ? 'sw-inline-pair' : ''}`}
                              key={row.id}
                              data-rule-id={row.id}
                              onBlur={(event) => {
                                if (!row.target.trim() && !event.currentTarget.contains(event.relatedTarget)) {
                                  setRows((current) => current.filter((entry) => entry.id !== row.id));
                                }
                              }}
                            >
                              <textarea
                                className="config-network-input"
                                rows={1}
                                aria-label={`${provider} ${label} ${t('config.sensitiveWords.target')}`}
                                disabled={busy !== null}
                                aria-invalid={duplicateIds.has(row.id) || undefined}
                                aria-describedby={duplicateIds.has(row.id) ? duplicateHintId : undefined}
                                value={row.target}
                                onChange={(event) => changeRule(row, 'target', event.target.value)}
                              />
                              {kind === 'replace' ? (
                                <textarea
                                  className="config-network-input"
                                  rows={1}
                                  aria-label={`${provider} ${label} ${t('config.sensitiveWords.replacement')}`}
                                  placeholder={st('emptyDeletes')}
                                  disabled={busy !== null}
                                  value={row.replacement}
                                  onChange={(event) => changeRule(row, 'replacement', event.target.value)}
                                />
                              ) : null}
                              <button
                                className="secondary-button compact-button ghost"
                                disabled={busy !== null}
                                aria-label={`${t('common.delete')} ${row.target}`}
                                onClick={() => remove(row)}
                              >
                                {t('common.delete')}
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : null}
                      <button
                        className="secondary-button compact-button sw-add"
                        disabled={busy !== null}
                        onClick={() => add(provider, kind)}
                      >
                        <Plus size={14} />
                        {t('common.add')}
                      </button>
                    </section>
                  );
                })}
              </div>
            </details>
          ))}
        </>
      ) : null}
    </section>
  );
}
