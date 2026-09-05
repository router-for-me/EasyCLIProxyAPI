import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  Check,
  Copy,
  ExternalLink,
  LoaderCircle,
  LogIn,
  RefreshCw,
} from 'lucide-react';
import antigravityIcon from '../assets/icons/antigravity.svg';
import claudeIcon from '../assets/icons/claude.svg';
import codexIcon from '../assets/icons/codex.svg';
import grokIcon from '../assets/icons/grok.svg';
import kimiIcon from '../assets/icons/kimi-light.svg';
import { useI18n } from '../i18n';
import { oauthSubpages, type OAuthSubpage } from '../oauthNavigation';
import {
  changedOAuthAuthFileNames,
  snapshotAuthFiles,
  type AuthFileSnapshot,
} from '../services/authFiles';
import { managementApi, responseList } from '../services/managementApi';
import {
  createOAuthLoginSuccessCache,
  shouldShowOAuthLoginStatus,
} from '../services/oauthLoginState';
import { AuthFileManagementPage } from './AuthFileManagementPage';
import { QuotaPage } from './QuotaPage';

type OAuthProviderId = 'codex' | 'claude' | 'antigravity' | 'kimi' | 'xai';
type OAuthFlowStatus = 'idle' | 'waiting' | 'success' | 'error';

type OAuthProviderState = {
  url?: string;
  state?: string;
  status: OAuthFlowStatus;
  error?: string;
  polling?: boolean;
  callbackUrl?: string;
  callbackSubmitting?: boolean;
  callbackStatus?: 'success' | 'error';
  callbackError?: string;
  refreshing?: boolean;
};

type OAuthStartResult = {
  url: string;
  state?: string | null;
  opened: boolean;
  openError?: string | null;
};

type OAuthBrowserOption = {
  id: string;
  label: string;
};

type OAuthStatusResult = {
  status: string;
  error?: string | null;
};

const oauthProviders = [
  { id: 'codex' as const, name: 'Codex OAuth', icon: codexIcon },
  { id: 'claude' as const, name: 'Claude OAuth', icon: claudeIcon },
  { id: 'antigravity' as const, name: 'Antigravity OAuth', icon: antigravityIcon },
  { id: 'kimi' as const, name: 'Kimi OAuth', icon: kimiIcon },
  { id: 'xai' as const, name: 'xAI OAuth', icon: grokIcon },
];

const OAUTH_CALLBACK_SUPPORTED = new Set<OAuthProviderId>([
  'codex',
  'claude',
  'antigravity',
  'xai',
]);
const XAI_CALLBACK_URL = 'http://127.0.0.1:56121/callback';
const OAUTH_POLL_INTERVAL_MS = 3000;
const OAUTH_BROWSER_STORAGE_KEY = 'easy-cli-proxy-api.oauth-browser.v3';
const NO_AUTO_OPEN_BROWSER_ID = 'none';
const oauthLoginSuccessCache = createOAuthLoginSuccessCache<OAuthProviderId>();

const resolveOAuthBrowserSelection = (
  available: OAuthBrowserOption[],
  preferred: string,
): string => {
  if (preferred === NO_AUTO_OPEN_BROWSER_ID) return preferred;
  if (available.some((browser) => browser.id === preferred)) return preferred;
  return available.find((browser) => browser.id !== 'default')?.id
    ?? available.find((browser) => browser.id === 'default')?.id
    ?? NO_AUTO_OPEN_BROWSER_ID;
};

const loadOAuthBrowserPreference = (): string => {
  try {
    return window.localStorage.getItem(OAUTH_BROWSER_STORAGE_KEY)?.trim() || '';
  } catch {
    return '';
  }
};

const cachedOAuthProviderStates = (): Partial<Record<OAuthProviderId, OAuthProviderState>> => (
  oauthLoginSuccessCache.snapshot().reduce<Partial<Record<OAuthProviderId, OAuthProviderState>>>(
    (states, provider) => ({ ...states, [provider]: { status: 'success' } }),
    {},
  )
);

export type OAuthSubpageRequest = { subpage: OAuthSubpage; nonce: number };

export function OAuthManagementPage({ requestedSubpage }: { requestedSubpage?: OAuthSubpageRequest | null }) {
  const { t } = useI18n();
  const [activeSubpage, setActiveSubpage] = useState<OAuthSubpage>(requestedSubpage?.subpage ?? 'login');

  useEffect(() => {
    if (requestedSubpage) {
      setActiveSubpage(requestedSubpage.subpage);
    }
  }, [requestedSubpage]);

  return (
    <section className="page oauth-management-page">
      <div
        className="agent-subpage-tabs oauth-subpage-tabs"
        role="tablist"
        aria-label={t('oauth.tabs.label')}
      >
        {oauthSubpages.map((subpage) => {
          const active = activeSubpage === subpage.id;
          return (
            <button
              type="button"
              id={`oauth-subpage-tab-${subpage.id}`}
              key={subpage.id}
              role="tab"
              className={active ? 'active' : ''}
              aria-selected={active}
              aria-controls={`oauth-subpage-panel-${subpage.id}`}
              tabIndex={active ? 0 : -1}
              onClick={() => setActiveSubpage(subpage.id)}
            >
              {t(subpage.labelKey)}
            </button>
          );
        })}
      </div>

      <div
        className="oauth-subpage-panel"
        id={`oauth-subpage-panel-${activeSubpage}`}
        role="tabpanel"
        aria-labelledby={`oauth-subpage-tab-${activeSubpage}`}
      >
        {activeSubpage === 'login' ? <OAuthLoginPage /> : null}
        {activeSubpage === 'authFiles' ? <AuthFileManagementPage /> : null}
        {activeSubpage === 'quota' ? <QuotaPage /> : null}
      </div>
    </section>
  );
}

export function OAuthLoginPage() {
  const { t } = useI18n();
  const [states, setStates] = useState<Partial<Record<OAuthProviderId, OAuthProviderState>>>(
    cachedOAuthProviderStates,
  );
  const [notice, setNotice] = useState<{
    message: string;
    tone: 'success' | 'error' | 'info';
  } | null>(null);
  const [browsers, setBrowsers] = useState<OAuthBrowserOption[]>([]);
  const [browsersLoading, setBrowsersLoading] = useState(true);
  const [selectedBrowser, setSelectedBrowser] = useState(loadOAuthBrowserPreference);
  const pollingTimers = useRef<Partial<Record<OAuthProviderId, number>>>({});
  const pollingRequests = useRef<Partial<Record<OAuthProviderId, boolean>>>({});
  const credentialSnapshots = useRef<Partial<Record<OAuthProviderId, AuthFileSnapshot>>>({});
  const noticeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let active = true;
    void invoke<OAuthBrowserOption[]>('list_oauth_browsers')
      .then((available) => {
        if (!active) return;
        setBrowsers(available);
        setSelectedBrowser((current) => resolveOAuthBrowserSelection(available, current));
      })
      .catch((error) => {
        if (!active) return;
        console.warn('Failed to detect installed browsers', error);
        const fallback = [{ id: 'default', label: 'System Default' }];
        setBrowsers(fallback);
        setSelectedBrowser((current) => resolveOAuthBrowserSelection(fallback, current));
      })
      .finally(() => {
        if (active) setBrowsersLoading(false);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(OAUTH_BROWSER_STORAGE_KEY, selectedBrowser);
    } catch {
      // Keep the in-memory selection when persistent storage is unavailable.
    }
  }, [selectedBrowser]);

  const showNotice = useCallback((message: string, tone: 'success' | 'error' | 'info') => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    setNotice({ message, tone });
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice(null);
      noticeTimerRef.current = null;
    }, 3600);
  }, []);

  const updateProviderState = useCallback(
    (provider: OAuthProviderId, next: Partial<OAuthProviderState>) => {
      setStates((current) => ({
        ...current,
        [provider]: {
          status: 'idle',
          ...(current[provider] ?? {}),
          ...next,
        },
      }));
    },
    [],
  );

  const clearPollingTimer = useCallback((provider: OAuthProviderId) => {
    const timer = pollingTimers.current[provider];
    if (timer !== undefined) window.clearInterval(timer);
    delete pollingTimers.current[provider];
    delete pollingRequests.current[provider];
  }, []);

  const completeProviderAuth = useCallback(
    (provider: OAuthProviderId) => {
      clearPollingTimer(provider);
      oauthLoginSuccessCache.mark(provider);
      updateProviderState(provider, {
        url: undefined,
        state: undefined,
        status: 'success',
        error: undefined,
        polling: false,
        callbackUrl: '',
        callbackSubmitting: false,
        callbackStatus: undefined,
        callbackError: undefined,
      });
    },
    [clearPollingTimer, updateProviderState],
  );

  const captureCredentialSnapshot = useCallback(async (provider: OAuthProviderId) => {
    const payload = await managementApi.get('/auth-files');
    credentialSnapshots.current[provider] = snapshotAuthFiles(responseList(payload, 'files'));
  }, []);

  const applyDefaultCredentialPriority = useCallback(async (provider: OAuthProviderId) => {
    const before = credentialSnapshots.current[provider];
    delete credentialSnapshots.current[provider];
    if (!before) return;

    const payload = await managementApi.get('/auth-files');
    const names = changedOAuthAuthFileNames(before, responseList(payload, 'files'), provider);
    await Promise.all(names.map((name) => managementApi.patch('/auth-files/fields', {
      name,
      priority: 0,
    })));
  }, []);

  const startPolling = useCallback(
    (provider: OAuthProviderId, state: string) => {
      clearPollingTimer(provider);
      const checkStatus = async () => {
        if (pollingRequests.current[provider]) return;
        pollingRequests.current[provider] = true;
        try {
          const result = await invoke<OAuthStatusResult>('get_oauth_status', { state });
          const status = (result.status || '').toLowerCase();
          if (status === 'ok') {
            let priorityError = '';
            try {
              await applyDefaultCredentialPriority(provider);
            } catch (error) {
              priorityError = String(error);
            }
            completeProviderAuth(provider);
            showNotice(
              priorityError
                ? t('oauth.priorityApplyFailed', { error: priorityError })
                : t('oauth.loginSuccess', { provider: providerLabel(provider) }),
              priorityError ? 'error' : 'success',
            );
          } else if (status === 'error') {
            updateProviderState(provider, {
              status: 'error',
              error: result.error || t('oauth.authFailed'),
              polling: false,
            });
            clearPollingTimer(provider);
            showNotice(
              t('oauth.loginFailed', {
                provider: providerLabel(provider),
                detail: result.error ? `: ${result.error}` : '',
              }),
              'error',
            );
          }
        } catch (error) {
          updateProviderState(provider, {
            status: 'error',
            error: String(error),
            polling: false,
          });
          clearPollingTimer(provider);
          showNotice(String(error), 'error');
        } finally {
          delete pollingRequests.current[provider];
        }
      };
      pollingTimers.current[provider] = window.setInterval(
        () => void checkStatus(),
        OAUTH_POLL_INTERVAL_MS,
      );
    },
    [applyDefaultCredentialPriority, clearPollingTimer, completeProviderAuth, showNotice, t, updateProviderState],
  );

  useEffect(() => {
    return () => {
      Object.values(pollingTimers.current).forEach((timer) => {
        if (timer !== undefined) window.clearInterval(timer);
      });
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    };
  }, []);

  const startLogin = async (provider: OAuthProviderId) => {
    clearPollingTimer(provider);
    updateProviderState(provider, {
      url: undefined,
      state: undefined,
      status: 'waiting',
      polling: true,
      error: undefined,
      callbackUrl: '',
      callbackStatus: undefined,
      callbackError: undefined,
    });

    try {
      await captureCredentialSnapshot(provider);
      const result = await invoke<OAuthStartResult>('start_oauth_login', {
        provider,
        browser: selectedBrowser,
      });
      if (!result.state) {
        updateProviderState(provider, {
          url: result.url,
          state: undefined,
          status: 'error',
          error: t('oauth.missingState'),
          polling: false,
        });
        showNotice(t('oauth.missingStatePolling'), 'error');
        return;
      }

      updateProviderState(provider, {
        url: result.url,
        state: result.state,
        status: 'waiting',
        polling: true,
      });
      startPolling(provider, result.state);

      if (!result.opened) {
        showNotice(
          result.openError
            ? t('oauth.openFailedDetail', { error: result.openError })
            : t('oauth.openFailed'),
          'info',
        );
      }
    } catch (error) {
      delete credentialSnapshots.current[provider];
      updateProviderState(provider, {
        status: 'error',
        error: String(error),
        polling: false,
      });
      showNotice(String(error), 'error');
    }
  };

  const refreshLoginLink = async (provider: OAuthProviderId) => {
    const currentState = states[provider]?.state;
    clearPollingTimer(provider);
    updateProviderState(provider, { refreshing: true });
    try {
      if (currentState) {
        await managementApi.delete('/oauth-session', { query: { state: currentState } });
      }
    } catch (error) {
      console.warn('Failed to cancel the previous OAuth session before refreshing', error);
    }
    try {
      await startLogin(provider);
    } finally {
      updateProviderState(provider, { refreshing: false });
    }
  };

  const openAuthUrl = async (url?: string) => {
    if (!url) return;
    try {
      await invoke('open_oauth_url', {
        url,
        browser: selectedBrowser === NO_AUTO_OPEN_BROWSER_ID ? 'default' : selectedBrowser,
      });
    } catch (error) {
      showNotice(String(error), 'error');
    }
  };

  const copyAuthUrl = async (url?: string) => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      showNotice(t('oauth.linkCopied'), 'success');
    } catch {
      showNotice(t('oauth.linkCopyFailed'), 'error');
    }
  };

  const submitCallback = async (provider: OAuthProviderId) => {
    const current = states[provider];
    const callbackInput = (current?.callbackUrl || '').trim();
    if (!callbackInput) {
      showNotice(
        provider === 'xai' ? t('oauth.pasteXaiCallback') : t('oauth.pasteCallback'),
        'error',
      );
      return;
    }

    const redirectUrl = resolveCallbackUrl(provider, callbackInput, current?.state);
    if (!redirectUrl) {
      showNotice(
        provider === 'xai'
          ? t('oauth.invalidXaiCallback')
          : t('oauth.invalidCallback'),
        'error',
      );
      return;
    }

    updateProviderState(provider, {
      callbackSubmitting: true,
      callbackStatus: undefined,
      callbackError: undefined,
    });
    try {
      await invoke('submit_oauth_callback', { provider, redirectUrl });
      updateProviderState(provider, {
        callbackSubmitting: false,
        callbackStatus: 'success',
      });
      showNotice(t('oauth.callbackSubmittedNotice'), 'success');
    } catch (error) {
      updateProviderState(provider, {
        callbackSubmitting: false,
        callbackStatus: 'error',
        callbackError: String(error),
      });
      showNotice(String(error), 'error');
    }
  };

  return (
    <section className="page management-page">
      <header className="management-header">
        <div><span>OAuth</span><h1>{t('oauth.title')}</h1></div>
        <label className="oauth-browser-picker">
          <span>{t('oauth.browser.label')}</span>
          <select
            value={selectedBrowser}
            onChange={(event) => setSelectedBrowser(event.currentTarget.value)}
            aria-label={t('oauth.browser.label')}
            disabled={browsersLoading}
          >
            {browsersLoading ? <option value="">{t('oauth.browser.detecting')}</option> : null}
            {browsers.map((browser) => (
              <option value={browser.id} key={browser.id}>
                {browser.id === 'default' ? t('oauth.browser.systemDefault') : browser.label}
              </option>
            ))}
            <option value={NO_AUTO_OPEN_BROWSER_ID}>{t('oauth.browser.noAutoOpen')}</option>
          </select>
          <small>{t('oauth.browser.remembered')}</small>
        </label>
      </header>

      {notice ? (
        <div className={`inline-notice ${notice.tone === 'error' ? 'error' : notice.tone === 'success' ? 'success' : ''}`}>
          {notice.message}
        </div>
      ) : null}

      <div className="oauth-grid">
        {oauthProviders.map((provider) => {
          const state = states[provider.id] ?? { status: 'idle' as const };
          const canSubmitCallback = OAUTH_CALLBACK_SUPPORTED.has(provider.id) && Boolean(state.url);
          const loginLabel = state.status === 'success'
            ? t('oauth.loginAnother')
            : state.polling
              ? t('oauth.loggingIn')
              : t('oauth.startLogin');

          return (
            <section className="panel oauth-card" key={provider.id}>
              <div className="provider-title-row">
                <img src={provider.icon} alt="" className="provider-logo" />
                <div>
                  <h2>{provider.name}</h2>
                  {shouldShowOAuthLoginStatus(state.status) ? (
                    <span className="state-pill success">{t('oauth.status.completed')}</span>
                  ) : null}
                </div>
              </div>

              <div className="oauth-card-body">
                <p className="oauth-hint">{t('oauth.hint')}</p>
                {state.url ? (
                  <div className="oauth-auth-url-box">
                    <div className="oauth-auth-url-label">{t('oauth.authorizationLink')}</div>
                    <div className="oauth-auth-url-value" title={state.url}>{state.url}</div>
                    <div className="oauth-auth-url-actions">
                      <button type="button" className="secondary-button compact-button" onClick={() => void copyAuthUrl(state.url)}>
                        <Copy size={15} aria-hidden="true" />{t('oauth.copyLink')}
                      </button>
                      <button type="button" className="secondary-button compact-button" onClick={() => void openAuthUrl(state.url)}>
                        <ExternalLink size={15} aria-hidden="true" />{t('oauth.openLink')}
                      </button>
                    </div>
                  </div>
                ) : null}

                {canSubmitCallback ? (
                  <div className="oauth-callback-block">
                    <div className="oauth-callback-row">
                      <input
                        value={state.callbackUrl ?? ''}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          updateProviderState(provider.id, {
                            callbackUrl: value,
                            callbackStatus: undefined,
                            callbackError: undefined,
                          });
                        }}
                        placeholder={provider.id === 'xai' ? t('oauth.xaiCallbackPlaceholder') : t('oauth.callbackPlaceholder')}
                      />
                      <button type="button" className="secondary-button" disabled={state.callbackSubmitting} onClick={() => void submitCallback(provider.id)}>
                        {state.callbackSubmitting ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
                        {t('oauth.submitCallback')}
                      </button>
                    </div>
                    {state.callbackStatus === 'success' && state.status === 'waiting' ? (
                      <div className="oauth-inline-status success">{t('oauth.callbackSubmitted')}</div>
                    ) : null}
                    {state.callbackStatus === 'error' ? (
                      <div className="oauth-inline-status error">{t('oauth.callbackFailed', { detail: state.callbackError ? `: ${state.callbackError}` : '' })}</div>
                    ) : null}
                  </div>
                ) : null}

                {state.status === 'error' && state.error ? (
                  <div className="oauth-inline-status error">{state.error}</div>
                ) : null}
              </div>

              <div className="button-row management-card-actions">
                <button type="button" className="primary-button" disabled={Boolean(state.polling) || browsersLoading} onClick={() => void startLogin(provider.id)}>
                  {state.polling ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <LogIn size={16} aria-hidden="true" />}
                  {loginLabel}
                </button>
                {state.url ? (
                  <button type="button" className="secondary-button" disabled={browsersLoading || state.refreshing} onClick={() => void refreshLoginLink(provider.id)}>
                    <RefreshCw size={16} className={state.refreshing ? 'spin' : undefined} aria-hidden="true" />
                    {state.refreshing ? t('oauth.refreshingLink') : t('oauth.refreshLink')}
                  </button>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}

function providerLabel(provider: OAuthProviderId) {
  return oauthProviders.find((item) => item.id === provider)?.name ?? provider;
}

function isAbsoluteUrl(value: string) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function readQueryLikeCallbackInput(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const queryStart = trimmed.indexOf('?');
  const hashStart = trimmed.indexOf('#');
  const rawParams = queryStart >= 0
    ? trimmed.slice(queryStart + 1)
    : hashStart >= 0
      ? trimmed.slice(hashStart + 1)
      : trimmed;
  if (!/(^|[&#?])(code|state|error)=/i.test(rawParams)) return null;
  return new URLSearchParams(rawParams.replace(/^[?#]/, ''));
}

function buildXaiCallbackUrl(input: string, state?: string) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (isAbsoluteUrl(trimmed)) return trimmed;
  const params = readQueryLikeCallbackInput(trimmed);
  if (params) {
    const callbackState = params.get('state')?.trim() || state?.trim();
    if (!callbackState) return null;
    const callbackUrl = new URL(XAI_CALLBACK_URL);
    callbackUrl.searchParams.set('state', callbackState);
    for (const key of ['code', 'error', 'error_description']) {
      const value = params.get(key)?.trim();
      if (value) callbackUrl.searchParams.set(key, value);
    }
    return callbackUrl.toString();
  }
  const code = (trimmed.match(/\bcode\s*[:=]\s*([^\s&]+)/i)?.[1] ?? trimmed).trim();
  const callbackState = state?.trim();
  if (!code || !callbackState) return null;
  const callbackUrl = new URL(XAI_CALLBACK_URL);
  callbackUrl.searchParams.set('code', code);
  callbackUrl.searchParams.set('state', callbackState);
  return callbackUrl.toString();
}

function resolveCallbackUrl(provider: OAuthProviderId, input: string, state?: string) {
  return provider === 'xai' ? buildXaiCallbackUrl(input, state) : input.trim();
}
