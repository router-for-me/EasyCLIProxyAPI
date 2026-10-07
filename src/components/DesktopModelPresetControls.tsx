import { useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useI18n } from '../i18n';
import { exportDesktopModelPreset, parseDesktopModelPreset, PRESET_LIMIT } from '../services/desktopModelPreset';
import { desktopModelNotListed, type ClaudeDesktopModelMapping } from '../services/claudeDesktopModels';

import type { ModelOption } from '../services/modelService';

export function DesktopModelPresetControls({ entries, disabled, onImport, models, catalogReady }: { models: ModelOption[]; catalogReady: boolean; entries: ClaudeDesktopModelMapping[]; disabled: boolean; onImport: (entries: ClaudeDesktopModelMapping[]) => void }) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<ClaudeDesktopModelMapping[] | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const exportFile = async () => {
    setMessage(''); setBusy(true);
    try {
      const content = exportDesktopModelPreset(entries);
      const saved = await invoke<boolean>('export_desktop_model_preset', { content });
      if (saved) setMessage(t('preset.exported'));
    } catch { setMessage(t('preset.exportError')); }
    finally { setBusy(false); }
  };
  return <div className="model-preset-controls">
    <div className="model-preset-toolbar">
      <span>{t('preset.hint')}</span>
      <button type="button" className="secondary-button compact-button" disabled={disabled || busy || !entries.some((entry) => entry.model.trim())} onClick={() => void exportFile()}>{t('preset.export')}</button>
      <button type="button" className="secondary-button compact-button" disabled={disabled || busy} onClick={() => input.current?.click()}>{t('preset.import')}</button>
      <input ref={input} type="file" accept=".json,application/json" hidden tabIndex={-1} aria-label={t('preset.import')} disabled={disabled || busy}
        onChange={async (event) => {
          const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
          if (!file) return;
          setMessage(''); setPreview(null); setBusy(true);
          try { if (file.size > PRESET_LIMIT) throw new Error('size'); setPreview(parseDesktopModelPreset(await file.text())); }
          catch { setMessage(t('preset.invalid')); }
          finally { setBusy(false); }
        }} />
    </div>
    {preview && <section className="model-preset-preview" aria-label={t('preset.preview')}>
      <strong>{t('preset.review', { count: preview.length })}</strong>
      <p>{t('preset.replaceHint')}</p>
      <ol>{preview.map((entry, index) => <li key={index}><code>{entry.model}</code>{entry.alias ? ` → ${entry.alias}` : ''}{entry.context1m ? ` · ${t('agents.claudeMapping.context1m')}` : ''}{catalogReady && desktopModelNotListed(entry, models) && <p className="agent-inline-message warning" role="status">{t('preset.notListed', { row: index + 1, model: entry.model })}</p>}</li>)}</ol>
      <div className="model-preset-actions"><button type="button" className="primary-button" disabled={disabled || busy} onClick={() => { onImport(preview); setPreview(null); setMessage(t('preset.imported')); }}>{t('preset.replace')}</button>
      <button type="button" className="secondary-button" onClick={() => setPreview(null)}>{t('common.cancel')}</button></div>
    </section>}
    {message && <p className="agent-model-hint" role="status">{message}</p>}
  </div>;
}
