import { useEffect, useState } from 'react';
import { useCoreRuntime } from '../coreRuntime';
import { useI18n } from '../i18n';

export type EasyModeDestination = 'home' | 'oauth' | 'api' | 'agents';

type AuthMethod = 'oauth' | 'api';
type EasyModeStep = 1 | 2 | 3;

type SavedEasyModeState = {
  authMethod: AuthMethod | null;
  step: EasyModeStep;
};

const EASY_MODE_STATE_KEY = 'easy-cli-proxy-api.easy-mode.state';

const defaultState: SavedEasyModeState = {
  authMethod: null,
  step: 1,
};

function readSavedState(): SavedEasyModeState {
  try {
    const raw = window.localStorage.getItem(EASY_MODE_STATE_KEY);
    if (!raw) return defaultState;
    const parsed = JSON.parse(raw) as Partial<SavedEasyModeState>;
    const authMethod = parsed.authMethod === 'oauth' || parsed.authMethod === 'api'
      ? parsed.authMethod
      : null;
    const step = parsed.step === 2 || parsed.step === 3 ? parsed.step : 1;
    return { authMethod, step: authMethod ? step : 1 };
  } catch {
    return defaultState;
  }
}

function saveState(state: SavedEasyModeState) {
  try {
    window.localStorage.setItem(EASY_MODE_STATE_KEY, JSON.stringify(state));
  } catch {
    // Keep the wizard usable when persistent storage is unavailable.
  }
}

export function EasyModePage({
  onOpenPage,
}: {
  onOpenPage: (page: EasyModeDestination) => void;
}) {
  const { t } = useI18n();
  const { status: coreStatus } = useCoreRuntime();
  const [wizardState, setWizardState] = useState<SavedEasyModeState>(readSavedState);
  const coreRunning = Boolean(coreStatus?.running);

  useEffect(() => {
    saveState(wizardState);
  }, [wizardState]);

  const chooseAuthMethod = (authMethod: AuthMethod) => {
    setWizardState((current) => ({ ...current, authMethod, step: 1 }));
  };

  const goToStep = (step: EasyModeStep) => {
    if (!wizardState.authMethod && step !== 1) return;
    setWizardState((current) => ({ ...current, step }));
  };

  const resetWizard = () => setWizardState(defaultState);

  const openAuthPage = () => {
    if (!coreRunning || !wizardState.authMethod) return;
    onOpenPage(wizardState.authMethod);
  };

  const authTitle = wizardState.authMethod === 'oauth'
    ? t('easyMode.oauth.title')
    : t('easyMode.api.title');
  const authAction = wizardState.authMethod === 'oauth'
    ? t('easyMode.oauth.action')
    : t('easyMode.api.action');
  const authSteps = wizardState.authMethod === 'oauth'
    ? [t('easyMode.oauth.step1'), t('easyMode.oauth.step2'), t('easyMode.oauth.step3')]
    : [t('easyMode.api.step1'), t('easyMode.api.step2'), t('easyMode.api.step3')];
  const stepTitles = [
    t('easyMode.step1.title'),
    t('easyMode.step2.title'),
    t('easyMode.step3.title'),
  ];

  return (
    <section className="page simple-mode-page">
      <header className="simple-mode-header">
        <div>
          <span className="simple-mode-eyebrow">{t('easyMode.eyebrow')}</span>
          <h1>{t('easyMode.title')}</h1>
          <p>{t('easyMode.description')}</p>
        </div>
        <button type="button" className="secondary-button simple-mode-reset" onClick={resetWizard}>
          {t('easyMode.reset')}
        </button>
      </header>

      {!coreRunning ? (
        <div className="simple-mode-core-alert" role="status">
          <div>
            <strong>{t('easyMode.core.title')}</strong>
            <p>{t('easyMode.core.description')}</p>
          </div>
          <button type="button" className="secondary-button" onClick={() => onOpenPage('home')}>
            {t('easyMode.core.action')}
          </button>
        </div>
      ) : null}

      <div className="simple-mode-progress" role="list" aria-label={t('easyMode.steps.label')}>
        {stepTitles.map((title, index) => {
          const step = (index + 1) as EasyModeStep;
          const active = wizardState.step === step;
          const complete = wizardState.step > step;
          const locked = !wizardState.authMethod && step > 1;
          return (
            <button
              type="button"
              role="listitem"
              key={title}
              className={`simple-mode-progress-item${active ? ' active' : ''}${complete ? ' complete' : ''}`}
              aria-current={active ? 'step' : undefined}
              disabled={locked}
              onClick={() => goToStep(step)}
            >
              <span className="simple-mode-progress-number">{step}</span>
              <span>
                <small>{t('easyMode.step', { number: step })}</small>
                <strong>{title}</strong>
              </span>
            </button>
          );
        })}
      </div>

      {wizardState.step === 1 ? (
        <section className="panel simple-mode-task">
          <div className="simple-mode-task-heading">
            <span className="simple-mode-task-number">1</span>
            <div>
              <h2>{t('easyMode.step1.title')}</h2>
              <p>{t('easyMode.step1.description')}</p>
            </div>
          </div>
          <p className="simple-mode-instruction">{t('easyMode.step1.selectHint')}</p>

          <div className="simple-mode-choice-grid">
            <button
              type="button"
              className={`simple-mode-choice${wizardState.authMethod === 'oauth' ? ' selected' : ''}`}
              aria-pressed={wizardState.authMethod === 'oauth'}
              onClick={() => chooseAuthMethod('oauth')}
            >
              <strong>{t('easyMode.oauth.title')}</strong>
              <span>{t('easyMode.oauth.description')}</span>
            </button>
            <button
              type="button"
              className={`simple-mode-choice${wizardState.authMethod === 'api' ? ' selected' : ''}`}
              aria-pressed={wizardState.authMethod === 'api'}
              onClick={() => chooseAuthMethod('api')}
            >
              <strong>{t('easyMode.api.title')}</strong>
              <span>{t('easyMode.api.description')}</span>
            </button>
          </div>

          <div className="simple-mode-task-footer">
            <span className={wizardState.authMethod ? 'simple-mode-selection' : 'simple-mode-selection muted'}>
              {wizardState.authMethod
                ? t('easyMode.selectedPath') + `：${authTitle}`
                : t('easyMode.step1.selectFirst')}
            </span>
            <button
              type="button"
              className="primary-button"
              disabled={!wizardState.authMethod}
              onClick={() => goToStep(2)}
            >
              {t('easyMode.step1.continue')}
            </button>
          </div>
        </section>
      ) : null}

      {wizardState.step === 2 && wizardState.authMethod ? (
        <section className="panel simple-mode-task">
          <div className="simple-mode-task-heading">
            <span className="simple-mode-task-number">2</span>
            <div>
              <h2>{t('easyMode.step2.title')}</h2>
              <p>{t('easyMode.step2.description')}</p>
            </div>
          </div>

          <div className="simple-mode-path-row">
            <span>{t('easyMode.selectedPath')}</span>
            <strong>{authTitle}</strong>
            <button type="button" className="text-button" onClick={() => goToStep(1)}>
              {t('easyMode.changePath')}
            </button>
          </div>

          <div className="simple-mode-action-card">
            <div>
              <strong>{t('easyMode.step2.openTitle')}</strong>
              <p>{t('easyMode.step2.returnHint')}</p>
            </div>
            <button type="button" className="primary-button" disabled={!coreRunning} onClick={openAuthPage}>
              {authAction}
            </button>
          </div>

          <ol className="simple-mode-checklist">
            {authSteps.map((item, index) => (
              <li key={item}>
                <span>{index + 1}</span>
                <p>{item}</p>
              </li>
            ))}
          </ol>

          <div className="simple-mode-task-footer">
            <span className="simple-mode-selection muted">{t('easyMode.step2.doneHint')}</span>
            <button type="button" className="secondary-button" onClick={() => goToStep(3)}>
              {t('easyMode.step2.complete')}
            </button>
          </div>
          {!coreRunning ? <p className="simple-mode-warning">{t('easyMode.core.blocked')}</p> : null}
        </section>
      ) : null}

      {wizardState.step === 3 && wizardState.authMethod ? (
        <section className="panel simple-mode-task">
          <div className="simple-mode-task-heading">
            <span className="simple-mode-task-number">3</span>
            <div>
              <h2>{t('easyMode.step3.title')}</h2>
              <p>{t('easyMode.step3.description')}</p>
            </div>
          </div>

          <div className="simple-mode-action-card simple-mode-agent-card">
            <div>
              <strong>{t('easyMode.step3.cardTitle')}</strong>
              <p>{t('easyMode.step3.cardDescription')}</p>
            </div>
            <span className="simple-mode-ready-label">{t('easyMode.step3.ready')}</span>
          </div>

          <ol className="simple-mode-checklist">
            <li><span>1</span><p>{t('easyMode.step3.step1')}</p></li>
            <li><span>2</span><p>{t('easyMode.step3.step2')}</p></li>
            <li><span>3</span><p>{t('easyMode.step3.step3')}</p></li>
          </ol>

          <div className="simple-mode-task-footer">
            <span className="simple-mode-selection muted">{t('easyMode.step3.note')}</span>
            <div className="simple-mode-actions">
              <button type="button" className="primary-button" disabled={!coreRunning} onClick={() => onOpenPage('agents')}>
                {t('easyMode.step3.action')}
              </button>
              <button type="button" className="secondary-button" onClick={() => goToStep(2)}>
                {t('easyMode.step3.back')}
              </button>
            </div>
          </div>
        </section>
      ) : null}

      <footer className="simple-mode-footer">{t('easyMode.footer')}</footer>
    </section>
  );
}
