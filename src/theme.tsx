import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'easy-cli-proxy-api.theme';
const MEDIA_QUERY = '(prefers-color-scheme: dark)';

function normalizeThemeMode(value: string | null | undefined): ThemeMode {
  if (value === 'light' || value === 'dark') return value;
  return 'system';
}

function detectInitialMode(): ThemeMode {
  if (typeof window === 'undefined') return 'system';
  try {
    return normalizeThemeMode(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return 'system';
  }
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia(MEDIA_QUERY).matches ? 'dark' : 'light';
}

type ThemeContextValue = {
  mode: ThemeMode;
  resolvedTheme: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, updateMode] = useState<ThemeMode>(detectInitialMode);
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(getSystemTheme);
  const resolvedTheme = mode === 'system' ? systemTheme : mode;

  const setMode = useCallback((nextMode: ThemeMode) => {
    updateMode(normalizeThemeMode(nextMode));
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const mediaQuery = window.matchMedia(MEDIA_QUERY);
    const updateSystemTheme = (event?: MediaQueryListEvent) => {
      const isDark = event?.matches ?? mediaQuery.matches;
      setSystemTheme(isDark ? 'dark' : 'light');
    };

    updateSystemTheme();
    mediaQuery.addEventListener('change', updateSystemTheme);
    return () => mediaQuery.removeEventListener('change', updateSystemTheme);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // The in-memory theme still works when persistent storage is unavailable.
    }
  }, [mode, resolvedTheme]);

  const context = useMemo(
    () => ({ mode, resolvedTheme, setMode }),
    [mode, resolvedTheme, setMode],
  );

  return <ThemeContext.Provider value={context}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside ThemeProvider');
  return context;
}
