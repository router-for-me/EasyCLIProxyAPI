import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { en, ja, zhCN, zhTW, type MessageKey, type MessageVariables } from './resources';

export type AppLocale = 'zh-CN' | 'zh-TW' | 'ja' | 'en';

const STORAGE_KEY = 'easy-cli-proxy-api.locale';
const resources = { 'zh-CN': zhCN, 'zh-TW': zhTW, ja, en } as const;
let currentLocale: AppLocale = 'zh-CN';

export const supportedLocales: readonly AppLocale[] = ['zh-CN', 'zh-TW', 'ja', 'en'];

export function getCurrentLocale(): AppLocale {
  return currentLocale;
}

export function normalizeLocale(value: string | null | undefined): AppLocale {
  const normalized = value?.trim().toLowerCase() ?? '';
  if (normalized.startsWith('en')) return 'en';
  if (normalized.startsWith('ja')) return 'ja';
  if (
    normalized === 'zh-tw'
    || normalized === 'zh-hk'
    || normalized === 'zh-mo'
    || normalized.startsWith('zh-hant')
  ) return 'zh-TW';
  return 'zh-CN';
}

function detectInitialLocale(): AppLocale {
  if (typeof window === 'undefined') return 'zh-CN';
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved) return normalizeLocale(saved);
  } catch {
    // Storage may be unavailable in a restricted WebView; use the OS language.
  }
  return normalizeLocale(window.navigator.languages?.[0] ?? window.navigator.language);
}

function interpolate(template: string, variables?: MessageVariables): string {
  if (!variables) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(variables, name) ? String(variables[name]) : match,
  );
}

export function translate(locale: AppLocale, key: MessageKey, variables?: MessageVariables): string {
  return interpolate(resources[locale][key] ?? zhCN[key], variables);
}

type I18nContextValue = {
  locale: AppLocale;
  setLocale: (locale: AppLocale) => void;
  t: (key: MessageKey, variables?: MessageVariables) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  formatDate: (value: Date | number | string, options?: Intl.DateTimeFormatOptions) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, updateLocale] = useState<AppLocale>(detectInitialLocale);
  currentLocale = locale;

  const setLocale = useCallback((nextLocale: AppLocale) => {
    updateLocale(normalizeLocale(nextLocale));
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = 'ltr';
    try {
      window.localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // The in-memory locale still works when persistent storage is unavailable.
    }
    void invoke('set_app_locale', { locale }).catch((error) => {
      console.warn('Failed to synchronize the app locale with the native shell', error);
    });
  }, [locale]);

  const t = useCallback(
    (key: MessageKey, variables?: MessageVariables) => translate(locale, key, variables),
    [locale],
  );
  const formatNumber = useCallback(
    (value: number, options?: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat(locale, options).format(value),
    [locale],
  );
  const formatDate = useCallback(
    (value: Date | number | string, options?: Intl.DateTimeFormatOptions) => {
      const date = value instanceof Date ? value : new Date(value);
      return new Intl.DateTimeFormat(locale, options).format(date);
    },
    [locale],
  );

  const context = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t, formatNumber, formatDate }),
    [formatDate, formatNumber, locale, setLocale, t],
  );

  return <I18nContext.Provider value={context}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used inside I18nProvider');
  return context;
}
