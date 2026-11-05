import { useEffect, useId, useState } from 'react';
import { FolderOpen, LoaderCircle, Monitor, RefreshCw, Terminal } from 'lucide-react';
import { SegmentedControl } from '../components/SegmentedControl';
import { Select } from '../components/Select';
import { Notice } from '../components/Notice';
import { useI18n } from '../i18n';
import { getAgentEnvironmentOptions, parseWslDirectory, type AgentEnvironmentOptions } from '../services/agentEnvironments';
import type { AgentClientId } from '../services/agents';

export function AgentEnvironmentDirectory({ client, directory, busy, onSave, onBrowse }: {
  client: AgentClientId;
  directory: string;
  busy: boolean;
  onSave: (directory: string) => void;
  onBrowse: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const savedWsl = parseWslDirectory(directory);
  const [environment, setEnvironment] = useState<'local' | 'wsl'>(savedWsl ? 'wsl' : 'local');
  const [options, setOptions] = useState<AgentEnvironmentOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [distro, setDistro] = useState(savedWsl?.distro ?? '');
  const [user, setUser] = useState(savedWsl?.user ?? '');
  const [draft, setDraft] = useState(directory);
  const [custom, setCustom] = useState(Boolean(directory && !savedWsl));
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    getAgentEnvironmentOptions(client).then(result => {
      if (!cancelled) setOptions(result);
    }).catch(() => {
      if (!cancelled) setFailed(true);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [client, revision]);
  useEffect(() => {
    setDraft(directory);
    const parsed = parseWslDirectory(directory);
    setEnvironment(parsed ? 'wsl' : 'local');
    setDistro(parsed?.distro ?? '');
    setUser(parsed?.user ?? '');
    setCustom(Boolean(directory && !parsed));
  }, [directory]);
  const distributions = options?.distributions ?? [];
  const distribution = distributions.find(item => item.name === distro) ?? distributions[0];
  const selectedUser = distribution?.users.find(item => item.name === user) ?? distribution?.users[0];
  const recommended = selectedUser?.directory ?? '';
  const saveRecommendation = (nextDistro: string, nextUser?: string) => {
    const selected = distributions.find(item => item.name === nextDistro);
    const home = selected?.users.find(item => item.name === nextUser) ?? selected?.users[0];
    setDistro(nextDistro);
    setUser(home?.name ?? '');
    setCustom(false);
    if (home) onSave(home.directory);
  };
  return <section className="agent-management-row agent-environment-directory">
    <div>
      <h3>{t('agents.environment.title')}</h3>
      <p>{t('agents.environment.description')}</p>
      <SegmentedControl className="agent-auth-segmented agent-environment-segments" buttonClassName="agent-auth-segmented-button" aria-label={t('agents.environment.title')}
        value={environment} disabled={busy} items={[
          { value: 'local', label: <><Monitor size={16} />{t(options?.supported ? 'agents.environment.windows' : 'agents.environment.local')}</> },
          { value: 'wsl', label: <><Terminal size={16} />{t('agents.environment.wsl')}</> },
        ]} onChange={value => {
          setEnvironment(value);
          setCustom(false);
          setDraft('');
          if (value === 'local') {
            if (savedWsl) onSave('');
          } else if (!loading && !failed && options?.supported && distribution && selectedUser) {
            saveRecommendation(distribution.name, selectedUser.name);
          }
        }} />
      {loading ? <div className="agent-environment-status"><Notice tone="info" variant="text" icon={<LoaderCircle size={16} className="spin" />}>{t('agents.environment.detecting')}</Notice></div> : null}
      {failed ? <div className="agent-environment-status"><Notice tone="warn" variant="text">{t('agents.environment.failed')}</Notice>
        <button type="button" className="secondary-button ghost" disabled={busy} onClick={() => setRevision(value => value + 1)}><RefreshCw size={14} />{t('agents.environment.retry')}</button>
      </div> : null}
      {environment === 'wsl' && !loading && !failed ? <>
        <div className="agent-environment-status"><Notice tone="info" variant="text">{t(!options?.supported ? 'agents.environment.unsupported'
          : !distributions.length ? 'agents.environment.empty' : 'agents.environment.wslHint')}</Notice>
          {options?.supported ? <button type="button" className="secondary-button ghost" disabled={busy} onClick={() => setRevision(value => value + 1)} aria-label={t('agents.environment.retry')}><RefreshCw size={14} /></button> : null}
        </div>
        {options?.supported && distributions.length ? <>
          <div className="agent-environment-selectors">
            <label htmlFor={`${id}-distro`}>{t('agents.environment.distribution')}
              <Select id={`${id}-distro`} value={distribution?.name ?? ''} disabled={busy} onChange={event => saveRecommendation(event.target.value)}>
                {distributions.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
              </Select>
            </label>
            <label htmlFor={`${id}-user`}>{t('agents.environment.user')}
              <Select id={`${id}-user`} value={selectedUser?.name ?? ''} disabled={busy || !distribution?.users.length}
                onChange={event => saveRecommendation(distribution!.name, event.target.value)}>
                {!distribution?.users.length ? <option value="">{t('agents.environment.noUsers')}</option> : null}
                {distribution?.users.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
              </Select>
            </label>
          </div>
          {recommended ? <div className="agent-environment-recommendation">
            <span>{t(directory === recommended ? 'agents.configDirectory.title' : 'agents.environment.recommended')}</span><code>{recommended}</code>
            {!selectedUser?.exists ? <small>{t('agents.environment.notCreated')}</small> : null}
            {directory !== recommended ? <button type="button" className="secondary-button" disabled={busy} onClick={() => saveRecommendation(distribution!.name, selectedUser?.name)}>{t('agents.environment.use')}</button> : null}
          </div> : <Notice tone="warn" variant="text">{t('agents.environment.noUsersHint')}</Notice>}
        </> : null}
      </> : null}
      {environment !== 'wsl' || directory !== recommended || !recommended ? <div className="agent-environment-current">
        <span>{t('agents.configDirectory.title')}</span>
        <code>{directory || options?.defaultDirectory || t('agents.configDirectory.placeholder')}</code>
      </div> : null}
      <details className="agent-environment-custom" open={custom} onToggle={event => setCustom(event.currentTarget.open)}>
        <summary>{t('agents.environment.custom')}</summary>
        <p>{t('agents.configDirectory.description')}</p>
        <div className="agent-environment-input">
          <input className="config-network-input" aria-label={t('agents.environment.custom')} value={draft} disabled={busy}
            placeholder={environment === 'local' ? options?.defaultDirectory : t('agents.environment.customPlaceholder')}
            onChange={event => setDraft(event.target.value)} />
          <button type="button" className="secondary-button" onClick={onBrowse} disabled={busy}><FolderOpen size={16} />{t('agents.configDirectory.browse')}</button>
          <button type="button" className="primary-button" onClick={() => onSave(draft.trim())}
            disabled={busy || draft.trim() === directory || (environment === 'wsl' && !parseWslDirectory(draft.trim()))}>{t('agents.configDirectory.save')}</button>
        </div>
        {environment === 'local' && directory ? <button type="button" className="secondary-button ghost" disabled={busy} onClick={() => onSave('')}>{t('agents.configDirectory.clear')}</button> : null}
      </details>
    </div>
  </section>;
}
