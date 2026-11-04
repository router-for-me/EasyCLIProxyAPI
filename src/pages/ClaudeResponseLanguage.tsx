import { useState } from 'react';
import { Select } from '../components/Select';
import { useI18n } from '../i18n';
import { claudeResponseLanguageMode, claudeResponseLanguageOptions } from '../services/claudeResponseLanguage';

export function ClaudeResponseLanguage({ value, disabled, onChange }: {
  value: string | null | undefined;
  disabled: boolean;
  onChange: (value: string | null) => void;
}) {
  const { t, locale } = useI18n();
  const [custom, setCustom] = useState(false);
  const mode = custom ? 'custom' : claudeResponseLanguageMode(value);
  return (
    <div className="agent-claude-code-number-field claude-response-language">
      <label htmlFor="claude-response-language">{t('agents.responseLanguage.label')}</label>
      <Select id="claude-response-language" value={mode} disabled={disabled}
        aria-describedby="claude-response-language-hint"
        onChange={(event) => {
          const selection = event.currentTarget.value;
          setCustom(selection === 'custom');
          onChange(selection === 'custom' ? value ?? '' : selection === 'unmanaged' ? null : selection === 'default' ? '' : selection);
        }}>
        <option value="unmanaged">{t('agents.responseLanguage.unmanaged')}</option>
        <option value="default">{t('agents.responseLanguage.default')}</option>
        <option value="custom">{t('agents.responseLanguage.custom')}</option>
        {claudeResponseLanguageOptions(locale).map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </Select>
      {mode === 'custom' ? (
        <input type="text" value={value ?? ''} disabled={disabled}
          aria-label={t('agents.responseLanguage.custom')}
          aria-describedby="claude-response-language-hint"
          onChange={(event) => onChange(event.currentTarget.value)} />
      ) : null}
      <small id="claude-response-language-hint">{t('agents.responseLanguage.hint')}</small>
    </div>
  );
}
