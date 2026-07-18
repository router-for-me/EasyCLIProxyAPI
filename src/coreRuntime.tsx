import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export type CoreStatus = {
  installed: boolean;
  running: boolean;
  managed: boolean;
  processId: number | null;
  currentVersion: string | null;
  installDir: string;
  binaryPath: string | null;
  message: string;
};

type CoreRuntimeContextValue = {
  status: CoreStatus | null;
  statusError: string;
  refreshStatus: () => Promise<void>;
  publishStatus: (status: CoreStatus | null) => void;
};

const CoreRuntimeContext = createContext<CoreRuntimeContextValue | null>(null);

export function CoreRuntimeProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<CoreStatus | null>(null);
  const [statusError, setStatusError] = useState('');

  const publishStatus = useCallback((nextStatus: CoreStatus | null) => {
    setStatus(nextStatus);
    if (nextStatus) {
      setStatusError('');
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const nextStatus = await invoke<CoreStatus>('get_core_status');
      setStatus(nextStatus);
      setStatusError('');
    } catch (error) {
      setStatus(null);
      setStatusError(String(error));
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    listen<CoreStatus>('core-status-changed', (event) => {
      if (!disposed) {
        publishStatus(event.payload);
      }
    }).then((stop) => {
      if (disposed) {
        stop();
      } else {
        unlisten = stop;
      }
    }).catch((error) => {
      if (!disposed) {
        setStatusError(String(error));
      }
    });

    void refreshStatus();
    const timer = window.setInterval(() => {
      if (!document.hidden) {
        void refreshStatus();
      }
    }, 10_000);

    return () => {
      disposed = true;
      unlisten?.();
      window.clearInterval(timer);
    };
  }, [publishStatus, refreshStatus]);

  const value = useMemo(
    () => ({ status, statusError, refreshStatus, publishStatus }),
    [publishStatus, refreshStatus, status, statusError],
  );

  return <CoreRuntimeContext.Provider value={value}>{children}</CoreRuntimeContext.Provider>;
}

export function useCoreRuntime() {
  const context = useContext(CoreRuntimeContext);
  if (!context) {
    throw new Error('useCoreRuntime 必须在 CoreRuntimeProvider 内使用');
  }
  return context;
}
