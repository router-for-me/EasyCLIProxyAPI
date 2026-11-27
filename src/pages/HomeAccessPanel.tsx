import { useState } from 'react';
import { ArrowUpRight, Check, Copy, Eye, EyeOff } from 'lucide-react';
import openaiIcon from '../assets/icons/openai-light.svg';
import claudeIcon from '../assets/icons/claude.svg';
import geminiIcon from '../assets/icons/gemini.svg';
import { Tabs } from '../components/Tabs';
import type { ClientApiProfile } from '../services/clientAccess';
import { useI18n } from '../i18n';

type Props = {
  profiles: ClientApiProfile[];
  apiKey: string | null | undefined;
  keyError: boolean;
  ready: boolean;
  copiedField: string;
  onCopy: (value: string, field: string) => Promise<void>;
};

const icons = { openai: openaiIcon, claude: claudeIcon, gemini: geminiIcon };

export function HomeAccessPanel({ profiles, apiKey, keyError, ready, copiedField, onCopy }: Props) {
  const { t } = useI18n();
  const [active, setActive] = useState<ClientApiProfile['id']>('openai');
  const [showKey, setShowKey] = useState(false);
  const profile = profiles.find((item) => item.id === active) ?? profiles[0];
  if (!profile) return null;
  const copiedUrl = copiedField === `${profile.id}:base`;
  const copiedKey = copiedField === 'home:apikey';

  return (
    <section className="panel surface-panel home-access-panel" aria-labelledby="home-access-title">
      <div className="home-panel-heading">
        <div><h2 id="home-access-title">{t('home.access.title')}</h2></div>
        <span className={`home-connection-state ${ready ? 'ready' : ''}`}>
          <span aria-hidden="true" />{t(ready ? 'kernel.access.connectable' : 'kernel.access.waiting')}
        </span>
      </div>
      <Tabs className="home-protocol-tabs" aria-label={t('home.access.protocol')} value={profile.id} onChange={setActive}
        items={profiles.map(item => ({ value: item.id, id: `home-protocol-${item.id}`, panelId: 'home-protocol-panel', label: <><img src={icons[item.id]} alt="" />{item.name}</> }))} />
      <div id="home-protocol-panel" className={`surface-bare home-connection-details client-api-card ${profile.id}`} role="tabpanel" aria-labelledby={`home-protocol-${profile.id}`}>
        <div className="home-field-label"><span>{t('easyMode.api.baseUrl')}</span><span>{profile.description}</span></div>
        <div className="home-copy-field">
          <code title={profile.baseUrl}>{profile.baseUrl}</code>
          <button type="button" className={`icon-button quiet ghost small-button ${copiedUrl ? 'copied' : ''}`}
            onClick={() => void onCopy(profile.baseUrl, `${profile.id}:base`)}
            title={t(copiedUrl ? 'kernel.access.apiCopied' : 'kernel.access.copyApi', { name: profile.name })}
            aria-label={t(copiedUrl ? 'kernel.access.apiCopied' : 'kernel.access.copyApi', { name: profile.name })}
          >{copiedUrl ? <Check size={16} /> : <Copy size={16} />}</button>
        </div>
      </div>
      <div className="home-access-key">
        <div className="home-field-label">
          <span>{t('home.access.key')}</span>
          <button type="button" className="link-button home-inline-link" onClick={() => window.dispatchEvent(new CustomEvent('app:navigate', { detail: 'config' }))}>
            {t('home.access.manage')}<ArrowUpRight size={13} aria-hidden="true" />
          </button>
        </div>
        <div className="home-copy-field">
          {apiKey && !keyError ? <>
            <code className="home-key-value">{showKey ? apiKey : '••••••••••••••••••••'}</code>
            <button type="button" className="icon-button quiet ghost small-button" onClick={() => setShowKey((value) => !value)}
              aria-label={t(showKey ? 'config.keys.hide' : 'config.keys.show')} title={t(showKey ? 'config.keys.hide' : 'config.keys.show')}
            >{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button>
            <button type="button" className={`icon-button quiet ghost small-button ${copiedKey ? 'copied' : ''}`} onClick={() => void onCopy(apiKey, 'home:apikey')}
              aria-label={t(copiedKey ? 'config.notice.keyCopied' : 'config.keys.copy')} title={t(copiedKey ? 'config.notice.keyCopied' : 'config.keys.copy')}
            >{copiedKey ? <Check size={16} /> : <Copy size={16} />}</button>
          </> : <span className={keyError ? 'home-field-error' : 'home-field-empty'}>
            {t(keyError ? 'common.detectionFailed' : apiKey === null ? 'kernel.access.noConfiguredKey' : 'common.loading')}
          </span>}
        </div>
      </div>
    </section>
  );
}
