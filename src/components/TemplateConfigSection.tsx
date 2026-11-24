import { Notice } from './Notice';
import { Switch } from './Switch';
import { onConfigFilesChanged } from '../services/events';
import {
  getExtendedCoreConfig,
  saveExtendedCoreConfig,
  applyTemplateChanges,
  draftTemplateField,
  readTemplatePath,
  templateFieldKey,
  templateFieldValidation,
  templateFieldSaveValue,
  type TemplateConfigChange,
  type TemplateConfigDraft,
  type TemplateConfigField,
  type TemplateConfigGroup,
  type TemplateText,
} from '../services/templateConfig';
import { restartCoreProcess } from '../services/coreLifecycle';
import { selectedRemoteEndpoint } from '../services/remoteCpa';
import { settingsMessages } from '../services/settingsNavigation';
import { openExternalUrl } from '../services/appSettings';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { open } from '../services/platform';
import { Check, ChevronRight, ExternalLink, Eye, EyeOff, RotateCcw } from 'lucide-react';
import { useI18n } from '../i18n';
import { templateMessages, templateText } from '../i18n/templateConfig';
import { useCoreRuntime } from '../coreRuntime';
import { SettingsHelp } from './SettingsHelp';
import { Select } from './Select';
import '../styles/template-config.css';

const restartHint = { zh: '需重启内核', en: 'Core restart required', ja: 'コアの再起動が必要' } satisfies TemplateText;
const collapseLabel = { zh: '收起', en: 'Collapse', ja: '閉じる' } satisfies TemplateText;
const emptyStructuredLabel = { zh: '未配置', en: 'Not configured', ja: '未設定' } satisfies TemplateText;

function countStructuredItems(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value as Record<string, unknown>).length;
  return 0;
}

export type TemplateConfigSectionHandle = {
  saveAllDirtyGroups: () => Promise<boolean>;
  discardAllDirtyGroups: () => void;
};

type TemplateConfigSectionProps = {
  groups: readonly TemplateConfigGroup[];
  visibleGroups?: readonly string[];
  onDirtyGroupsChange?: (groupIds: readonly string[]) => void;
};

export const TemplateConfigSection = forwardRef<TemplateConfigSectionHandle, TemplateConfigSectionProps>(function TemplateConfigSection({
  groups,
  visibleGroups,
  onDirtyGroupsChange,
}, ref) {
  const { locale, t } = useI18n();
  const external = Boolean(selectedRemoteEndpoint());
  const { status, publishStatus, refreshStatus } = useCoreRuntime();
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [drafts, setDrafts] = useState<Record<string, TemplateConfigDraft>>({});
  const [loadError, setLoadError] = useState('');
  const [groupErrors, setGroupErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [openDetails, setOpenDetails] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const mounted = useRef(true);
  const revision = useRef(0);
  const reportedDirtyGroups = useRef<string | null>(null);
  const tr = (message: keyof typeof templateMessages) => templateText(templateMessages[message], locale);

  useEffect(() => {
    if (!onDirtyGroupsChange) return;
    const dirtyGroups = groups.filter((group) => group.fields.some((field) => drafts[templateFieldKey(field.path)])).map((group) => group.id);
    const signature = JSON.stringify(dirtyGroups);
    if (reportedDirtyGroups.current === signature) return;
    reportedDirtyGroups.current = signature;
    onDirtyGroupsChange(dirtyGroups);
  }, [drafts, groups, onDirtyGroupsChange]);

  const reload = useCallback(async () => {
    const request = ++revision.current;
    try {
      const value = await getExtendedCoreConfig();
      if (mounted.current && request === revision.current) { setConfig(value); setLoadError(''); }
    } catch (error) {
      if (mounted.current && request === revision.current) setLoadError(String(error));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let stop: (() => void) | undefined;
    void reload();
    void onConfigFilesChanged(() => { if (!disposed) void reload(); }).then((unlisten) => {
      if (!disposed) stop = unlisten;
      else unlisten();
    }).catch((error) => { if (!disposed) setLoadError(String(error)); });
    return () => { disposed = true; mounted.current = false; ++revision.current; stop?.(); };
  }, [reload]);

  const changeField = (group: TemplateConfigGroup, field: TemplateConfigField, value: unknown, remove = false) => {
    if (!config) return;
    const key = templateFieldKey(field.path);
    setDrafts((previous) => {
      const next = { ...previous };
      const draft = draftTemplateField(field, config, previous[key], value, remove);
      if (draft) next[key] = draft;
      else delete next[key];
      return next;
    });
    setGroupErrors((previous) => ({ ...previous, [group.id]: '' }));
    setSaved((previous) => ({ ...previous, [group.id]: false }));
  };

  const discardGroup = (group: TemplateConfigGroup) => {
    setDrafts((previous) => {
      const next = { ...previous };
      for (const field of group.fields) delete next[templateFieldKey(field.path)];
      return next;
    });
    setGroupErrors((previous) => ({ ...previous, [group.id]: '' }));
    setSaved((previous) => ({ ...previous, [group.id]: false }));
  };

  const discardAllDirtyGroups = useCallback(() => {
    setDrafts({});
    setGroupErrors({});
    setSaved({});
  }, []);

  const saveGroup = async (group: TemplateConfigGroup): Promise<boolean> => {
    if (!config || busy) return false;
    const changes: TemplateConfigChange[] = [];
    for (const field of group.fields) {
      const draft = drafts[templateFieldKey(field.path)];
      if (!draft) continue;
      const error = !draft.remove && templateFieldValidation(field, draft.value);
      if (error) {
        setGroupErrors((previous) => ({ ...previous, [group.id]: `${templateText(field.label, locale)}: ${templateText(error, locale)}` }));
        return false;
      }
      changes.push({ ...draft, path: [...field.path], value: draft.remove ? null : templateFieldSaveValue(field, draft.value) });
    }
    if (!changes.length) return true;
    const groupError = group.validate?.(applyTemplateChanges(config, changes));
    if (groupError) { setGroupErrors((previous) => ({ ...previous, [group.id]: templateText(groupError, locale) })); return false; }
    setBusy(group.id);
    setGroupErrors((previous) => ({ ...previous, [group.id]: '' }));
    try {
      const result = await saveExtendedCoreConfig({ changes });
      ++revision.current;
      setConfig(result.config);
      setLoadError('');
      setDrafts((previous) => {
        const next = { ...previous };
        for (const change of changes) delete next[templateFieldKey(change.path)];
        return next;
      });
      setSaved((previous) => ({ ...previous, [group.id]: true }));
      if (result.restartRequired) setRestartNeeded(true);
      return true;
    } catch (error) {
      setGroupErrors((previous) => ({ ...previous, [group.id]: String(error) }));
      // Refresh untouched values while retaining both the draft and its original conflict check.
      await reload();
      return false;
    } finally { if (mounted.current) setBusy(null); }
  };

  const saveAllDirtyGroups = useCallback(async (): Promise<boolean> => {
    if (!config || busy) return false;
    const dirtyGroups = groups.filter((group) => group.fields.some((field) => drafts[templateFieldKey(field.path)]));
    if (!dirtyGroups.length) return true;
    const changes: TemplateConfigChange[] = [];
    const nextErrors: Record<string, string> = {};
    for (const group of dirtyGroups) {
      const groupChanges: TemplateConfigChange[] = [];
      for (const field of group.fields) {
        const draft = drafts[templateFieldKey(field.path)];
        if (!draft) continue;
        const error = !draft.remove && templateFieldValidation(field, draft.value);
        if (error) {
          nextErrors[group.id] = `${templateText(field.label, locale)}: ${templateText(error, locale)}`;
          break;
        }
        groupChanges.push({ ...draft, path: [...field.path], value: draft.remove ? null : templateFieldSaveValue(field, draft.value) });
      }
      if (!nextErrors[group.id] && groupChanges.length) {
        const groupError = group.validate?.(applyTemplateChanges(config, [...changes, ...groupChanges]));
        if (groupError) nextErrors[group.id] = templateText(groupError, locale);
        else changes.push(...groupChanges);
      }
    }
    if (Object.keys(nextErrors).length > 0) {
      setGroupErrors((previous) => ({ ...previous, ...nextErrors }));
      return false;
    }
    if (!changes.length) return true;
    setBusy('all');
    setGroupErrors({});
    try {
      const result = await saveExtendedCoreConfig({ changes });
      ++revision.current;
      setConfig(result.config);
      setLoadError('');
      setDrafts((previous) => {
        const next = { ...previous };
        for (const change of changes) delete next[templateFieldKey(change.path)];
        return next;
      });
      setSaved((previous) => {
        const next = { ...previous };
        for (const group of dirtyGroups) next[group.id] = true;
        return next;
      });
      if (result.restartRequired) setRestartNeeded(true);
      return true;
    } catch (error) {
      const firstId = dirtyGroups[0]?.id;
      if (firstId) setGroupErrors((previous) => ({ ...previous, [firstId]: String(error) }));
      await reload();
      return false;
    } finally { if (mounted.current) setBusy(null); }
  }, [busy, config, drafts, groups, locale, reload]);

  useImperativeHandle(ref, () => ({
    saveAllDirtyGroups,
    discardAllDirtyGroups,
  }), [saveAllDirtyGroups, discardAllDirtyGroups]);

  const restart = async () => {
    setBusy('restart');
    try { publishStatus(await restartCoreProcess()); setRestartNeeded(false); setLoadError(''); }
    catch (error) { setLoadError(String(error)); await refreshStatus(); }
    finally { setBusy(null); }
  };

  const chooseDirectory = async (group: TemplateConfigGroup, field: TemplateConfigField) => {
    setBusy('directory');
    try {
      const selected = await open({ directory: true, multiple: false, title: templateText(field.label, locale) });
      if (mounted.current && typeof selected === 'string') changeField(group, field, selected);
    } catch (error) {
      if (mounted.current) setGroupErrors((previous) => ({ ...previous, [group.id]: String(error) }));
    } finally { if (mounted.current) setBusy(null); }
  };

  const control = (group: TemplateConfigGroup, field: TemplateConfigField, value: unknown, id: string, invalid: boolean) => {
    const disabled = busy !== null || config === null;
    const onChange = (next: unknown) => changeField(group, field, next);
    const common = { id, disabled, 'aria-invalid': invalid || undefined, 'aria-describedby': invalid ? `${id}-error` : undefined };
    if (field.type === 'custom' && field.render) return field.render({ value, onChange, disabled, id });
    if (field.type === 'boolean') return <Switch {...common} checked={value === true} onChange={(event) => onChange(event.currentTarget.checked)} />;
    if (field.type === 'select') {
      const selected = field.options?.findIndex((option) => Object.is(option.value, value)) ?? -1;
      return <Select {...common} className="config-network-input" value={String(selected)} onChange={(event) => onChange(field.options?.[Number(event.currentTarget.value)]?.value)}>
        {selected < 0 ? <option value="-1">{String(value ?? '')}</option> : null}
        {field.options?.map((option, index) => <option key={index} value={String(index)}>{templateText(option.label, locale)}</option>)}
      </Select>;
    }
    if (field.type === 'string-list' || field.type === 'json') return <textarea {...common} className="config-network-input template-config-textarea" rows={field.rows ?? (field.type === 'json' ? 6 : 3)}
      value={field.type === 'string-list' ? Array.isArray(value) ? value.join('\n') : '' : typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2)}
      placeholder={field.placeholder}
      onChange={(event) => onChange(field.type === 'string-list' ? event.currentTarget.value.split('\n') : event.currentTarget.value)}
      onBlur={() => { if (field.type === 'string-list' && Array.isArray(value)) { const clean = value.map(String).map((item) => item.trim()).filter(Boolean); if (JSON.stringify(clean) !== JSON.stringify(value)) onChange(clean); } }} />;
    const input = <input {...common} className="config-network-input" type={field.type === 'number' ? 'number' : field.sensitive && !revealed[id] ? 'password' : 'text'} autoComplete={field.sensitive ? 'new-password' : undefined}
      min={field.min} max={field.max} step={field.step ?? 1} placeholder={field.placeholder} value={typeof value === 'string' || typeof value === 'number' ? value : ''}
      onChange={(event) => onChange(field.type === 'number' && event.currentTarget.value !== '' ? Number(event.currentTarget.value) : event.currentTarget.value)} />;
    const secret = field.sensitive ? <div className="config-secret-input template-config-secret">{input}<button type="button" className={`icon-button quiet config-secret-toggle${revealed[id] ? ' is-revealed' : ''}`} disabled={disabled} aria-pressed={Boolean(revealed[id])} onClick={() => setRevealed((previous) => ({ ...previous, [id]: !previous[id] }))}
      title={t(revealed[id] ? 'config.keys.hide' : 'config.keys.show')} aria-label={t(revealed[id] ? 'config.keys.hide' : 'config.keys.show')}>{revealed[id] ? <Eye size={16} strokeWidth={1.75} aria-hidden="true" /> : <EyeOff size={16} strokeWidth={1.75} aria-hidden="true" />}</button></div> : input;
    if (field.link) {
      const link = field.link;
      return <div className="template-config-directory">{secret}<button type="button" className="secondary-button compact-button" onClick={() => void openExternalUrl({ url: link.url }).catch((error) => setGroupErrors((previous) => ({ ...previous, [group.id]: String(error) })))}><ExternalLink size={15} aria-hidden="true" />{templateText(link.label, locale)}</button></div>;
    }
    return field.directory ? <div className="template-config-directory">{secret}<button type="button" className="secondary-button compact-button" disabled={disabled || external} title={external ? t('remote.serverFilePath') : undefined} onClick={() => void chooseDirectory(group, field)} aria-label={`${tr('chooseDirectory')}: ${templateText(field.label, locale)}`}>{tr('chooseDirectory')}</button></div> : secret;
  };

  const formatConfiguredCount = (count: number) => {
    if (count <= 0) return templateText(emptyStructuredLabel, locale);
    if (locale === 'en') return `${count} configured`;
    if (locale === 'ja') return `${count} 件設定済み`;
    return `已配置 ${count} 项`;
  };

  const visible = groups.filter((group) => !visibleGroups || visibleGroups.includes(group.id));
  return <div className="template-config-section" hidden={visible.length === 0}>
    {loadError ? <Notice tone="error" icon={false} className="template-config-notice" action={<button type="button" className="secondary-button compact-button" disabled={busy !== null} onClick={() => void reload()}>{tr('reload')}</button>}>{loadError}</Notice> : null}
    {!config && !loadError ? <p role="status">{tr('loading')}</p> : null}
    {restartNeeded ? <Notice tone="info" icon={false} className="template-config-notice" action={!external && status?.running ? <button type="button" className="secondary-button compact-button" disabled={busy !== null} onClick={() => void restart()}>{tr('restartNow')}</button> : undefined}>{external ? templateText(settingsMessages.externalRestart, locale) : tr('restart')}</Notice> : null}
    {groups.map((group) => {
      const dirty = group.fields.some((field) => drafts[templateFieldKey(field.path)]);
      const needsRestart = group.fields.some((field) => field.restart);
      const isSavingGroup = busy === group.id || (busy === 'all' && dirty);
      return <section key={group.id} id={`config-group-${group.id}`} tabIndex={-1} className={`config-card template-config-card${group.fields.some(field => ['custom', 'json', 'string-list'].includes(field.type)) ? ' config-settings-wide' : ''}${dirty ? ' template-config-card-dirty' : ''}`} hidden={!visible.includes(group)} aria-labelledby={`template-group-${group.id}`}>
        <div className="template-config-heading">
          <div className="template-config-heading-main">
            <h3 id={`template-group-${group.id}`}>{templateText(group.title, locale)}</h3>
            {group.description ? <SettingsHelp label={templateText(group.title, locale)}>{templateText(group.description, locale)}</SettingsHelp> : null}
          </div>
          <div className="template-config-heading-actions">
            {needsRestart ? <span className="template-config-restart-hint"><RotateCcw size={12} aria-hidden="true" />{templateText(restartHint, locale)}</span> : null}
            {dirty ? (
              <div className="template-config-inline-actions">
                <button type="button" className="secondary-button compact-button" disabled={busy !== null} onClick={() => discardGroup(group)}>{tr('discard')}</button>
                <button type="button" className="primary-button compact-button" disabled={busy !== null || !config} onClick={() => void saveGroup(group)}>
                  <Check size={15} aria-hidden="true" />
                  {isSavingGroup ? tr('saving') : t('common.save')}
                </button>
              </div>
            ) : saved[group.id] ? (
              <span className="state-pill success" role="status">{tr('saved')}</span>
            ) : null}
          </div>
        </div>
        <div className="template-config-fields">{group.fields.map((field, index) => {
          const key = templateFieldKey(field.path);
          const original = readTemplatePath(config, field.path);
          const draft = drafts[key];
          const exists = draft ? !draft.remove : original.exists;
          const value = draft && !draft.remove ? draft.value : draft?.remove || !original.exists ? field.defaultValue : original.value;
          const validation = draft && !draft.remove ? templateFieldValidation(field, value) : null;
          const id = `template-${group.id}-${index}`;
          const description = [templateText(field.description, locale), field.type === 'string-list' ? tr('list') : ''].filter(Boolean).join(' ');
          const resetLabel = `${tr('default')}: ${templateText(field.label, locale)}`;
          if (field.type === 'custom') {
            const isOpen = Boolean(openDetails[id]);
            const itemCount = countStructuredItems(value);
            return <div key={key} id={`template-field-${group.id}-${index}`} data-field-type={field.type} tabIndex={-1} className={`template-config-field template-config-field-wide${draft ? ' template-config-field-dirty' : ''}`}>
              <details
                className="surface-section template-config-custom"
                open={isOpen}
                onToggle={(event) => {
                  const nextOpen = event.currentTarget.open;
                  setOpenDetails((previous) => (previous[id] === nextOpen ? previous : { ...previous, [id]: nextOpen }));
                }}
              >
                <summary
                  className="template-config-custom-summary"
                  aria-labelledby={`${id}-label ${id}-edit`}
                  aria-describedby={validation ? `${id}-error` : undefined}
                >
                  <span className="template-config-custom-title-wrap">
                    <ChevronRight size={15} className="template-config-custom-chevron" aria-hidden="true" />
                    <span id={`${id}-label`} className="template-config-custom-title">{templateText(field.label, locale)}</span>
                    <span className={`template-config-custom-badge${itemCount > 0 ? ' is-active' : ''}`}>{formatConfiguredCount(itemCount)}</span>
                  </span>
                  <span className="template-config-custom-meta">
                    {description || exists ? (
                      <span
                        className="template-config-custom-tools"
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); }}
                      >
                        {description ? <SettingsHelp label={templateText(field.label, locale)}>{description}</SettingsHelp> : null}
                        {exists ? <button type="button" className="icon-button quiet ghost tiny-button template-config-reset" disabled={busy !== null || !config} title={resetLabel} aria-label={resetLabel} onClick={() => changeField(group, field, null, true)}><RotateCcw size={14} aria-hidden="true" /></button> : null}
                      </span>
                    ) : null}
                    <span id={`${id}-edit`} className="template-config-custom-action">{isOpen ? templateText(collapseLabel, locale) : tr('editDetails')}</span>
                  </span>
                </summary>
                <div className="template-config-control" role="group" aria-labelledby={`${id}-label`}>{control(group, field, value, id, Boolean(validation))}</div>
              </details>
              {validation ? <small id={`${id}-error`} className="template-config-error" role="alert">{templateText(validation, locale)}</small> : null}
            </div>;
          }
          return <div key={key} id={`template-field-${group.id}-${index}`} data-field-type={field.type} tabIndex={-1} className={`template-config-field${field.type === 'json' || field.type === 'string-list' ? ' template-config-field-wide' : ''}${field.type === 'boolean' ? ' template-config-toggle' : ''}${draft ? ' template-config-field-dirty' : ''}`}>
            <div className="template-config-label"><label htmlFor={id}>{templateText(field.label, locale)}</label><div className="template-config-label-tools">{description ? <SettingsHelp label={templateText(field.label, locale)}>{description}</SettingsHelp> : null}{exists ? <button type="button" className="icon-button quiet ghost tiny-button template-config-reset" disabled={busy !== null || !config} title={resetLabel} aria-label={resetLabel} onClick={() => changeField(group, field, null, true)}><RotateCcw size={14} aria-hidden="true" /></button> : null}</div></div>
            <div className="template-config-control">{control(group, field, value, id, Boolean(validation))}</div>
            {field.link?.hint ? <small className="template-config-link-hint">{templateText(field.link.hint, locale)}</small> : null}
            {validation ? <small id={`${id}-error`} className="template-config-error" role="alert">{templateText(validation, locale)}</small> : null}
          </div>;
        })}</div>
        {groupErrors[group.id] ? <Notice tone="error" variant="text">{groupErrors[group.id]}</Notice> : null}
      </section>;
    })}
  </div>;
});
