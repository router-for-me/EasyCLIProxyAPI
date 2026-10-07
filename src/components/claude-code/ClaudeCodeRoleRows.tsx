import { useI18n } from '../../i18n';
import { AgentModelPicker } from '../AgentModelPicker';
import type { ModelOption } from '../../services/modelService';
import { claudeCodeRoles, type ClaudeCodeRoutes } from '../../services/claudeCodeModels';
import './ClaudeCodeModelInputs.css';

type Role = typeof claudeCodeRoles[number];
type Props = {
  routes: ClaudeCodeRoutes;
  models: ModelOption[];
  loading: boolean;
  error: string;
  disabled: boolean;
  onModelChange: (role: Role, value: string) => void;
  onContextChange: (field: `${Role}1m`, value: boolean) => void;
  onRefresh: () => void;
  onApplyAll: () => void;
};

export function ClaudeCodeRoleRows({ routes, models, loading, error, disabled, onModelChange, onContextChange, onRefresh, onApplyAll }: Props) {
  const { t } = useI18n();
  return <section className="claude-role-table" aria-label={t('agents.claudeCodeRuntime.roleMappings')}>
    <div className="claude-role-toolbar">
      <strong>{t('agents.claudeCodeRuntime.roleMappings')}</strong>
      <button type="button" className="secondary-button" disabled={disabled || !routes.sonnet}
        onClick={onApplyAll}>{t('agents.claudeCodeRuntime.applySonnetToRoles')}</button>
    </div>
    <p>{t('agents.claudeCodeRuntime.roleRowsHint')}</p>
    {(['sonnet', 'opus', 'haiku'] as const).map(role => <div className="claude-role-row" key={role} data-role={role}>
      <strong>{role[0].toUpperCase() + role.slice(1)}</strong>
      <AgentModelPicker preserveValue models={models} value={routes[role]} loading={loading} error={error}
        disabled={disabled} onChange={value => onModelChange(role, value)} onRefresh={onRefresh} />
      <label className="claude-inline-context">
        <input type="checkbox" checked={routes[`${role}1m`]} disabled={disabled}
          aria-label={`${role} 1M`} onChange={event => onContextChange(`${role}1m`, event.currentTarget.checked)} />
        1M
      </label>
    </div>)}
  </section>;
}
