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
};

export function ClaudeCodeRoleRows({ routes, models, loading, error, disabled, onModelChange, onContextChange, onRefresh }: Props) {
  const { t } = useI18n();
  return <section className="claude-role-table" aria-label={t('agents.claudeCodeRuntime.modelMappings')}>
    <strong>{t('agents.claudeCodeRuntime.modelMappings')}</strong>
    {(['sonnet', 'opus', 'fable', 'haiku'] as const).map(role => <div className="claude-role-row" key={role} data-role={role}>
      <strong>{role[0].toUpperCase() + role.slice(1)}</strong>
      <AgentModelPicker preserveValue models={models} value={routes[role]} loading={loading} error={error}
        disabled={disabled} onChange={value => onModelChange(role, value)} onRefresh={onRefresh} />
      <label className="claude-inline-context">
        <span className="switch-control"><input type="checkbox" role="switch" checked={routes[`${role}1m`]} disabled={disabled}
          aria-label={`${role} 1M`} onChange={event => onContextChange(`${role}1m`, event.currentTarget.checked)} />
        <span className="switch-track" aria-hidden="true" /></span><span>1M</span>
      </label>
    </div>)}
  </section>;
}
