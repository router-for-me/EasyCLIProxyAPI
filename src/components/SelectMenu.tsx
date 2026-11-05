import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import './SelectMenu.css';

export type SelectMenuOption = {
  value: string;
  label: string;
  group?: string;
  disabled?: boolean;
};

type MenuLayout = {
  top: number;
  left: number;
  width: number;
  height: number;
};

const measureMenu = (menu: HTMLDivElement) => {
  const list = menu.querySelector<HTMLDivElement>('.select-menu-list');
  const scrollTop = list?.scrollTop ?? 0;
  const scrollLeft = list?.scrollLeft ?? 0;
  const menuStyle = menu.getAttribute('style');
  const optionButtons = [...menu.querySelectorAll<HTMLButtonElement>('.select-menu-option')];
  const optionStyles = optionButtons.map((option) => option.getAttribute('style'));
  menu.style.width = 'max-content';
  menu.style.maxWidth = 'none';
  menu.style.height = 'auto';
  menu.style.maxHeight = 'none';
  menu.style.visibility = 'hidden';
  optionButtons.forEach((option) => {
    option.style.width = 'max-content';
    option.style.maxWidth = 'none';
    option.style.gridTemplateColumns = 'max-content 16px';
  });
  const rect = menu.getBoundingClientRect();
  if (menuStyle === null) menu.removeAttribute('style');
  else menu.setAttribute('style', menuStyle);
  optionButtons.forEach((option, index) => {
    const style = optionStyles[index];
    if (style === null) option.removeAttribute('style');
    else option.setAttribute('style', style);
  });
  // Measuring the unconstrained list can clamp its scroll offsets to zero.
  if (list) {
    list.scrollTop = scrollTop;
    list.scrollLeft = scrollLeft;
  }
  return { width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
};

export function SelectMenu({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  className,
  maxDropdownHeight = 280,
}: {
  value: string;
  options: SelectMenuOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
  maxDropdownHeight?: number;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [layout, setLayout] = useState<MenuLayout | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const themeScopeRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const selected = options.find((option) => option.value === value) ?? options[0];

  const updateLayout = useCallback(() => {
    const root = rootRef.current;
    const themeScope = themeScopeRef.current;
    const menu = menuRef.current;
    if (!root) return;
    // Inherit scoped variables without overriding the overlay's opaque material palette.
    if (themeScope) {
      // Replace the snapshot so tokens removed by the next theme cannot linger.
      themeScope.style.cssText = '';
      const style = getComputedStyle(root);
      for (const name of style) {
        if (name.startsWith('--')) themeScope.style.setProperty(name, style.getPropertyValue(name));
      }
    }
    const rect = root.getBoundingClientRect();
    const edgeGap = 12;
    const triggerGap = 6;
    const measured = menu ? measureMenu(menu) : null;
    const contentWidth = Math.max(rect.width, measured && measured.width > 0 ? measured.width : 0);
    const measuredHeight = measured && measured.height > 0
      ? measured.height
      : Math.max(options.length, 1) * 36 + 12;
    const contentHeight = Math.min(measuredHeight, maxDropdownHeight);
    const spaceBelow = Math.max(0, window.innerHeight - edgeGap - rect.bottom - triggerGap);
    const spaceAbove = Math.max(0, rect.top - triggerGap - edgeGap);
    const placeAbove = spaceBelow < contentHeight && spaceAbove > spaceBelow;
    const available = placeAbove ? spaceAbove : spaceBelow;
    const maxWidth = Math.max(edgeGap, window.innerWidth - edgeGap * 2);
    const width = Math.min(maxWidth, Math.max(rect.width, Math.min(360, contentWidth)));
    const height = Math.max(36, Math.min(contentHeight, available));
    const maxLeft = Math.max(edgeGap, window.innerWidth - edgeGap - width);
    const left = Math.min(Math.max(edgeGap, rect.left), maxLeft);
    const desiredTop = placeAbove ? rect.top - triggerGap - height : rect.bottom + triggerGap;
    const top = Math.min(Math.max(edgeGap, desiredTop), Math.max(edgeGap, window.innerHeight - edgeGap - height));
    setLayout({ top, left, width, height });
  }, [options.length, maxDropdownHeight]);

  useLayoutEffect(() => {
    if (!open) {
      setLayout(null);
      return undefined;
    }
    updateLayout();
    const handleScroll = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      updateLayout();
    };
    const themeObserver = new MutationObserver(updateLayout);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'data-theme', 'data-theme-id'],
    });
    window.addEventListener('resize', updateLayout);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      themeObserver.disconnect();
      window.removeEventListener('resize', updateLayout);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [open, updateLayout]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: Event) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('focusin', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('focusin', close);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const selectedIndex = options.findIndex((option) => option.value === value);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
  }, [open, options, value]);

  useEffect(() => {
    if (!open) return;
    const option = menuRef.current?.querySelector<HTMLElement>(`#${listboxId}-option-${activeIndex}`);
    option?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, listboxId]);

  const choose = (next: string) => {
    const target = options.find((opt) => opt.value === next);
    if (target?.disabled) return;
    onChange(next);
    setOpen(false);
    rootRef.current?.querySelector('button')?.focus();
  };

  const moveActive = (offset: number) => {
    if (!options.length) return;
    let nextIndex = activeIndex;
    for (let step = 0; step < options.length; step += 1) {
      nextIndex = (nextIndex + offset + options.length) % options.length;
      if (!options[nextIndex]?.disabled) {
        setActiveIndex(nextIndex);
        return;
      }
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!open && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      setOpen(true);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(-1);
    } else if ((event.key === 'Enter' || event.key === ' ') && options[activeIndex] && !options[activeIndex].disabled) {
      event.preventDefault();
      choose(options[activeIndex].value);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div className={`select-menu ${open ? 'open' : ''}${className ? ` ${className}` : ''}`} ref={rootRef}>
      <button
        type="button"
        className="select-menu-trigger"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open && options[activeIndex] ? `${listboxId}-option-${activeIndex}` : undefined}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleKeyDown}
      >
        <strong title={selected?.label}>{selected?.label ?? ''}</strong>
        <ChevronDown size={16} aria-hidden />
      </button>
      {open ? createPortal(
        <div className="select-menu-theme-scope" ref={themeScopeRef}>
          <div
            ref={menuRef}
            className={`select-menu-dropdown${className ? ` ${className}-dropdown` : ''}`}
            data-theme-surface="overlay"
            style={layout
              ? { top: layout.top, left: layout.left, width: layout.width, height: layout.height }
              : { top: 0, left: 0, width: 0, height: 0, visibility: 'hidden' }}
          >
            <div className="select-menu-list" id={listboxId} role="listbox" aria-label={ariaLabel}>
              {options.map((option, index) => {
                const isSelected = option.value === value;
                return (
                  <Fragment key={option.value || option.label}>
                    {option.group && option.group !== options[index - 1]?.group ? (
                      <div className="select-menu-group-label" role="presentation">{option.group}</div>
                    ) : null}
                    <button
                      type="button"
                      role="option"
                      id={`${listboxId}-option-${index}`}
                      aria-selected={isSelected}
                      aria-disabled={option.disabled}
                      disabled={option.disabled}
                      aria-label={option.group ? `${option.group}: ${option.label}` : undefined}
                      className={`select-menu-option${isSelected ? ' selected' : ''}${index === activeIndex ? ' active' : ''}${option.disabled ? ' disabled' : ''}`}
                      key={option.value || option.label}
                      onMouseEnter={() => !option.disabled && setActiveIndex(index)}
                      onClick={() => !option.disabled && choose(option.value)}
                    >
                      <span title={option.label}>{option.label}</span>
                      {isSelected ? <Check size={15} aria-hidden /> : null}
                    </button>
                  </Fragment>
                );
              })}
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
