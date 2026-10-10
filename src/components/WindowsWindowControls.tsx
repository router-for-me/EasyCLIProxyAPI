import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow, type Window as TauriWindow } from '@tauri-apps/api/window';
import { Copy, Minus, Square, X } from 'lucide-react';
import { MessageNotice } from '../appNotice';
import { useI18n } from '../i18n';

export function WindowsWindowControls() {
  const { t } = useI18n();
  const [appWindow, setAppWindow] = useState<TauriWindow | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri() && !(import.meta.env.DEV && document.body.dataset.browserMock)) return;
    let disposed = false;
    let stopListening: (() => void) | undefined;

    const initialize = async () => {
      const { os } = await invoke<{ os: string }>('detect_core_platform');
      if (disposed || os !== 'windows') return;
      const currentWindow = getCurrentWindow();
      const refreshMaximized = async () => {
        const nextMaximized = await currentWindow.isMaximized();
        if (!disposed) setMaximized(nextMaximized);
      };
      await refreshMaximized();
      const stop = await currentWindow.onResized(() => {
        void refreshMaximized().catch(console.error);
      });
      if (disposed) {
        stop();
        return;
      }
      stopListening = stop;
      setAppWindow(currentWindow);
    };

    void initialize().catch((failure) => {
      console.error('Failed to initialize Windows window controls', failure);
    });
    return () => {
      disposed = true;
      stopListening?.();
    };
  }, []);

  useEffect(() => {
    if (!appWindow) return;
    void appWindow.setDecorations(false).catch((failure) => {
      console.error('Failed to remove the Windows title bar', failure);
      setAppWindow(null);
    });
  }, [appWindow]);

  if (!appWindow) return null;

  const perform = async (action: () => Promise<void>) => {
    try {
      await action();
      setError(null);
    } catch (failure) {
      setError(t('app.window.actionFailed', { error: String(failure) }));
    }
  };
  const maximizeLabel = t(maximized ? 'app.window.restore' : 'app.window.maximize');

  return (
    <>
      <div className="windows-window-controls" role="toolbar" aria-label={t('app.window.controls')}>
        <div className="windows-window-drag-region" data-tauri-drag-region />
        <button
          type="button"
          className="windows-window-button"
          aria-label={t('app.window.minimize')}
          title={t('app.window.minimize')}
          onClick={() => void perform(() => appWindow.minimize())}
        >
          <Minus size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="windows-window-button"
          aria-label={maximizeLabel}
          title={maximizeLabel}
          onClick={() => void perform(async () => {
            await appWindow.toggleMaximize();
            setMaximized(await appWindow.isMaximized());
          })}
        >
          {maximized
            ? <Copy size={12} strokeWidth={1.5} aria-hidden="true" />
            : <Square size={12} strokeWidth={1.5} aria-hidden="true" />}
        </button>
        <button
          type="button"
          className="windows-window-button windows-window-close"
          aria-label={t('common.close')}
          title={t('common.close')}
          onClick={() => void perform(() => appWindow.close())}
        >
          <X size={16} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
      {error ? <MessageNotice message={error} onDismiss={() => setError(null)} /> : null}
    </>
  );
}
