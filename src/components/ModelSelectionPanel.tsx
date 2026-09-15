import { useId, useMemo, useRef, useState } from 'react';
import { ArrowRight, Search, X } from 'lucide-react';
import { useI18n } from '../i18n';
import { modelSearchText, type ModelOption } from '../services/modelService';

type ModelSelectionPanelProps = {
  models: ModelOption[];
  selected: boolean;
  loading: boolean;
  onMove: (models: ModelOption[], selected: boolean) => void;
};

export function ModelSelectionPanel({ models, selected, loading, onMove }: ModelSelectionPanelProps) {
  const { t } = useI18n();
  const titleId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const query = search.trim().toLowerCase();
  const visibleModels = useMemo(() => models.filter((model) =>
    modelSearchText(model).includes(query),
  ), [models, query]);
  const searchLabel = t(selected ? 'apiAccess.modelDialog.searchSelected' : 'apiAccess.modelDialog.searchUnselected');

  return (
    <section className="model-transfer-panel" aria-labelledby={titleId} aria-busy={loading}>
      <div className="model-transfer-panel-heading">
        <h3 id={titleId}>{t(selected ? 'apiAccess.modelDialog.selected' : 'apiAccess.modelDialog.unselected')}</h3>
        <span className="model-transfer-count">{query ? `${visibleModels.length} / ${models.length}` : models.length}</span>
        <button
          type="button"
          className="secondary-button compact-button"
          onClick={() => onMove(visibleModels, !selected)}
          disabled={loading || visibleModels.length === 0}
        >
          {t(selected
            ? query ? 'apiAccess.modelDialog.removeResults' : 'apiAccess.modelDialog.removeAll'
            : query ? 'apiAccess.modelDialog.addResults' : 'apiAccess.modelDialog.addAll')}
        </button>
      </div>
      <div className="model-transfer-search">
        <Search size={15} aria-hidden="true" />
        <input ref={searchRef} value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder={searchLabel} aria-label={searchLabel} />
        {search ? (
          <button type="button" className="icon-button quiet" onClick={() => { setSearch(''); searchRef.current?.focus(); }} aria-label={t('apiAccess.modelDialog.clearSearch')}>
            <X size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <div className="model-transfer-list">
        {visibleModels.length ? visibleModels.map((model) => (
          <button
            type="button"
            className="model-transfer-row"
            key={model.name}
            disabled={loading}
            aria-label={t(selected ? 'apiAccess.modelDialog.removeModel' : 'apiAccess.modelDialog.addModel', { name: model.name })}
            onClick={(event) => {
              if (event.detail === 0) {
                const next = event.currentTarget.nextElementSibling ?? event.currentTarget.previousElementSibling;
                if (next instanceof HTMLElement) next.focus();
                else searchRef.current?.focus();
              }
              onMove([model], !selected);
            }}
          >
            <span><strong title={model.name}>{model.name}</strong>{model.alias || model.displayName ? <small title={model.alias || model.displayName}>{model.alias || model.displayName}</small> : null}</span>
            {selected ? <X size={16} aria-hidden="true" /> : <ArrowRight size={16} aria-hidden="true" />}
          </button>
        )) : (
          <div className="model-transfer-empty">
            {t(query ? 'apiAccess.modelDialog.noMatch' : loading ? 'apiAccess.modelDialog.fetching' : selected ? 'apiAccess.modelDialog.emptySelected' : 'apiAccess.modelDialog.emptyUnselected')}
          </div>
        )}
      </div>
    </section>
  );
}
