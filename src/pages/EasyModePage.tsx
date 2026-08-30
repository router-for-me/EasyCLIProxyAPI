import { useState } from 'react';
import { useI18n } from '../i18n';
import { ApiAccessPage } from './ApiAccessPage';
import { AgentsPage } from './AgentsPage';
import { OAuthLoginPage } from './ManagementPages';

type AuthMethod = 'oauth' | 'api';
type SetupStep = 1 | 2 | 3;
type SetupView = SetupStep | 'oauth' | 'api' | 'agents';

const EASY_MODE_STATE_KEY = 'easy-cli-proxy-api.easy-mode.state';

function readSavedAuthMethod(): AuthMethod {
  try {
    const raw = window.localStorage.getItem(EASY_MODE_STATE_KEY);
    if (!raw) return 'oauth';
    const parsed = JSON.parse(raw) as { authMethod?: unknown };
    return parsed.authMethod === 'api' ? 'api' : 'oauth';
  } catch {
    return 'oauth';
  }
}

function saveAuthMethod(authMethod: AuthMethod) {
  try {
    window.localStorage.setItem(EASY_MODE_STATE_KEY, JSON.stringify({ authMethod }));
  } catch {
    // Keep the selection in memory when persistent storage is unavailable.
  }
}

export function EasyModePage() {
  const { t } = useI18n();
  const [authMethod, setAuthMethod] = useState<AuthMethod>(readSavedAuthMethod);
  const [view, setView] = useState<SetupView>(1);

  const chooseAuthMethod = (method: AuthMethod) => {
    setAuthMethod(method);
    saveAuthMethod(method);
  };

  const openSelectedProvider = () => {
    setView(authMethod);
  };

  const openAgentSummary = () => {
    setView(3);
  };

  const openAgentConfiguration = () => {
    setView('agents');
  };

  const previousView: SetupView | null = view === 2
    ? 1
    : view === 'oauth' || view === 'api'
      ? 2
      : view === 3
        ? authMethod
        : view === 'agents'
          ? 3
          : null;
  const continueSetup = () => {
    if (view === 1) setView(2);
    else if (view === 2) openSelectedProvider();
    else if (view === 'oauth' || view === 'api') openAgentSummary();
    else if (view === 3) openAgentConfiguration();
  };

  const stepTitles = [
    t('easyMode.overview.coreTitle'),
    t('easyMode.overview.providerTitle'),
    t('easyMode.overview.agentTitle'),
  ];

  return (
    <section className="page simple-mode-page">
      <div className="simple-mode-progress" aria-label={t('easyMode.steps.label')}>
        {stepTitles.map((title, index) => {
          const step = (index + 1) as SetupStep;
          const active = step === 1
            ? view === 1
            : step === 2
              ? view === 2 || view === 'oauth' || view === 'api'
              : view === 3 || view === 'agents';
          return (
            <button
              type="button"
              key={title}
              className={`simple-mode-progress-item${active ? ' active' : ''}`}
              aria-current={active ? 'step' : undefined}
              onClick={() => setView(step)}
            >
              <span>
                <strong>{title}</strong>
              </span>
            </button>
          );
        })}
      </div>

      <div className="simple-mode-flow-navigation">
        {previousView !== null ? (
          <button
            type="button"
            className="secondary-button"
            onClick={() => setView(previousView)}
          >
            {t('easyMode.navigation.back')}
          </button>
        ) : null}
        {view !== 'agents' ? (
          <button
            type="button"
            className="primary-button"
            onClick={continueSetup}
          >
            {t('easyMode.navigation.next')}
          </button>
        ) : null}
      </div>

      {view === 1 ? (
        <section className="panel simple-mode-task">
          <div className="simple-mode-task-heading">
            <div>
              <h2>{t('easyMode.guide.title')}</h2>
              <p>{t('easyMode.guide.description')}</p>
            </div>
          </div>
          <div className="simple-mode-guide-grid" aria-label={t('easyMode.steps.label')}>
            <article className="simple-mode-guide-card">
              <strong>{t('easyMode.guide.step1Title')}</strong>
              <p>{t('easyMode.guide.step1Description')}</p>
            </article>
            <article className="simple-mode-guide-card">
              <strong>{t('easyMode.guide.step2Title')}</strong>
              <p>{t('easyMode.guide.step2Description')}</p>
            </article>
            <article className="simple-mode-guide-card">
              <strong>{t('easyMode.guide.step3Title')}</strong>
              <p>{t('easyMode.guide.step3Description')}</p>
            </article>
          </div>
        </section>
      ) : null}

      {view === 2 ? (
        <section className="panel simple-mode-task">
          <div className="simple-mode-choice-grid">
            <button
              type="button"
              className={`simple-mode-choice${authMethod === 'oauth' ? ' selected' : ''}`}
              aria-pressed={authMethod === 'oauth'}
              onClick={() => chooseAuthMethod('oauth')}
            >
              <strong>{t('easyMode.oauth.title')}</strong>
              <span>{t('easyMode.oauth.description')}</span>
              <small>{t('easyMode.provider.oauthFit')}</small>
            </button>
            <button
              type="button"
              className={`simple-mode-choice${authMethod === 'api' ? ' selected' : ''}`}
              aria-pressed={authMethod === 'api'}
              onClick={() => chooseAuthMethod('api')}
            >
              <strong>{t('easyMode.api.title')}</strong>
              <span>{t('easyMode.api.description')}</span>
              <small>{t('easyMode.provider.apiFit')}</small>
            </button>
          </div>
        </section>
      ) : null}

      {view === 'oauth' || view === 'api' ? (
        <section className="panel simple-mode-embedded-task">
          <div className="simple-mode-embedded-content">
            {view === 'oauth' ? <OAuthLoginPage /> : <ApiAccessPage />}
          </div>
        </section>
      ) : null}

      {view === 3 ? (
        <section className="panel simple-mode-task">
          <div className="simple-mode-action-card simple-mode-agent-card">
            <div>
              <strong>{t('easyMode.step3.cardTitle')}</strong>
              <p>{t('easyMode.step3.cardDescription')}</p>
            </div>
          </div>

          <ol className="simple-mode-checklist">
            <li><span>1</span><p>{t('easyMode.step3.step1')}</p></li>
            <li><span>2</span><p>{t('easyMode.step3.step2')}</p></li>
            <li><span>3</span><p>{t('easyMode.step3.step3')}</p></li>
          </ol>
        </section>
      ) : null}

      {view === 'agents' ? (
        <section className="panel simple-mode-embedded-task">
          <div className="simple-mode-embedded-content">
            <AgentsPage />
          </div>
        </section>
      ) : null}
    </section>
  );
}
