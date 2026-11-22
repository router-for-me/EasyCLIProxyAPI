import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { diffLines } from 'diff';
import { isMap, parseDocument } from 'yaml';
import { useConfirmation } from '../../components/ConfirmationDialog';
import { Dialog } from '../../components/Dialog';
import { Tabs } from '../../components/Tabs';
import { useI18n } from '../../i18n';
import { APP_NAVIGATION_REQUEST_EVENT, requestAppNavigation, type AppNavigationRequest } from '../../navigation';
import { useCoreRuntime } from '../../coreRuntime';
import { readConfigDocument, saveConfigDocument, type ConfigDocument } from '../../services/configDocument';
import { restartCoreProcess, startCoreProcess } from '../../services/coreLifecycle';
import { selectedTargetRevision } from '../../services/remoteCpa';
import { takeConfigManagementField } from '../../services/configManagementNavigation';
import { addCloudRules, fetchLatestSensitiveWordRules, type WordEntry } from '../../services/sensitiveWords';
import { sensitiveWordsMessages } from '../../i18n/sensitiveWords';
import { templateText } from '../../i18n/templateConfig';
import { ConfigSearch } from './components/ConfigSearch';
import { ConfigSourceEditor } from './components/ConfigSourceEditor';
import { SectionAdvanced } from './components/sections/SectionAdvanced';
import { SectionCommon } from './components/sections/SectionCommon';
import { SectionConnectivity } from './components/sections/SectionConnectivity';
import { SectionLogging } from './components/sections/SectionLogging';
import { SectionNetwork } from './components/sections/SectionNetwork';
import { SectionPayload } from './components/sections/SectionPayload';
import { SectionStreaming } from './components/sections/SectionStreaming';
import { COMMON_FIELD_IDS, CONFIG_TAB_IDS, FIELD_VALUE_KEYS, SECTION_VALIDATION_FIELDS, type ConfigEditorMode, type ConfigTabId } from './constants';
import { configDocumentMessages } from './configDocumentMessages';
import { KeyRemarksContext } from './keyRemarks';
import { CONFIG_FIELD_SEARCH_INDEX, configFieldDomId, type ConfigFieldSearchEntry } from './searchIndex';
import { useTranslation } from './translation';
import { useVisualConfig } from './useVisualConfig';
import { prefersReducedMotion } from './utilities';
import './configManagement.css';

const sections = {
  common: SectionCommon,
  connectivity: SectionConnectivity,
  network: SectionNetwork,
  logging: SectionLogging,
  streaming: SectionStreaming,
  advanced: SectionAdvanced,
  payload: SectionPayload,
};

const previewCopy = {
  en: { hint: 'Browser preview only. Changes do not affect a CPA instance and reset when you refresh.', validation: 'Fix the highlighted settings before continuing.', applyError: 'Could not apply the form changes to this YAML document.' },
  'zh-CN': { hint: '仅浏览器预览。修改不会应用到 CPA 实例，刷新页面后恢复示例配置。', validation: '请先修正标记的配置项。', applyError: '无法将表单更改写入当前 YAML 文档。' },
  'zh-TW': { hint: '僅供瀏覽器預覽。修改不會套用至 CPA 執行個體，重新整理後恢復範例設定。', validation: '請先修正標記的設定項目。', applyError: '無法將表單變更寫入目前的 YAML 文件。' },
  ja: { hint: 'ブラウザーでのプレビュー専用です。変更は CPA に反映されず、再読み込みでリセットされます。', validation: 'マークされた設定を修正してください。', applyError: 'フォームの変更を YAML に適用できませんでした。' },
  ru: { hint: 'Только предпросмотр. Изменения не влияют на CPA и сбрасываются при обновлении страницы.', validation: 'Исправьте отмеченные параметры.', applyError: 'Не удалось применить изменения формы к документу YAML.' },
};

const panelId = 'mock-config-section-panel';
const tabId = (id: ConfigTabId) => `mock-config-tab-${id}`;
const commonFields = new Set<string>(COMMON_FIELD_IDS);

const connectionFields = [
  ['server.host', 'host'], ['server.port', 'port'], ['server.tls.enable', 'tls.enable'],
  ['server.tls.cert', 'tls.cert'], ['server.tls.key', 'tls.key'],
  ['management.secret-key', 'remote-management.secret-key'], ['management.allow-remote', 'remote-management.allow-remote'],
] as const;

function reviewConfigChanges(baseline: string, draft: string) {
  const before = parseDocument(baseline, { merge: true });
  const after = parseDocument(draft, { merge: true });
  if (after.errors.length || !isMap(after.contents)) throw new Error('Invalid YAML');
  const beforeValues: unknown = before.errors.length ? undefined : before.toJS({ mapAsMap: true });
  const afterValues: unknown = after.toJS({ mapAsMap: true });
  const readPath = (values: unknown, path: string) => path.split('.').reduce<unknown>(
    (parent, part) => parent instanceof Map ? parent.get(part) : undefined, values);
  const readField = (values: unknown, path: string, legacy: string) => {
    const value = readPath(values, path);
    return value === undefined ? readPath(values, legacy) : value;
  };
  const fields = connectionFields.filter(([path, legacy]) =>
    !Object.is(readField(beforeValues, path, legacy), readField(afterValues, path, legacy))).map(([path]) => path);
  const hasKeys = (values: unknown) => {
    const keys = readField(values, 'access.api-keys', 'api-keys');
    return Array.isArray(keys) && keys.some(key => typeof key === 'string' && key.trim());
  };
  return { fields, removesAllKeys: hasKeys(beforeValues) && !hasKeys(afterValues) };
}

export default function ConfigManagementPage({ revision, remote, preview, reconnect }: {
  revision: number; remote: boolean; preview: boolean; reconnect: () => void;
}) {
  const { locale, t: appText } = useI18n();
  const { t } = useTranslation();
  const copy = previewCopy[locale];
  const messages = configDocumentMessages(locale);
  const title = appText('app.nav.configManagement');
  const [document, setDocument] = useState<ConfigDocument | null>(null);
  const saved = document?.yaml ?? '';
  const [source, setSource] = useState('');
  const [mode, setMode] = useState<ConfigEditorMode>('visual');
  const [section, setSection] = useState<ConfigTabId>('common');
  const [jump, setJump] = useState<{ fieldId: string } | null>(null);
  const [requestedField, setRequestedField] = useState<string>();
  const [pending, setPending] = useState<({ yaml: string } & ReturnType<typeof reviewConfigChanges>) | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [requestError, setRequestError] = useState<keyof typeof messages | null>(null);
  const [busy, setBusy] = useState(true);
  const [verify, setVerify] = useState(false);
  const [offline, setOffline] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const [remarkDraft, setRemarkDraft] = useState(() => new Map<string, string>());
  const alive = useRef(false);
  const { publishStatus } = useCoreRuntime();
  const { askConfirmation, confirmationDialog } = useConfirmation();
  const {
    visualValues, visualDirty, visualDirtyFields, visualParseError, visualValidationErrors,
    visualHasPayloadValidationErrors, loadVisualValuesFromYaml, applyVisualChangesToYaml, setVisualValues,
  } = useVisualConfig('');
  const dirty = (!offline && (source !== saved || visualDirty)) || remarkDraft.size > 0;
  const readOnly = !document?.etag || busy || offline || restartRequired || requestError === 'restartRequired';
  const ActiveSection = sections[section];
  const invalidSections = CONFIG_TAB_IDS.filter((id) => id === 'payload' ? visualHasPayloadValidationErrors
    : id === 'common' ? Boolean(visualValidationErrors.port)
      : SECTION_VALIDATION_FIELDS[id].some((field) => Boolean(visualValidationErrors[field])));

  useEffect(() => {
    const field = takeConfigManagementField(revision);
    if (field) setRequestedField(field);
  }, [revision]);

  useEffect(() => {
    if (!requestedField || !document || visualParseError || busy) return;
    const entry = CONFIG_FIELD_SEARCH_INDEX.find(item => item.fieldId === requestedField);
    setRequestedField(undefined);
    if (!entry) return;
    setMode('visual');
    setSection(entry.sectionId);
    setJump({ fieldId: entry.fieldId });
  }, [busy, document, requestedField, visualParseError]);

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    void readConfigDocument(revision).then((value) => {
      if (cancelled || selectedTargetRevision() !== revision) return;
      setDocument(value);
      setSource(value.yaml);
      if (!loadVisualValuesFromYaml(value.yaml).ok) setMode('source');
    }).catch((reason: unknown) => {
      if (!cancelled && selectedTargetRevision() === revision) setRequestError(documentError(reason));
    }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { alive.current = false; cancelled = true; };
  }, [loadVisualValuesFromYaml, revision]);

  useEffect(() => {
    if (!dirty && !busy) return;
    const guard = (event: Event) => {
      const navigation = event as AppNavigationRequest;
      navigation.preventDefault();
      if (busy) return;
      setPending(null);
      void askConfirmation({ title, message: t('config_management.reload_confirm_message') }).then((confirmed) => {
        if (confirmed) navigation.detail();
      });
    };
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = true; };
    window.addEventListener(APP_NAVIGATION_REQUEST_EVENT, guard);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener(APP_NAVIGATION_REQUEST_EVENT, guard);
      window.removeEventListener('beforeunload', unload);
    };
  }, [askConfirmation, busy, dirty, t, title]);

  useEffect(() => {
    if (!jump) return;
    const fieldId = (jump.fieldId === 'tlsCert' || jump.fieldId === 'tlsKey') && !visualValues.tlsEnable ? 'tlsEnable' : jump.fieldId;
    const target = window.document.getElementById(configFieldDomId(fieldId));
    if (!target) return;
    for (let group = target.closest('details'); group; group = group.parentElement?.closest('details') ?? null) group.open = true;
    const wrappedGroup = target.querySelector('details');
    if (wrappedGroup) wrappedGroup.open = true;
    const frame = requestAnimationFrame(() => {
      target.classList.add('mock-config-field-highlight');
      target.scrollIntoView({ behavior: prefersReducedMotion() ? 'instant' : 'smooth', block: 'center', inline: 'nearest' });
      const control = target.querySelector<HTMLElement>('input:not(:disabled), [role="combobox"]:not(:disabled)')
        ?? target.querySelector<HTMLElement>('summary, button:not(:disabled)');
      control?.focus({ preventScroll: true });
    });
    const timer = window.setTimeout(() => target.classList.remove('mock-config-field-highlight'), 1800);
    return () => { cancelAnimationFrame(frame); window.clearTimeout(timer); target.classList.remove('mock-config-field-highlight'); };
  }, [jump, section, visualValues.tlsEnable]);

  const jumpToField = (entry: ConfigFieldSearchEntry) => { setSection(entry.sectionId); setJump({ fieldId: entry.fieldId }); };
  const setSourceDraft = (yaml: string) => {
    setSource(yaml);
    setNotice('');
    setError('');
    return loadVisualValuesFromYaml(yaml);
  };

  function documentError(reason: unknown, fallback: 'unavailable' | 'verifyRequired' = 'unavailable') {
    switch (reason) {
      case 'startCore': case 'restartRequired': case 'targetChanged': case 'unsupported': case 'readOnly':
      case 'rejected': case 'conflict': case 'verifyRequired': case 'unavailable': return reason;
      default: return fallback;
    }
  }

  const isCurrent = () => alive.current && selectedTargetRevision() === revision;
  const importCloudRules = async () => {
    if (readOnly || verify) return;
    setBusy(true);
    setNotice('');
    setError('');
    try {
      const catalog = await fetchLatestSensitiveWordRules();
      if (!isCurrent()) return;
      const providers = ['antigravity', 'devin'] as const;
      const entries = providers.flatMap(provider => {
        const words = visualValues[`${provider}SensitiveWords`].map((target, index): WordEntry =>
          ({ id: `${provider}-word-${index}`, provider, kind: 'obfuscate', target, replacement: '' }));
        const replacements = Object.entries(visualValues[`${provider}SensitiveWordsReplace`]).map(([target, replacement], index): WordEntry =>
          ({ id: `${provider}-replace-${index}`, provider, kind: 'replace', target, replacement }));
        return [...words, ...replacements];
      });
      const added = addCloudRules(entries, catalog.rules).slice(entries.length);
      if (added.length) {
        const wordsFor = (provider: typeof providers[number]) => added.filter(rule => rule.provider === provider && rule.kind === 'obfuscate').map(rule => rule.target);
        const replacementsFor = (provider: typeof providers[number]) => Object.fromEntries(added.filter(rule => rule.provider === provider && rule.kind === 'replace').map(rule => [rule.target, rule.replacement]));
        setVisualValues({
          antigravitySensitiveWords: [...visualValues.antigravitySensitiveWords, ...wordsFor('antigravity')],
          devinSensitiveWords: [...visualValues.devinSensitiveWords, ...wordsFor('devin')],
          antigravitySensitiveWordsReplace: { ...visualValues.antigravitySensitiveWordsReplace, ...replacementsFor('antigravity') },
          devinSensitiveWordsReplace: { ...visualValues.devinSensitiveWordsReplace, ...replacementsFor('devin') },
        });
      }
      setNotice(added.length ? messages.cloudRulesAdded : messages.noNewCloudRules);
    } catch {
      if (isCurrent()) setError(messages.cloudRulesFailed);
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };
  const acceptDocument = (next: ConfigDocument, draft = next.yaml) => {
    setDocument(next);
    setOffline(false);
    if (!setSourceDraft(draft).ok || draft !== next.yaml) setMode('source');
  };

  const validate = () => {
    if (!invalidSections.length) return true;
    setError(copy.validation);
    const invalidSection = invalidSections.includes(section) ? section : invalidSections[0];
    setMode('visual');
    setSection(invalidSection);
    if (invalidSection === 'common') setJump({ fieldId: 'port' });
    else if (invalidSection !== 'payload') {
      const field = SECTION_VALIDATION_FIELDS[invalidSection].find((key) => visualValidationErrors[key]);
      const entry = CONFIG_FIELD_SEARCH_INDEX.find((item) => item.sectionId === invalidSection && (item.fieldId === field || FIELD_VALUE_KEYS[item.fieldId]?.includes(field ?? '')));
      if (entry) setJump({ fieldId: entry.fieldId });
    }
    return false;
  };

  const materialize = () => {
    if (!visualDirty) return source;
    try {
      const yaml = applyVisualChangesToYaml(source, 'draft');
      if (yaml !== source) return yaml;
    } catch {
    }
    setError(copy.applyError);
    return null;
  };

  const changeMode = (next: ConfigEditorMode) => {
    if (next === mode || visualParseError) return;
    if (next === 'source') {
      if (!validate()) return;
      const yaml = materialize();
      if (yaml === null) return;
      setSourceDraft(yaml);
    }
    setMode(next);
  };

  const reset = async (reload: boolean) => {
    if (busy) return;
    if (dirty && !await askConfirmation({ title, message: t(reload ? 'config_management.reload_confirm_message' : 'config_management.discard_confirm_message') })) return;
    if (!isCurrent()) return;
    if (reload) {
      await refresh(false);
    } else {
      setSourceDraft(saved);
      setRemarkDraft(new Map());
    }
  };

  const refresh = async (keepDraft: boolean) => {
    const draft = keepDraft && !offline ? materialize() : undefined;
    if (draft === null) return;
    setBusy(true);
    setRequestError(null);
    try {
      const next = await readConfigDocument(revision);
      if (!isCurrent()) return;
      acceptDocument(next, draft);
      if (!keepDraft) setRemarkDraft(new Map());
      setVerify(false);
      setRestartRequired(false);
      setNotice(keepDraft && !offline ? messages.reviewedAgain : t('config_management.status_loaded'));
    } catch (reason) {
      if (isCurrent()) setRequestError(documentError(reason));
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };

  const changeCore = async (restart: boolean) => {
    setBusy(true);
    try {
      const status = await (restart ? restartCoreProcess() : startCoreProcess());
      if (!isCurrent()) return;
      publishStatus(status);
      if (!status.ready) throw new Error();
      setRestartRequired(false);
      await refresh(dirty || offline);
    } catch {
      if (isCurrent()) setError(messages.lifecycleFailed);
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };

  const reviewSave = () => {
    if (readOnly || verify || visualParseError || !validate()) return;
    const yaml = materialize();
    if (yaml === null || (yaml === saved && !remarkDraft.size)) return;
    try {
      setPending({ yaml, ...reviewConfigChanges(saved, yaml) });
    } catch {
      setError(messages.rejected);
    }
  };

  const confirmSave = async () => {
    if (!pending || !document?.etag || busy || verify || !isCurrent()) return;
    setBusy(true);
    setRequestError(null);
    setPending(null);
    try {
      const result = await saveConfigDocument(revision, document.etag, pending.yaml,
        [...remarkDraft].map(([key, remark]) => ({ key, remark })));
      if (!isCurrent()) return;
      if (result.document) acceptDocument(result.document);
      else {
        setSourceDraft(pending.yaml);
        setOffline(true);
        setVerify(true);
      }
      if (result.restartRequired) setRestartRequired(true);
      if (!result.remarksFailed) setRemarkDraft(new Map());
      setNotice([
        !result.document ? messages.savedOffline : result.readbackChanged ? messages.readbackChanged : t('config_management.save_success'),
        result.syncFailed && messages.syncFailed, result.remarksFailed && messages.remarksFailed,
      ].filter(Boolean).join(' '));
    } catch (reason) {
      if (!isCurrent()) return;
      const failure = documentError(reason, 'verifyRequired');
      setRequestError(failure);
      if (failure === 'conflict' || failure === 'verifyRequired' || failure === 'readOnly') setVerify(true);
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };

  const modeSwitch = <div className="mock-config-modes" role="group" aria-label={t('config_management.mode.label')}>
    <button type="button" aria-pressed={mode === 'visual'} disabled={busy || Boolean(visualParseError)} onClick={() => changeMode('visual')}>{t('config_management.mode.visual')}</button>
    <button type="button" aria-pressed={mode === 'source'} disabled={busy} onClick={() => changeMode('source')}>{t('config_management.mode.source')}</button>
  </div>;
  const validationNotice = (visualParseError || error) ? <p className="mock-config-error" role="alert">{visualParseError ? t('config_management.visual_mode_unavailable_detail', { message: visualParseError }) : error}</p> : null;

  const notes = new Map(document?.remarks.map(({ key, remark }) => [key, remark]));
  return <section className="mock-config-page" data-config-management data-mock-config-management={preview ? '' : undefined} aria-label={title} aria-busy={busy}>
    <header className="mock-config-header">
      <div><h1>{title}</h1>{preview && <p>{copy.hint}</p>}</div>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => void reset(true)}><RefreshCw size={15} aria-hidden="true" />{t('config_management.reload')}</button>
    </header>
    {busy && !document && <p role="status">{appText('common.loading')}</p>}
    {requestError && <p role="alert" className="mock-config-error">{messages[requestError]}</p>}
    {requestError === 'startCore' && !remote && <div><button type="button" className="secondary-button" disabled={busy} onClick={() => void changeCore(false)}>{messages.start}</button></div>}
    {remote && (offline || requestError === 'unavailable' || requestError === 'unsupported') && <div><button type="button" className="secondary-button" disabled={busy} onClick={() => requestAppNavigation(reconnect)}>{messages.reconnect}</button></div>}
    {(restartRequired || requestError === 'restartRequired') && <div>{requestError !== 'restartRequired' && <p>{messages.restartRequired}</p>}<button type="button" className="secondary-button" disabled={busy} onClick={() => void changeCore(true)}>{messages.restart}</button></div>}
    {verify && !offline && <div><button type="button" className="secondary-button" disabled={busy} onClick={() => void refresh(true)}>{messages.verify}</button></div>}
    {document && !document.etag && <p role="status">{messages.readOnly}</p>}
    {document?.remarksUnavailable && <p role="status">{messages.remarksUnavailable}</p>}
    {!document && validationNotice}
    {document && (mode === 'source' ? <ConfigSourceEditor value={source} onChange={setSourceDraft} modeSwitch={modeSwitch} validationNotice={validationNotice} readOnly={readOnly} /> : <>
      <div className="mock-config-toolbar"><ConfigSearch onJump={jumpToField} />{modeSwitch}</div>
      {validationNotice}
      <Tabs className="mock-config-tabs secondary-page-tabs" aria-label={title} value={section} onChange={(next) => { setSection(next); setJump(null); }}
        items={CONFIG_TAB_IDS.map((id) => ({ value: id, id: tabId(id), panelId, label: <>{t(`config_management.visual.sections.${id}.title`)}
          {invalidSections.includes(id) ? <span className="mock-config-tab-error" aria-label={copy.validation}>!</span>
            : CONFIG_FIELD_SEARCH_INDEX.some((entry) => (entry.sectionId === id || (id === 'common' && commonFields.has(entry.fieldId))) && FIELD_VALUE_KEYS[entry.fieldId]?.some((field) => visualDirtyFields.has(field))) && <span className="mock-config-tab-dirty" aria-label={t('config_management.status_dirty_short')}>•</span>}
        </> }))} />
      <div id={panelId} role="tabpanel" aria-labelledby={tabId(section)}>
        {section === 'advanced' && <button type="button" className="secondary-button compact-button" disabled={readOnly || verify} onClick={() => void importCloudRules()}>
          {templateText(sensitiveWordsMessages.addLatest, locale)}
        </button>}
        <KeyRemarksContext.Provider value={{
          get: (key) => remarkDraft.get(key) ?? notes.get(key),
          set: (key, remark) => setRemarkDraft(previous => {
            const next = new Map(previous);
            if (remark === (notes.get(key) ?? '')) next.delete(key);
            else next.set(key, remark);
            return next;
          }),
        }}>
          <ActiveSection values={visualValues} validationErrors={visualValidationErrors} disabled={readOnly}
            onChange={(changes) => { setVisualValues(changes); setNotice(''); setError(''); }} />
        </KeyRemarksContext.Provider>
      </div>
    </>)}
    <footer className="mock-config-footer">
      <span role="status">{[notice, dirty && t('config_management.status_dirty')].filter(Boolean).join(' ')}</span>
      {dirty && <div className="mock-config-actions">
        <button type="button" className="secondary-button" disabled={busy || offline} onClick={() => void reset(false)}>{t('config_management.actions.discard')}</button>
        <button type="button" className="primary-button" disabled={readOnly || verify || Boolean(visualParseError)} onClick={reviewSave}>{t('config_management.actions.save')}</button>
      </div>}
    </footer>
    {pending !== null && <Dialog className="config-dialog mock-config-diff-dialog" title={t('config_management.diff.title')} onClose={() => setPending(null)} actions={<>
      <button type="button" className="secondary-button" onClick={() => setPending(null)}>{appText('common.cancel')}</button>
      <button type="button" className="primary-button" disabled={busy} onClick={() => void confirmSave()}>{t('config_management.diff.confirm')}</button>
    </>}>
      {pending.fields.length > 0 && <p role="alert">{messages.connectionWarning} {pending.fields.join(', ')}</p>}
      {pending.removesAllKeys && <p role="alert">{appText('config.keys.deleteAllWarning')}</p>}
      {remarkDraft.size > 0 && <p>{messages.remarksChange}</p>}
      {pending.yaml !== saved && <pre className="mock-config-diff" aria-label="YAML diff">{diffLines(saved, pending.yaml).flatMap((part, partIndex) =>
        part.value.replace(/\n$/, '').split('\n').map((line, lineIndex) => <span key={`${partIndex}-${lineIndex}`} data-change={part.added ? 'added' : part.removed ? 'removed' : 'unchanged'}>{part.added ? '+ ' : part.removed ? '− ' : '  '}{line}</span>))}</pre>}
    </Dialog>}
    {confirmationDialog}
  </section>;
}
