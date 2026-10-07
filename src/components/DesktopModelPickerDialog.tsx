import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useI18n } from '../i18n';
import type { ModelOption } from '../services/modelService';
import type { ClaudeDesktopModelMapping } from '../services/claudeDesktopModels';

export function DesktopModelPickerDialog({
  models,
  existingEntries,
  onAdd,
  onClose,
}: {
  models: ModelOption[];
  existingEntries: ClaudeDesktopModelMapping[];
  onAdd: (entries: ClaudeDesktopModelMapping[]) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  const existingKeys = useMemo(
    () => new Set(existingEntries.map((entry) => entry.model.trim().toLowerCase()).filter(Boolean)),
    [existingEntries],
  );
  const candidates = useMemo(
    () => models.filter((model) => !existingKeys.has(model.name.trim().toLowerCase())),
    [models, existingKeys],
  );
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return candidates;
    return candidates.filter((model) =>
      model.name.toLowerCase().includes(needle) || (model.displayName ?? '').toLowerCase().includes(needle));
  }, [candidates, query]);

  const toggle = (name: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };
  const selectAll = () => setSelected(new Set(filtered.map((model) => model.name)));
  const selectNone = () => setSelected(new Set());

  const confirm = () => {
    if (!selected.size) return;
    onAdd(models.filter((model) => selected.has(model.name))
      .map((model) => ({ model: model.name, alias: '', context1m: false })));
  };

  return (
    <dialog ref={dialogRef} className="config-dialog agent-desktop-picker-dialog" aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
      }}>
      <div className="config-dialog-heading">
        <h2 id={titleId}>{t('agents.claudeDesktopMapping.pickerTitle')}</h2>
        <button type="button" className="icon-button quiet" onClick={onClose} aria-label={t('common.close')}><X size={18} /></button>
      </div>
      <div className="agent-desktop-picker-search">
        <Search size={16} aria-hidden="true" />
        <input type="text" value={query} onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder={t('agents.claudeDesktopMapping.pickerSearch')} aria-label={t('agents.claudeDesktopMapping.pickerSearch')} autoFocus />
      </div>
      <div className="agent-desktop-picker-toolbar">
        <button type="button" className="secondary-button compact-button" disabled={!filtered.length} onClick={selectAll}>
          {t('agents.claudeDesktopMapping.pickerSelectAll')}
        </button>
        <button type="button" className="secondary-button compact-button" disabled={!selected.size} onClick={selectNone}>
          {t('agents.claudeDesktopMapping.pickerSelectNone')}
        </button>
      </div>
      {filtered.length
        ? <ul className="agent-desktop-picker-list">
          {filtered.map((model) => (
            <li key={model.name}>
              <label className="agent-desktop-picker-row">
                <input type="checkbox" checked={selected.has(model.name)} onChange={() => toggle(model.name)} />
                <span className="agent-desktop-picker-name">{model.name}</span>
                {model.displayName && model.displayName !== model.name
                  ? <span className="agent-desktop-picker-display-name">{model.displayName}</span> : null}
              </label>
            </li>
          ))}
        </ul>
        : <p className="agent-model-hint">{t('agents.claudeDesktopMapping.pickerEmpty')}</p>}
      <div className="model-preset-actions">
        <button type="button" className="primary-button" disabled={!selected.size} onClick={confirm}>
          {t('agents.claudeDesktopMapping.pickerAdd', { count: selected.size })}
        </button>
        <button type="button" className="secondary-button" onClick={onClose}>{t('common.cancel')}</button>
      </div>
    </dialog>
  );
}
