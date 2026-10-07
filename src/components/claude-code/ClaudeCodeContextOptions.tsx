import { useI18n } from '../../i18n';
import { claudeCodeRoles, claudeCodeRole, claudeCodeModelBase, type ClaudeCodeRoutes } from '../../services/claudeCodeModels';

type Props = {
  routes: ClaudeCodeRoutes;
  startupModel: string;
  subagentModel: string;
  disabled: boolean;
  onRoleChange: (field: 'opus1m' | 'sonnet1m' | 'haiku1m', enabled: boolean) => void;
  onModelChange: (field: 'startupModel' | 'subagentModel', value: string) => void;
};

export function ClaudeCodeContextOptions({ routes, startupModel, subagentModel, disabled, onRoleChange, onModelChange }: Props) {
  const { t } = useI18n();
  return (
    <fieldset className="claude-code-context-options">
      <legend>{t('agents.claudeCodeRuntime.extendedContext')}</legend>
      <p>{t('agents.claudeCodeRuntime.selectionHint')}</p>
      <div>
        {claudeCodeRoles.map(role => (
          <label key={role}>
            <input type="checkbox" checked={routes[`${role}1m`]} disabled={disabled}
              onChange={event => onRoleChange(`${role}1m`, event.currentTarget.checked)} />
            <span>{role[0].toUpperCase() + role.slice(1)}</span>
          </label>
        ))}
        {(['startupModel', 'subagentModel'] as const).map(field => {
          const value = field === 'startupModel' ? startupModel : subagentModel;
          if (!value.trim() || claudeCodeRole(value)) return null;
          return <label key={field}>
            <input type="checkbox" checked={/\[1m\]$/i.test(value.trim())} disabled={disabled}
              onChange={event => onModelChange(field, claudeCodeModelBase(value) + (event.currentTarget.checked ? '[1m]' : ''))} />
            <span>{t(`agents.claudeCodeRuntime.${field}`)}</span>
          </label>;
        })}
      </div>
    </fieldset>
  );
}
