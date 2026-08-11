import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { Check, ChevronDown } from 'lucide-react';

export type AppSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

type AppSelectProps = {
  value: string;
  options: AppSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
};

export const nextEnabledOptionIndex = (
  options: AppSelectOption[],
  currentIndex: number,
  direction: 1 | -1,
) => {
  if (options.length === 0) return -1;
  const start = currentIndex >= 0 ? currentIndex : direction === 1 ? -1 : 0;
  for (let offset = 1; offset <= options.length; offset += 1) {
    const index = (start + direction * offset + options.length) % options.length;
    if (!options[index]?.disabled) return index;
  }
  return -1;
};

export function AppSelect({
  value,
  options,
  onChange,
  ariaLabel,
  className = '',
  disabled = false,
}: AppSelectProps) {
  const [open, setOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();
  const selectedIndex = useMemo(
    () => options.findIndex((option) => option.value === value),
    [options, value],
  );
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const selectedLabel = selectedOption?.label ?? value;

  const openMenu = () => {
    if (disabled || options.length === 0) return;
    const initialIndex = selectedIndex >= 0 && !options[selectedIndex]?.disabled
      ? selectedIndex
      : nextEnabledOptionIndex(options, -1, 1);
    setHighlightedIndex(initialIndex);
    setOpen(true);
  };

  const closeMenu = () => setOpen(false);

  const selectOption = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    if (option.value !== value) onChange(option.value);
    closeMenu();
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      closeMenu();
      return;
    }
    if (event.key === 'Tab') {
      closeMenu();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setHighlightedIndex((current) => nextEnabledOptionIndex(options, current, direction));
      return;
    }
    if (open && (event.key === 'Home' || event.key === 'End')) {
      event.preventDefault();
      const index = event.key === 'Home'
        ? nextEnabledOptionIndex(options, -1, 1)
        : nextEnabledOptionIndex(options, 0, -1);
      setHighlightedIndex(index);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) selectOption(highlightedIndex);
      else openMenu();
    }
  };

  useEffect(() => {
    if (!open) return;

    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closeMenu();
    };
    const updatePlacement = () => {
      const bounds = rootRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const spaceBelow = window.innerHeight - bounds.bottom;
      setOpenUpward(spaceBelow < 250 && bounds.top > spaceBelow);
    };

    updatePlacement();
    document.addEventListener('pointerdown', closeOnOutsideClick);
    window.addEventListener('resize', updatePlacement);
    window.addEventListener('scroll', updatePlacement, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      window.removeEventListener('resize', updatePlacement);
      window.removeEventListener('scroll', updatePlacement, true);
    };
  }, [open]);

  useEffect(() => {
    if (open && highlightedIndex >= 0) {
      optionRefs.current[highlightedIndex]?.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightedIndex, open]);

  useEffect(() => {
    if (disabled) closeMenu();
  }, [disabled]);

  return (
    <div
      ref={rootRef}
      className={`app-select ${open ? 'open' : ''} ${openUpward ? 'open-upward' : ''} ${className}`.trim()}
    >
      <button
        type="button"
        className="app-select-trigger"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && highlightedIndex >= 0 ? `${listboxId}-option-${highlightedIndex}` : undefined}
        onClick={() => open ? closeMenu() : openMenu()}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="app-select-value" title={selectedLabel}>{selectedLabel}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {open ? (
        <div className="app-select-menu" id={listboxId} role="listbox" aria-label={ariaLabel}>
          {options.map((option, index) => (
            <button
              key={`${option.value}-${index}`}
              ref={(element) => { optionRefs.current[index] = element; }}
              id={`${listboxId}-option-${index}`}
              type="button"
              role="option"
              tabIndex={-1}
              disabled={option.disabled}
              aria-selected={option.value === value}
              className={`app-select-option ${index === highlightedIndex ? 'highlighted' : ''} ${option.value === value ? 'selected' : ''}`.trim()}
              onMouseEnter={() => !option.disabled && setHighlightedIndex(index)}
              onClick={() => selectOption(index)}
            >
              <span title={option.label}>{option.label}</span>
              {option.value === value ? <Check size={15} aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
