import { claudeCodeModelBase, claudeCodeRoles, claudeCodeModelPreview, isKnownClaudeCodeModel, type ClaudeCodeRoutes } from '../../services/claudeCodeModels';
import { useI18n } from '../../i18n';
import { AgentModelPicker } from '../AgentModelPicker';
import type { ModelOption } from '../../services/modelService';
import './ClaudeCodeModelInputs.css';

type Props = {
  startupModel: string;
  subagentModel: string;
  models: ModelOption[];
  routes: ClaudeCodeRoutes;
  loading: boolean;
  disabled: boolean;
  onChange: (field: 'startupModel' | 'subagentModel', value: string) => void;
};

export function ClaudeCodeModelInputs({ startupModel, subagentModel, models, routes, loading, disabled, onChange }: Props) {
  const { t } = useI18n();
  const options = [
    ...claudeCodeRoles.map(role => ({ name: role, alias: t('agents.claudeCodeRuntime.followRole', {
      role, model: claudeCodeModelPreview(role, routes).model || '—',
    }) })),
    ...models.filter(model => !claudeCodeRoles.some(role => role === model.name.toLowerCase()))
      .map(model => ({ ...model, alias: t('agents.claudeCodeRuntime.directOption') })),
  ];
  return (
    <div className="claude-code-model-inputs">
      {(['startupModel', 'subagentModel'] as const).map((field) => {
        const value = field === 'startupModel' ? startupModel || 'opus' : subagentModel;
        const preview = claudeCodeModelPreview(value, routes);
        return (
        <div className="claude-code-model-field" key={field}>
          <strong>{t(`agents.claudeCodeRuntime.${field}`)}</strong>
          <div className="claude-model-with-context">
          <AgentModelPicker
            models={options}
            value={value}
            onChange={(value) => onChange(field, field === 'startupModel' ? value.trim() || 'opus' : value)}
            disabled={disabled}
            loading={loading}
            allowCustomValue
            emptyOption={field === 'subagentModel' ? t('agents.claudeCodeRuntime.subagentModelPlaceholder') : undefined}
            editable={{ label: t(`agents.claudeCodeRuntime.${field}`),
              placeholder: t(`agents.claudeCodeRuntime.${field}Placeholder`), maxLength: 240 }}
          />
          <label className="claude-inline-context">
            <span className="switch-control"><input type="checkbox" role="switch" aria-label={`${t(`agents.claudeCodeRuntime.${field}`)} 1M`}
              checked={preview.context1m} disabled={disabled || !value.trim() || Boolean(preview.role)}
              onChange={event => onChange(field, claudeCodeModelBase(value) + (event.currentTarget.checked ? '[1m]' : ''))} />
            <span className="switch-track" aria-hidden="true" /></span><span>1M</span>
          </label>
          </div>
          {preview.role && <small className="claude-code-model-summary" aria-live="polite">{preview.role} → {preview.model}</small>}
          {!loading && !isKnownClaudeCodeModel(value, models) ? (
            <small role="status">{t('agents.claudeCodeRuntime.unverifiedModel')}</small>
          ) : null}
        </div>
      ); })}
    </div>
  );
}
