import { useEffect, useId, useRef } from 'react';
import { useI18n } from '../i18n';

export function SystemPromptField({ value, onChange, hint, disabled, invalid }: {
  value: string;
  onChange: (value: string) => void;
  hint: string;
  disabled: boolean;
  invalid?: boolean;
}) {
  const { t } = useI18n();
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (invalid) textarea.current?.focus();
  }, [invalid]);
  return (
    <div className="agent-prompt-field">
      <label htmlFor={id}>{t('agents.systemPrompt.fieldLabel')}</label>
      <textarea
        ref={textarea}
        id={id}
        rows={12}
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={`${id}-hint`}
      />
      <small id={`${id}-hint`}>{hint}</small>
    </div>
  );
}
