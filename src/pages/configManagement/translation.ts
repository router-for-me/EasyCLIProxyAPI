import { useCallback } from 'react';
import { useI18n } from '../../i18n';
import en from './en.json';
import ru from './ru.json';
import zhCN from './zh-CN.json';
import zhTW from './zh-TW.json';

const messages = { en, ja: en, ru, 'zh-CN': zhCN, 'zh-TW': zhTW };

function readMessage(root: unknown, path: string): string | undefined {
  const value = path.split('.').reduce<unknown>((parent, part) =>
    parent && typeof parent === 'object' && Object.prototype.hasOwnProperty.call(parent, part)
      ? (parent as Record<string, unknown>)[part] : undefined, root);
  return typeof value === 'string' ? value : undefined;
}

export function useTranslation() {
  const { locale } = useI18n();
  const t = useCallback((key: string, variables?: Record<string, string | number>) => {
    const template = readMessage(messages[locale], key) ?? readMessage(en, key) ?? String(variables?.defaultValue ?? key);
    return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) =>
      variables && Object.prototype.hasOwnProperty.call(variables, name) ? String(variables[name]) : match);
  }, [locale]);
  return { t };
}
