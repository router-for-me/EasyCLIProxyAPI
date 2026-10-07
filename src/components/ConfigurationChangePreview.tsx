import { useI18n } from '../i18n';

export function configurationDifferences(before: unknown, after: unknown) {
  const flatten = (value: unknown, path = ''): Record<string, string> => {
    if (value !== null && typeof value === 'object') return Object.assign({}, ...Object.entries(value).map(([key, entry]) => flatten(entry, path ? `${path}.${key}` : key)));
    return { [path]: value === null || value === undefined || value === '' ? '—' : String(value) };
  };
  const left = flatten(before); const right = flatten(after);
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].filter(key => left[key] !== right[key])
    .map(key => ({ key, before: left[key] ?? '—', after: right[key] ?? '—' }));
}

export function ConfigurationChangePreview({ before, after, app }: { before: unknown; after: unknown; app: string }) {
  const { t } = useI18n();
  const differences = configurationDifferences(before, after);
  if (!differences.length) return null;
  const label = (key: string) => key.replace(/^mappings\./, '').replace(/desktopModels\.(\d+)\./, (_, n) => `Model ${Number(n) + 1} · `)
    .replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\./g, ' · ');
  return <details className="ux-change-preview" open><summary>{t('ux.preview')} · {differences.length}</summary>
    <p>{t('ux.previewHint', { app })}</p><dl>{differences.map(row => <div key={row.key}><dt>{label(row.key)}</dt>
      <dd><span>{t('ux.before')}: {row.before}</span><strong>{t('ux.after')}: {row.after}</strong></dd></div>)}</dl>
  </details>;
}
