import { useState, useRef, useMemo, useCallback, useLayoutEffect, useEffect, useId, type KeyboardEvent } from 'react';
import { Check, ChevronDown, LoaderCircle, RefreshCw, Search, X } from 'lucide-react';
import { useI18n } from '../i18n';
import { agentModelAlias, filterAgentModels, findAgentModel } from '../services/agentModelPicker';
import type { ModelOption } from '../services/modelService';

// 复用主页面既有选择器，统一主模型和审批模型的交互及样式。
type AgentModelPickerProps = {
  models: ModelOption[];
  value: string;
  loading: boolean;
  error: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onRefresh: () => void;
  specialOptions?: Array<{ value: string; label: string }>;
  specialValue?: string;
  onSpecialChange?: (value: string) => void;
  exactModelIds?: boolean;
  ariaLabel?: string;
};

type AgentModelDropdownLayout = {
  top: number;
  left: number;
  width: number;
  height: number;
};

export function AgentModelPicker({
  models,
  value,
  loading,
  error,
  disabled,
  onChange,
  onRefresh,
  specialOptions = [],
  specialValue,
  onSpecialChange,
  exactModelIds = false,
  ariaLabel,
}: AgentModelPickerProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [dropdownLayout, setDropdownLayout] = useState<AgentModelDropdownLayout | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const visibleModels = useMemo(() => filterAgentModels(models, search), [models, search]);
  // 特殊选项单独携带类型，不占用任何真实模型 ID（包括同名模型）。
  const choices = [
    ...specialOptions.filter((option) => option.label.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
      .map((option) => ({ name: option.label, alias: '', special: option.value })),
    ...visibleModels.map((model) => ({ name: model.name, alias: model.alias ?? '', special: undefined })),
  ];
  const isSelected = (choice: typeof choices[number]) => choice.special !== undefined
    ? choice.special === specialValue
    : specialValue === undefined && (exactModelIds ? choice.name === value : choice.name.toLocaleLowerCase() === value.trim().toLocaleLowerCase());
  const selectedModel = exactModelIds ? models.find((model) => model.name === value) : findAgentModel(models, value);
  const selectedName = specialOptions.find((option) => option.value === specialValue)?.label ?? selectedModel?.name ?? '';
  const selectedAlias = specialValue === undefined && selectedName ? agentModelAlias(models, selectedName) : '';

  const updateDropdownLayout = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;

    const rect = root.getBoundingClientRect();
    const edgeGap = 12;
    const triggerGap = 6;
    const preferredHeight = 282;
    const minimumHeight = 150;
    const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - triggerGap - edgeGap);
    const spaceAbove = Math.max(0, rect.top - triggerGap - edgeGap);
    const placeAbove = spaceBelow < preferredHeight && spaceAbove > spaceBelow;
    const availableHeight = placeAbove ? spaceAbove : spaceBelow;
    const height = Math.min(preferredHeight, Math.max(minimumHeight, availableHeight));
    const width = Math.min(rect.width, window.innerWidth - edgeGap * 2);
    const left = Math.min(
      Math.max(edgeGap, rect.left),
      Math.max(edgeGap, window.innerWidth - edgeGap - width),
    );
    const desiredTop = placeAbove
      ? rect.top - triggerGap - height
      : rect.bottom + triggerGap;
    const top = Math.min(
      Math.max(edgeGap, desiredTop),
      Math.max(edgeGap, window.innerHeight - edgeGap - height),
    );

    setDropdownLayout({ top, left, width, height });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setDropdownLayout(null);
      return undefined;
    }

    updateDropdownLayout();
    window.addEventListener('resize', updateDropdownLayout);
    window.addEventListener('scroll', updateDropdownLayout, true);
    return () => {
      window.removeEventListener('resize', updateDropdownLayout);
      window.removeEventListener('scroll', updateDropdownLayout, true);
    };
  }, [open, updateDropdownLayout]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setSearch('');
    const selectedIndex = choices.findIndex(isSelected);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [open]);

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(choices.length - 1, 0)));
  }, [choices.length]);

  const choose = (choice: typeof choices[number]) => {
    if (choice.special !== undefined) onSpecialChange?.(choice.special);
    else onChange(choice.name);
    setOpen(false);
  };

  const moveActive = (offset: number) => {
    if (choices.length === 0) return;
    setActiveIndex((current) => (current + offset + choices.length) % choices.length);
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === 'Enter' && choices[activeIndex]) {
      event.preventDefault();
      choose(choices[activeIndex]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className={`agent-model-picker ${open ? 'open' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="agent-model-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (!open && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span>
          <strong title={selectedName || undefined}>
            {selectedName || (loading ? t('agents.model.loading') : error ? t('agents.model.loadFailed') : models.length ? t('agents.model.select') : t('agents.model.none'))}
          </strong>
          {selectedAlias ? <small title={selectedAlias}>{selectedAlias}</small> : null}
        </span>
        <ChevronDown size={17} aria-hidden />
      </button>

      {open ? (
        <div
          className="agent-model-dropdown"
          style={dropdownLayout
            ? dropdownLayout
            : { top: 0, left: 0, width: 0, height: 0, visibility: 'hidden' }}
        >
          <div className="agent-model-search">
            <Search size={15} aria-hidden />
            <input
              ref={searchRef}
              value={search}
              onChange={(event) => {
                setSearch(event.currentTarget.value);
                setActiveIndex(0);
              }}
              onKeyDown={handleSearchKeyDown}
              placeholder={t('agents.model.search')}
              role="combobox"
              aria-controls={listboxId}
              aria-expanded="true"
            />
            {search ? (
              <button
                type="button"
                className="icon-button quiet"
                onClick={() => {
                  setSearch('');
                  setActiveIndex(0);
                  searchRef.current?.focus();
                }}
                title={t('agents.model.clearSearch')}
              >
                <X size={14} />
              </button>
            ) : null}
            <button type="button" className="icon-button quiet" onClick={onRefresh} disabled={loading} title={t('agents.model.refresh')}>
              <RefreshCw size={14} className={loading ? 'spin' : ''} />
            </button>
          </div>

          <div className="agent-model-list" id={listboxId} role="listbox">
            {loading && models.length === 0 ? (
              <div className="agent-model-empty"><LoaderCircle size={18} className="spin" />{t('agents.model.fetching')}</div>
            ) : error && models.length === 0 ? (
              <div className="agent-model-empty error"><strong>{t('agents.model.loadFailed')}</strong><span>{error}</span></div>
            ) : choices.length === 0 ? (
              <div className="agent-model-empty">
                <strong>{search.trim() ? t('agents.model.noMatch') : t('agents.model.unavailable')}</strong>
                <span>{search.trim() ? t('agents.model.tryKeywords') : t('agents.model.connectFirst')}</span>
              </div>
            ) : choices.map((choice, index) => {
              const selected = isSelected(choice);
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`agent-model-option ${selected ? 'selected' : ''} ${index === activeIndex ? 'active' : ''}`}
                  key={choice.special !== undefined ? `special:${choice.special}` : `model:${choice.name}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(choice)}
                >
                  <span>
                    <strong title={choice.name}>{choice.name}</strong>
                    {choice.special === undefined ? <small>{choice.alias || t('agents.model.available')}</small> : null}
                  </span>
                  {selected ? <Check size={16} aria-hidden /> : null}
                </button>
              );
            })}
          </div>
          <div className="agent-model-dropdown-footer">
            <span>{t('agents.model.count', { count: models.length })}</span>
            {error && models.length > 0 ? <span className="error">{t('agents.model.stale')}</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
