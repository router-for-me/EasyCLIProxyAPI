import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useCoreRuntime } from './coreRuntime';

export type CoreLatest = {
  version: string;
  assetName: string;
};

type CoreUpdateContextValue = {
  latest: CoreLatest | null;
  error: string;
  checking: boolean;
  hasUpdate: boolean;
  check: (force?: boolean) => Promise<void>;
  reset: () => void;
};

let latestAutoCheckStarted = false;
let cachedLatest: CoreLatest | null = null;
let cachedLatestError = '';
let latestCheckPromise: Promise<CoreLatest> | null = null;
let latestRequestEpoch = 0;

function normalizeVersion(version: string | null | undefined) {
  return (version ?? '').trim().replace(/^v/i, '');
}

export function coreUpdateAvailable(
  currentVersion: string | null | undefined,
  latestVersion: string | null | undefined,
) {
  const current = normalizeVersion(currentVersion);
  const latest = normalizeVersion(latestVersion);
  return Boolean(current && latest && current !== latest);
}

export function requestLatestCore(force = false) {
  if (!force && latestCheckPromise) {
    return latestCheckPromise;
  }

  const requestEpoch = ++latestRequestEpoch;
  const request = invoke<CoreLatest>('check_latest_core')
    .then((result) => {
      if (requestEpoch === latestRequestEpoch) {
        cachedLatest = result;
        cachedLatestError = '';
      }
      return result;
    })
    .catch((error) => {
      if (requestEpoch === latestRequestEpoch) {
        cachedLatest = null;
        cachedLatestError = String(error);
      }
      throw error;
    })
    .finally(() => {
      if (latestCheckPromise === request) {
        latestCheckPromise = null;
      }
    });
  latestCheckPromise = request;

  return request;
}

const CoreUpdateContext = createContext<CoreUpdateContextValue | null>(null);

export function CoreUpdateProvider({ children }: { children: ReactNode }) {
  const { status } = useCoreRuntime();
  const [latest, setLatest] = useState<CoreLatest | null>(cachedLatest);
  const [error, setError] = useState(cachedLatestError);
  const [checking, setChecking] = useState(Boolean(latestCheckPromise));
  const checkEpochRef = useRef(0);

  const check = useCallback(async (force = false) => {
    const checkEpoch = ++checkEpochRef.current;
    setChecking(true);
    setError('');

    try {
      const result = await requestLatestCore(force);
      if (checkEpoch === checkEpochRef.current) {
        setLatest(result);
      }
    } catch (nextError) {
      if (checkEpoch === checkEpochRef.current) {
        setLatest(null);
        setError(String(nextError));
      }
    } finally {
      if (checkEpoch === checkEpochRef.current) {
        setChecking(false);
      }
    }
  }, []);

  const reset = useCallback(() => {
    latestRequestEpoch += 1;
    latestCheckPromise = null;
    cachedLatest = null;
    cachedLatestError = '';
    checkEpochRef.current += 1;
    setLatest(null);
    setError('');
    setChecking(false);
  }, []);

  useEffect(() => {
    if (!latestAutoCheckStarted) {
      latestAutoCheckStarted = true;
      void check();
    } else if (latestCheckPromise) {
      void check();
    }
  }, [check]);

  const value = useMemo<CoreUpdateContextValue>(() => ({
    latest,
    error,
    checking,
    hasUpdate: coreUpdateAvailable(status?.currentVersion, latest?.version),
    check,
    reset,
  }), [check, checking, error, latest, reset, status?.currentVersion]);

  return <CoreUpdateContext.Provider value={value}>{children}</CoreUpdateContext.Provider>;
}

export function useCoreUpdate() {
  const context = useContext(CoreUpdateContext);
  if (!context) {
    throw new Error('useCoreUpdate 必须在 CoreUpdateProvider 内使用');
  }
  return context;
}
