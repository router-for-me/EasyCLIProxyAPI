import { Notice } from '../components/Notice';
import {
  hidePluginWebview,
  resolvePluginEntryPath,
  showPluginWebview,
  setPluginWebviewBounds,
  EMPTY_BOUNDS,
  effectiveBounds,
  newWebviewToken,
  roundBounds,
  type WebviewBounds,
} from '../services/pluginWebview';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ExternalLink, RefreshCw } from 'lucide-react';
import { useI18n } from '../i18n';
import { pluginText } from '../i18n/plugins';
import { useOverlayOpen } from '../components/useOverlayOpen';
import type { PluginNavEntry } from '../services/pluginNavigation';
import { useRuntimeCapabilities } from '../services/platform';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function WebPluginFramePage({ entry, reloadToken }: { entry: PluginNavEntry; reloadToken: number }) {
  const { t, locale } = useI18n();
  const pt = (key: Parameters<typeof pluginText>[0]) => pluginText(key, locale);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [entryPath, setEntryPath] = useState<string>('');
  const [frameKey, setFrameKey] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setError('');
    resolvePluginEntryPath({ pluginId: entry.pluginID, menuIndex: entry.menuIndex })
      .then((path) => {
        if (!cancelled) {
          setEntryPath(path);
          setFrameKey((value) => value + 1);
        }
      })
      .catch((reason) => {
        if (!cancelled) setError(message(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [entry.pluginID, entry.menuIndex, reloadToken, attempt]);

  const handleBack = () => {
    try {
      iframeRef.current?.contentWindow?.history.back();
    } catch {
      // Fallback when iframe navigation history is unavailable.
    }
  };

  const handleReload = () => {
    try {
      iframeRef.current?.contentWindow?.location.reload();
    } catch {
      setFrameKey((value) => value + 1);
    }
  };

  const handleOpenExternal = () => {
    if (!entryPath) return;
    window.open(entryPath, '_blank', 'noopener,noreferrer');
  };

  return (
    <section className="page plugin-resource-page">
      <h1 className="sr-only">{entry.label}</h1>
      <div className="plugin-resource-host">
        {error ? (
          <Notice
            tone="error"
            icon={false}
            className="plugin-error plugin-banner"
            action={(
              <button
                type="button"
                className="secondary-button"
                onClick={() => setAttempt((value) => value + 1)}
              >
                {pt('retry')}
              </button>
            )}
          >
            {error}
          </Notice>
        ) : (
          <>
            {!loaded ? (
              <p className="plugin-resource-status" role="status">{t('common.loading')}</p>
            ) : null}
            {entryPath ? (
              <iframe
                key={`${entryPath}:${frameKey}`}
                ref={iframeRef}
                className="plugin-resource-iframe"
                src={entryPath}
                title={entry.label}
                onLoad={() => setLoaded(true)}
              />
            ) : null}
            {entryPath ? (
              <div className="plugin-iframe-toolbar" role="toolbar" aria-label={entry.label}>
                <button
                  type="button"
                  className="plugin-iframe-toolbar-btn"
                  title={pt('pageBack')}
                  aria-label={pt('pageBack')}
                  onClick={handleBack}
                >
                  <ChevronLeft size={15} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="plugin-iframe-toolbar-btn"
                  title={pt('pageReload')}
                  aria-label={pt('pageReload')}
                  onClick={handleReload}
                >
                  <RefreshCw size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="plugin-iframe-toolbar-btn"
                  title={pt('openExternal')}
                  aria-label={pt('openExternal')}
                  onClick={handleOpenExternal}
                >
                  <ExternalLink size={14} aria-hidden="true" />
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function DesktopPluginWebviewPage({ entry, reloadToken }: { entry: PluginNavEntry; reloadToken: number }) {
  const { t, locale } = useI18n();
  const pt = (key: Parameters<typeof pluginText>[0]) => pluginText(key, locale);
  const host = useRef<HTMLDivElement>(null);
  const overlay = useOverlayOpen();
  const [bounds, setBounds] = useState<WebviewBounds>(EMPTY_BOUNDS);
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const wanted = effectiveBounds({ active: !error, overlay, bounds });
  const wantedRef = useRef(wanted);
  wantedRef.current = wanted;
  const token = useRef(0);
  const handledReload = useRef(reloadToken);

  const measure = useCallback(() => {
    if (!host.current) return;
    const next = roundBounds(host.current.getBoundingClientRect(), window.innerHeight);
    // Reapply even when CSS bounds are unchanged: the native DPI may have changed.
    setBounds(next);
  }, []);

  useLayoutEffect(() => {
    measure();
    const observer = new ResizeObserver(measure);
    if (host.current) observer.observe(host.current);
    observer.observe(document.documentElement);
    window.addEventListener('resize', measure);
    let resolution = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const onResolutionChange = () => {
      resolution.removeEventListener('change', onResolutionChange);
      resolution = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      resolution.addEventListener('change', onResolutionChange);
      measure();
    };
    resolution.addEventListener('change', onResolutionChange);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      resolution.removeEventListener('change', onResolutionChange);
    };
  }, [measure]);

  useEffect(() => () => {
    void hidePluginWebview({ token: token.current }).catch(() => undefined);
  }, []);

  useEffect(() => {
    const reload = handledReload.current !== reloadToken;
    handledReload.current = reloadToken;
    const mine = newWebviewToken();
    token.current = mine;
    let cancelled = false;
    setReady(false);
    setError('');
    const labels = { back: pt('pageBack'), reload: pt('pageReload'), openExternal: pt('openExternal'), move: pt('pageMove') };
    showPluginWebview({ pluginId: entry.pluginID, menuIndex: entry.menuIndex, bounds: wantedRef.current, labels, reload, token: mine })
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch((reason) => {
        if (!cancelled) setError(message(reason));
      });
    return () => { cancelled = true; };
  }, [entry.pluginID, entry.menuIndex, reloadToken, attempt, locale]);

  useEffect(() => {
    void setPluginWebviewBounds({ bounds: wanted, token: token.current }).catch((reason) => setError(message(reason)));
  }, [ready, wanted]);

  return <section className="page plugin-resource-page">
    <h1 className="sr-only">{entry.label}</h1>
    <div ref={host} className="plugin-resource-host">
      {error ? <Notice tone="error" icon={false} className="plugin-error plugin-banner" action={<button type="button" className="secondary-button" onClick={() => setAttempt((value) => value + 1)}>{pt('retry')}</button>}>{error}</Notice>
        : !ready && <p className="plugin-resource-status" role="status">{t('common.loading')}</p>}
    </div>
  </section>;
}

export function PluginResourcePage({ entry, reloadToken }: { entry: PluginNavEntry; reloadToken: number }) {
  const capabilities = useRuntimeCapabilities();
  if (!capabilities.supportsNativePluginWebview) {
    return <WebPluginFramePage entry={entry} reloadToken={reloadToken} />;
  }
  return <DesktopPluginWebviewPage entry={entry} reloadToken={reloadToken} />;
}
