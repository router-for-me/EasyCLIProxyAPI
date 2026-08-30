import { useState } from 'react';
import { useI18n } from '../i18n';
import { ApiAccessPage } from './ApiAccessPage';
import { AgentsPage } from './AgentsPage';
import { OAuthLoginPage } from './ManagementPages';

type AuthMethod = 'oauth' | 'api';
type SetupStep = 1 | 2;
type SetupView = 1 | 'oauth' | 'api' | 'agents';

const EASY_MODE_STATE_KEY = 'easy-cli-proxy-api.easy-mode.state';

type SavedEasyModeState = {
  authMethod: AuthMethod;
  providerReturnView: 1 | AuthMethod | null;
};

const defaultEasyModeState: SavedEasyModeState = {
  authMethod: 'oauth',
  providerReturnView: null,
};

function readSavedState(): SavedEasyModeState {
  try {
    const raw = window.localStorage.getItem(EASY_MODE_STATE_KEY);
    if (!raw) return defaultEasyModeState;
    const parsed = JSON.parse(raw) as {
      authMethod?: unknown;
      providerReturnView?: unknown;
    };
    return {
      authMethod: parsed.authMethod === 'api' ? 'api' : 'oauth',
      providerReturnView: parsed.providerReturnView === 1
        || parsed.providerReturnView === 'oauth'
        || parsed.providerReturnView === 'api'
        ? parsed.providerReturnView
        : null,
    };
  } catch {
    return defaultEasyModeState;
  }
}

function saveState(state: SavedEasyModeState) {
  try {
    window.localStorage.setItem(EASY_MODE_STATE_KEY, JSON.stringify(state));
  } catch {
    // Keep the selection in memory when persistent storage is unavailable.
  }
}

export function EasyModePage() {
  const { t } = useI18n();
  const initialState = readSavedState();
  const [authMethod, setAuthMethod] = useState<AuthMethod>(initialState.authMethod);
  const [providerReturnView, setProviderReturnView] = useState<SavedEasyModeState['providerReturnView']>(
    initialState.providerReturnView,
  );
  const [view, setView] = useState<SetupView>(1);

  const chooseAuthMethod = (method: AuthMethod) => {
    setAuthMethod(method);
    saveState({ authMethod: method, providerReturnView });
  };

  const openSelectedProvider = () => {
    setView(authMethod);
  };

  const leaveProviderForAgents = () => {
    const currentProviderView: 1 | AuthMethod = view === 1 || view === 'oauth' || view === 'api'
      ? view
      : providerReturnView ?? 1;
    setProviderReturnView(currentProviderView);
    saveState({ authMethod, providerReturnView: currentProviderView });
    setView('agents');
  };

  const previousView: SetupView | null = view === 'oauth' || view === 'api'
    ? 1
    : view === 'agents'
      ? providerReturnView ?? 1
      : null;
  const continueSetup = () => {
    if (view === 1) setView(authMethod);
    else if (view === 'oauth' || view === 'api') leaveProviderForAgents();
  };

  const openProgressStep = (step: SetupStep) => {
    if (step === 1) {
      setView(view === 'agents' ? providerReturnView ?? 1 : view === 'oauth' || view === 'api' ? view : 1);
    } else {
      leaveProviderForAgents();
    }
  };

  const stepTitles = [
    t('easyMode.overview.providerTitle'),
    t('easyMode.overview.agentTitle'),
  ];

  return (
    <section className="page simple-mode-page">
      <div className="simple-mode-progress" aria-label={t('easyMode.steps.label')}>
        {stepTitles.map((title, index) => {
          const step = (index + 1) as SetupStep;
          const active = step === 1
            ? view === 1 || view === 'oauth' || view === 'api'
            : view === 'agents';
          return (
            <button
              type="button"
              key={title}
              className={`simple-mode-progress-item${active ? ' active' : ''}`}
              aria-current={active ? 'step' : undefined}
              onClick={() => openProgressStep(step)}
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

      {view === 'oauth' || view === 'api' ? (
        <div className="simple-mode-provider-hint" role="note">
          {t(view === 'oauth' ? 'easyMode.oauth.nextHint' : 'easyMode.api.nextHint')}
        </div>
      ) : null}

      {view === 1 ? (
        <section className="panel simple-mode-task">
          <div className="simple-mode-task-heading">
            <div>
              <h2>{t('easyMode.overview.providerTitle')}</h2>
              <p>{t('easyMode.setup.providerDescription')}</p>
            </div>
          </div>
          <div className="simple-mode-choice-grid">
            <button
              type="button"
              className={`simple-mode-choice${authMethod === 'oauth' ? ' selected' : ''}`}
              aria-pressed={authMethod === 'oauth'}
              onClick={() => chooseAuthMethod('oauth')}
            >
              <strong>{t('easyMode.oauth.title')}</strong>
              <span>{t('easyMode.oauth.description')}</span>
            </button>
            <button
              type="button"
              className={`simple-mode-choice${authMethod === 'api' ? ' selected' : ''}`}
              aria-pressed={authMethod === 'api'}
              onClick={() => chooseAuthMethod('api')}
            >
              <strong>{t('easyMode.api.title')}</strong>
              <span>{t('easyMode.api.description')}</span>
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
