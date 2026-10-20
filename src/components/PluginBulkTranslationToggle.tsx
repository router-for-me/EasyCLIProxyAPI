import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Languages, LoaderCircle, X } from 'lucide-react';
import { useDialogFocusTrap } from './useDialogFocusTrap';
import { SelectMenu, type SelectMenuOption } from './SelectMenu';
import { useI18n } from '../i18n';
import { pluginText } from '../i18n/plugins';
import {
  loadPluginTranslationModels, rememberPluginTranslationModel, savedPluginTranslationModel,
  type PluginTranslationModel,
} from '../services/pluginTranslation';

export function PluginBulkTranslationToggle({ active, count, disabled, onToggle }: {
  active: boolean;
  count: number;
  disabled: boolean;
  onToggle: (active: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const pt = (key: Parameters<typeof pluginText>[0]) => pluginText(key, locale);
  const [picking, setPicking] = useState(false);
  const [models, setModels] = useState<PluginTranslationModel[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useDialogFocusTrap<HTMLElement>({ active: picking, onEscape: () => setPicking(false) });

  const openPicker = async () => {
    setPicking(true); setLoading(true); setError('');
    try {
      const next = await loadPluginTranslationModels();
      setModels(next);
      const saved = savedPluginTranslationModel();
      setSelectedModel(next.some(model => model.name === saved) ? saved : next[0]?.name ?? '');
      if (!next.length) setError(pt('translationNoModels'));
    } catch (reason) {
      setModels([]); setSelectedModel('');
      setError(reason instanceof Error ? reason.message : pt('translationNoModels'));
    } finally { setLoading(false); }
  };

  const activate = () => {
    if (active) { onToggle(false); return; }
    if (savedPluginTranslationModel()) onToggle(true);
    else void openPicker();
  };

  const options: SelectMenuOption[] = models.map(model => ({
    value: model.name,
    label: model.displayName && model.displayName !== model.name ? `${model.displayName} · ${model.name}` : model.name,
  }));

  return <>
    <button type="button" className={`button bulk-translate${active ? ' active' : ''}`} disabled={disabled || loading} aria-pressed={active} onClick={activate}>
      <Languages size={15} aria-hidden="true" />{pt(active ? 'showOriginalAll' : 'translateAll')}{count ? ` · ${count}` : ''}
    </button>
    {picking ? createPortal(
      <div className="config-dialog-backdrop">
        <section ref={dialogRef} className="config-dialog plugin-translation-dialog" role="dialog" aria-modal="true" aria-labelledby="bulk-translation-title" tabIndex={-1}>
          <header className="config-dialog-heading"><div><h2 id="bulk-translation-title"><Languages size={19} aria-hidden="true" />{pt('bulkTranslationTitle')}</h2><p>{pt('bulkTranslationHint')}</p></div><button type="button" className="icon-button quiet" aria-label={t('common.close')} onClick={() => setPicking(false)}><X size={18} /></button></header>
          <div className="plugin-translation-body">
            <p className="plugin-translation-notice">{pt('translateDescription')}</p>
            <div className="plugin-translation-field"><label>{pt('translationModel')}</label>{loading ? <span className="plugin-translation-loading"><LoaderCircle size={15} className="spin" />{t('common.loading')}</span> : options.length ? <SelectMenu value={selectedModel} options={options} onChange={setSelectedModel} ariaLabel={pt('translationModel')} size="wide" overlay /> : <p className="plugin-translation-empty" role="alert">{error || pt('translationNoModels')}</p>}</div>
            {error && options.length ? <p className="plugin-translation-error" role="alert">{error}</p> : null}
          </div>
          <footer className="plugin-translation-footer"><button type="button" className="secondary-button" onClick={() => setPicking(false)}>{t('common.cancel')}</button><button type="button" className="primary-button" disabled={!selectedModel || loading} onClick={() => { rememberPluginTranslationModel(selectedModel); setPicking(false); onToggle(true); }}>{pt('translationStart')}</button></footer>
        </section>
      </div>,
      document.body,
    ) : null}
  </>;
}
