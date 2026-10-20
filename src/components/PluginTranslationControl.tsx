import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Languages, LoaderCircle, Settings2, X } from 'lucide-react';
import { SelectMenu, type SelectMenuOption } from './SelectMenu';
import { useDialogFocusTrap } from './useDialogFocusTrap';
import { useI18n } from '../i18n';
import { pluginText } from '../i18n/plugins';
import {
  loadPluginTranslationModels, rememberPluginTranslationModel, savedPluginTranslationModel,
  translatePluginText, type PluginTranslationModel,
} from '../services/pluginTranslation';

export function PluginTranslationControl({
  text,
  translated,
  showingOriginal,
  onTranslated,
  onToggleOriginal,
  disabled = false,
  compact = false,
}: {
  text: string;
  translated: string | null;
  showingOriginal: boolean;
  onTranslated: (value: string | null) => void;
  onToggleOriginal: () => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const { t, locale } = useI18n();
  const pt = (key: Parameters<typeof pluginText>[0]) => pluginText(key, locale);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [models, setModels] = useState<PluginTranslationModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const dialogRef = useDialogFocusTrap<HTMLElement>({ active: picking, onEscape: () => { if (!busy) setPicking(false); }, preventEscape: busy });

  const loadModels = async (preserveError = false) => {
    setModelsLoading(true); setModelsError('');
    if (!preserveError) setError('');
    try {
      const next = await loadPluginTranslationModels();
      setModels(next);
      const saved = savedPluginTranslationModel();
      setSelectedModel(next.some(model => model.name === saved) ? saved : next[0]?.name ?? '');
      if (!next.length) setModelsError(pt('translationNoModels'));
    } catch (reason) {
      setModels([]);
      setSelectedModel('');
      setModelsError(reason instanceof Error ? reason.message : pt('translationNoModels'));
    } finally {
      setModelsLoading(false);
    }
  };

  const openPicker = (message = '') => {
    setPicking(true);
    void loadModels(Boolean(message));
    if (message) setError(message);
  };

  const runTranslation = async (model: string, fromPicker: boolean) => {
    if (!model || busy) return;
    setBusy(true); setError('');
    try {
      const result = await translatePluginText(text, model, locale);
      rememberPluginTranslationModel(model);
      onTranslated(result);
      setPicking(false);
    } catch {
      if (fromPicker) setError(pt('translationFailed'));
      else openPicker(pt('translationFailed'));
    } finally {
      setBusy(false);
    }
  };

  const activate = () => {
    if (translated) {
      onToggleOriginal();
      return;
    }
    const saved = savedPluginTranslationModel();
    if (saved) void runTranslation(saved, false);
    else openPicker();
  };

  const options: SelectMenuOption[] = models.map(model => ({
    value: model.name,
    label: model.displayName && model.displayName !== model.name
      ? `${model.displayName} · ${model.name}`
      : model.name,
  }));
  const label = translated
    ? pt(showingOriginal ? 'translationShowTranslation' : 'translationShowOriginal')
    : pt('translate');

  return <>
    <span className={`plugin-translation${compact ? ' compact' : ''}`}>
      <button
        type="button"
        className="plugin-translation-trigger"
        disabled={disabled || busy}
        onClick={activate}
        title={label}
      >
        {busy ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : <Languages size={13} aria-hidden="true" />}
        {busy ? pt('translationBusy') : label}
      </button>
      {translated ? <button type="button" className="plugin-translation-settings" disabled={disabled || busy} aria-label={pt('translationModel')} title={pt('translationModel')} onClick={() => openPicker()}><Settings2 size={13} /></button> : null}
      {error && !picking ? <span className="plugin-translation-error" role="alert">{error}</span> : null}
    </span>
    {picking ? createPortal(
      <div className="config-dialog-backdrop">
        <section ref={dialogRef} className="config-dialog plugin-translation-dialog" role="dialog" aria-modal="true" aria-labelledby="plugin-translation-title" aria-busy={busy} tabIndex={-1}>
          <header className="config-dialog-heading">
            <div><h2 id="plugin-translation-title"><Languages size={19} aria-hidden="true" />{pt('translateTitle')}</h2><p>{pt('translationModelHint')}</p></div>
            <button type="button" className="icon-button quiet" disabled={busy} aria-label={t('common.close')} onClick={() => setPicking(false)}><X size={18} /></button>
          </header>
          <div className="plugin-translation-body">
            <p className="plugin-translation-notice">{pt('translateDescription')}</p>
            <div className="plugin-translation-field">
              <label>{pt('translationModel')}</label>
              {modelsLoading
                ? <span className="plugin-translation-loading" role="status"><LoaderCircle size={15} className="spin" />{t('common.loading')}</span>
                : options.length
                  ? <SelectMenu value={selectedModel} options={options} onChange={setSelectedModel} ariaLabel={pt('translationModel')} disabled={busy} size="wide" overlay />
                  : <p className="plugin-translation-empty" role="alert">{modelsError || pt('translationNoModels')}</p>}
            </div>
            <blockquote className="plugin-translation-preview">{text.slice(0, 360)}{text.length > 360 ? '…' : ''}</blockquote>
            {error ? <p className="plugin-translation-error" role="alert">{error}</p> : null}
          </div>
          <footer className="plugin-translation-footer">
            <button type="button" className="secondary-button" disabled={busy} onClick={() => setPicking(false)}>{t('common.cancel')}</button>
            <button type="button" className="primary-button" disabled={busy || !selectedModel || modelsLoading || !options.length} onClick={() => void runTranslation(selectedModel, true)}>{busy ? <><LoaderCircle size={15} className="spin" />{pt('translationBusy')}</> : pt('translationStart')}</button>
          </footer>
        </section>
      </div>,
      document.body,
    ) : null}
  </>;
}
