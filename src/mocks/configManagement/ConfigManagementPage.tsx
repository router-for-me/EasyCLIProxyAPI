import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { diffLines } from 'diff';
import { useConfirmation } from '../../components/ConfirmationDialog';
import { Dialog } from '../../components/Dialog';
import { Tabs } from '../../components/Tabs';
import { useI18n } from '../../i18n';
import { APP_NAVIGATION_REQUEST_EVENT, type AppNavigationRequest } from '../../navigation';
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
import { readMockConfig, saveMockConfig } from './mockDocument';
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

export default function ConfigManagementPage() {
  const { locale, t: appText } = useI18n();
  const { t } = useTranslation();
  const copy = previewCopy[locale];
  const title = appText('app.nav.configManagement');
  const [saved, setSaved] = useState(readMockConfig);
  const [source, setSource] = useState(saved);
  const [mode, setMode] = useState<ConfigEditorMode>('visual');
  const [section, setSection] = useState<ConfigTabId>('common');
  const [jump, setJump] = useState<{ fieldId: string } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const { askConfirmation, confirmationDialog } = useConfirmation();
  const {
    visualValues, visualDirty, visualDirtyFields, visualParseError, visualValidationErrors,
    visualHasPayloadValidationErrors, loadVisualValuesFromYaml, applyVisualChangesToYaml, setVisualValues,
  } = useVisualConfig(saved);
  const dirty = source !== saved || visualDirty;
  const ActiveSection = sections[section];
  const invalidSections = CONFIG_TAB_IDS.filter((id) => id === 'payload' ? visualHasPayloadValidationErrors
    : id === 'common' ? Boolean(visualValidationErrors.port)
      : SECTION_VALIDATION_FIELDS[id].some((field) => Boolean(visualValidationErrors[field])));

  useEffect(() => {
    if (!dirty) return;
    const guard = (event: Event) => {
      const navigation = event as AppNavigationRequest;
      navigation.preventDefault();
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
  }, [askConfirmation, dirty, t, title]);

  useEffect(() => {
    if (!jump) return;
    const fieldId = (jump.fieldId === 'tlsCert' || jump.fieldId === 'tlsKey') && !visualValues.tlsEnable ? 'tlsEnable' : jump.fieldId;
    const target = document.getElementById(configFieldDomId(fieldId));
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
    if (dirty && !await askConfirmation({ title, message: t(reload ? 'config_management.reload_confirm_message' : 'config_management.discard_confirm_message') })) return;
    const yaml = readMockConfig();
    setSaved(yaml);
    setSourceDraft(yaml);
    setNotice(reload ? t('config_management.status_loaded') : '');
  };

  const reviewSave = () => {
    if (visualParseError || !validate()) return;
    const yaml = materialize();
    if (yaml !== null && yaml !== saved) setPending(yaml);
  };

  const confirmSave = () => {
    if (pending === null) return;
    saveMockConfig(pending);
    setSaved(pending);
    setSourceDraft(pending);
    setPending(null);
    setNotice(t('config_management.save_success'));
  };

  const modeSwitch = <div className="mock-config-modes" role="group" aria-label={t('config_management.mode.label')}>
    <button type="button" aria-pressed={mode === 'visual'} disabled={Boolean(visualParseError)} onClick={() => changeMode('visual')}>{t('config_management.mode.visual')}</button>
    <button type="button" aria-pressed={mode === 'source'} onClick={() => changeMode('source')}>{t('config_management.mode.source')}</button>
  </div>;
  const validationNotice = (visualParseError || error) ? <p className="mock-config-error" role="alert">{visualParseError ? t('config_management.visual_mode_unavailable_detail', { message: visualParseError }) : error}</p> : null;

  return <section className="mock-config-page" data-mock-config-management aria-label={title}>
    <header className="mock-config-header">
      <div><h1>{title}</h1><p>{copy.hint}</p></div>
      <button type="button" className="secondary-button" onClick={() => void reset(true)}><RefreshCw size={15} aria-hidden="true" />{t('config_management.reload')}</button>
    </header>
    {mode === 'source' ? <ConfigSourceEditor value={source} onChange={setSourceDraft} modeSwitch={modeSwitch} validationNotice={validationNotice} /> : <>
      <div className="mock-config-toolbar"><ConfigSearch onJump={jumpToField} />{modeSwitch}</div>
      {validationNotice}
      <Tabs className="mock-config-tabs secondary-page-tabs" aria-label={title} value={section} onChange={(next) => { setSection(next); setJump(null); }}
        items={CONFIG_TAB_IDS.map((id) => ({ value: id, id: tabId(id), panelId, label: <>{t(`config_management.visual.sections.${id}.title`)}
          {invalidSections.includes(id) ? <span className="mock-config-tab-error" aria-label={copy.validation}>!</span>
            : CONFIG_FIELD_SEARCH_INDEX.some((entry) => (entry.sectionId === id || (id === 'common' && commonFields.has(entry.fieldId))) && FIELD_VALUE_KEYS[entry.fieldId]?.some((field) => visualDirtyFields.has(field))) && <span className="mock-config-tab-dirty" aria-label={t('config_management.status_dirty_short')}>•</span>}
        </> }))} />
      <div id={panelId} role="tabpanel" aria-labelledby={tabId(section)}>
        <ActiveSection values={visualValues} validationErrors={visualValidationErrors} disabled={false}
          onChange={(changes) => { setVisualValues(changes); setNotice(''); setError(''); }} />
      </div>
    </>}
    <footer className="mock-config-footer">
      <span role="status">{dirty ? t('config_management.status_dirty') : notice}</span>
      {dirty && <div className="mock-config-actions">
        <button type="button" className="secondary-button" onClick={() => void reset(false)}>{t('config_management.actions.discard')}</button>
        <button type="button" className="primary-button" disabled={Boolean(visualParseError)} onClick={reviewSave}>{t('config_management.actions.save')}</button>
      </div>}
    </footer>
    {pending !== null && <Dialog className="config-dialog mock-config-diff-dialog" title={t('config_management.diff.title')} onClose={() => setPending(null)} actions={<>
      <button type="button" className="secondary-button" onClick={() => setPending(null)}>{appText('common.cancel')}</button>
      <button type="button" className="primary-button" onClick={confirmSave}>{t('config_management.diff.confirm')}</button>
    </>}>
      <pre className="mock-config-diff" aria-label="YAML diff">{diffLines(saved, pending).flatMap((part, partIndex) =>
        part.value.replace(/\n$/, '').split('\n').map((line, lineIndex) => <span key={`${partIndex}-${lineIndex}`} data-change={part.added ? 'added' : part.removed ? 'removed' : 'unchanged'}>{part.added ? '+ ' : part.removed ? '− ' : '  '}{line}</span>))}</pre>
    </Dialog>}
    {confirmationDialog}
  </section>;
}
