import { SegmentedControl } from './SegmentedControl';
import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties } from 'react';
import { Check, FolderOpen, ImagePlus, Monitor, Moon, Palette, RefreshCw, Search, Sun, SunMoon, Trash2 } from 'lucide-react';
import { useI18n } from '../i18n';
import {
  getAnimeBackdropInfo, openCustomThemesDirectory, reloadCustomThemes, retryThemeSave,
  setAnimeBackdropPreset, setCustomAnimeBackdropImage, setSystemTheme, useAnimeBackdropState,
  useCustomThemeStatus, useResolvedThemeId, useSystemThemes, useThemePreferenceIssue, useThemeRegistry,
} from '../theme';
import type { AnimeWallpaperPreset } from '../themes/anime';
import { builtinThemes, themePreview, type ThemeRegistry } from '../themes/registry';
import { localizeThemeLabel, type ThemeAppearance, type ThemeDefinition, type ThemeIssueCode } from '../themes/types';
import type { CustomThemeSkipReason } from '../themes/customThemes';
import type { MessageKey } from '../i18n/resources';
import { Dialog } from './Dialog';
import { EmptyState } from './EmptyState';
import { Notice } from './Notice';
import { Select } from './Select';
import { ThemeDiyGuide } from './ThemeDiyGuide';
import './ThemeSelector.css';

const skipReasonKeys: Record<CustomThemeSkipReason, MessageKey> = {
  unreadable: 'app.theme.custom.reason.unreadable',
  'invalid-json': 'app.theme.custom.reason.invalidJson',
  'unsupported-version': 'app.theme.custom.reason.unsupportedVersion',
  'invalid-metadata': 'app.theme.custom.reason.invalidMetadata',
  'duplicate-id': 'app.theme.custom.reason.duplicateId',
};
const issueKeys: Record<ThemeIssueCode, MessageKey> = {
  'unknown-token': 'app.theme.custom.issue.unknownToken',
  'invalid-token': 'app.theme.custom.issue.invalidToken',
  'invalid-icon': 'app.theme.custom.issue.invalidIcon',
  'invalid-asset': 'app.theme.custom.issue.invalidAsset',
};

function ThemeThumbnail({ theme }: { theme: ThemeDefinition }) {
  const preview = themePreview(theme);
  return (
    <span className="theme-thumbnail" aria-hidden="true" style={{
      '--preview-bg': preview.background, '--preview-sidebar': preview.sidebar,
      '--preview-surface': preview.surface, '--preview-accent': preview.accent,
    } as CSSProperties}>
      <span className="theme-thumbnail-sidebar"><i /><i /><i /></span>
      <span className="theme-thumbnail-content"><i /><i /><i /></span>
    </span>
  );
}

type Mode = ThemeAppearance | 'system';
type Source = 'all' | 'builtin' | 'custom';
const builtinIds = new Set(builtinThemes.map(theme => theme.id));

export function ThemeSelector({ value, onChange, open, onOpenChange, registry: override }: {
  value: string;
  onChange: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  registry?: ThemeRegistry;
}) {
  const { t, locale } = useI18n();
  const activeRegistry = useThemeRegistry();
  const registry = override ?? activeRegistry;
  const issue = useThemePreferenceIssue();
  const systemThemes = useSystemThemes();
  const resolvedId = useResolvedThemeId();
  const custom = useCustomThemeStatus();
  useAnimeBackdropState();
  const animeBackdrop = getAnimeBackdropInfo();
  const [openFailed, setOpenFailed] = useState(false);
  const [uploadFailed, setUploadFailed] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const backdropInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<Source>('all');
  const fixed = value === 'system' ? undefined : registry.get(value);
  const unavailable = value !== 'system' && !fixed;
  const mode: Mode = value === 'system' ? 'system' : fixed?.appearance ?? 'light';
  const slot = (appearance: ThemeAppearance) =>
    fixed?.appearance === appearance ? fixed.id : registry.resolveSystem(appearance, systemThemes).id;
  const current = registry.get(resolvedId) ?? registry.get('light')!;
  const themeName = (theme: ThemeDefinition) => theme.name ? localizeThemeLabel(theme.name, locale) : t(theme.nameKey!);
  const themeDescription = (theme: ThemeDefinition) => theme.description ? localizeThemeLabel(theme.description, locale)
    : theme.descriptionKey ? t(theme.descriptionKey) : '';
  const themeTitle = (theme: ThemeDefinition) => [themeName(theme), themeDescription(theme)].filter(Boolean).join('\n');
  const normalizedQuery = query.trim().normalize('NFKC').toLocaleLowerCase(locale);
  const matches = registry.themes.filter(theme =>
    (source === 'all' || builtinIds.has(theme.id) === (source === 'builtin'))
    && [themeName(theme), themeDescription(theme), theme.id].some(text =>
      text.normalize('NFKC').toLocaleLowerCase(locale).includes(normalizedQuery)));
  const resetFilters = () => { setQuery(''); setSource('all'); search.current?.focus(); };
  const name = unavailable ? t('app.theme.unavailable') : themeName(current);
  const issueText = issue === 'read' ? t('app.theme.readFailed') : issue === 'save' ? t('app.theme.saveFailed')
    : unavailable ? t('app.theme.unavailableHint') : '';
  const label = `${t('app.theme.triggerHint')} — ${t('app.theme.current', { name })}`;
  const customText = [
    openFailed ? t('app.theme.custom.openFailed') : '',
    custom.failed ? t('app.theme.custom.loadFailed') : '',
    custom.omitted ? t('app.theme.custom.omitted', { count: custom.omitted }) : '',
  ].filter(Boolean).join(' ');
  const customProblems = [
    ...custom.skipped.map(({ folder, reason }) =>
      t('app.theme.custom.skippedFile', { folder, reason: t(skipReasonKeys[reason]) })),
    ...custom.diagnostics.map(({ folder, issues }) => t('app.theme.custom.diagnostics', {
      folder,
      fields: issues.map(({ field, code }) => `${field} (${t(issueKeys[code])})`).join(', '),
    })),
  ];
  const openDirectory = () => {
    setOpenFailed(false);
    openCustomThemesDirectory().catch(() => setOpenFailed(true));
  };

  useEffect(() => {
    if (!open) { setQuery(''); setSource('all'); setUploadFailed(false); setGuideOpen(false); }
  }, [open]);

  const chooseMode = (next: Mode) => {
    if (fixed) setSystemTheme(fixed.id);
    onChange(next === 'system' ? 'system' : slot(next));
  };
  const chooseTheme = (theme: ThemeDefinition) => {
    setSystemTheme(theme.id);
    if (mode !== 'system') onChange(theme.id);
  };
  const handleBackdropUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploadFailed(false);
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const img = new Image();
      img.onload = () => {
        const maxDim = 1600;
        const scale = Math.min(1, maxDim / Math.max(img.width || 1, img.height || 1));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) { setUploadFailed(true); return; }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const converted = canvas.toDataURL('image/webp', 0.85);
        if (setCustomAnimeBackdropImage(converted)) {
          const animeTheme = registry.get('anime-light');
          if (animeTheme) chooseTheme(animeTheme);
        } else {
          setUploadFailed(true);
        }
      };
      img.onerror = () => {
        if (setCustomAnimeBackdropImage(result)) {
          const animeTheme = registry.get('anime-light');
          if (animeTheme) chooseTheme(animeTheme);
        } else {
          setUploadFailed(true);
        }
      };
      img.src = result;
    };
    reader.onerror = () => setUploadFailed(true);
    reader.readAsDataURL(file);
  };
  const animePresets: { id: AnimeWallpaperPreset; label: string }[] = [
    { id: 'starlight', label: t('app.theme.anime.preset.starlight') },
    { id: 'sakura-sky', label: t('app.theme.anime.preset.sakuraSky') },
    ...(animeBackdrop.hasCustomImage ? [{ id: 'custom' as const, label: t('app.theme.anime.preset.custom') }] : []),
    { id: 'none', label: t('app.theme.anime.preset.none') },
  ];
  const modes: { id: Mode; label: string; Icon: typeof Sun }[] = [
    { id: 'light', label: t('app.theme.light'), Icon: Sun },
    { id: 'dark', label: t('app.theme.dark'), Icon: Moon },
    { id: 'system', label: t('app.theme.system'), Icon: Monitor },
  ];

  return (
    <div className="theme-selector">
      <button className="theme-selector-trigger" type="button"
        aria-haspopup="dialog" aria-expanded={open} aria-label={label}
        title={issueText ? `${label} — ${issueText}` : label} onClick={event => {
          if (!open) event.currentTarget.focus({ preventScroll: true });
          onOpenChange(!open);
        }}>
        <SunMoon size={16} strokeWidth={1.75} aria-hidden="true" />
        <span>{t('app.theme.triggerLabel')}</span>
        {issueText ? <i className="theme-selector-warning" aria-hidden="true" /> : null}
      </button>
      {open ? <Dialog className="theme-selector-menu surface-panel" title={t('app.theme.catalog.title')}
        onClose={() => onOpenChange(false)} dismissOnBackdrop initialFocusRef={search}>
        {issueText ? <Notice className="theme-selector-notice" tone="warn" variant="text"
          action={issue === 'save' ? <button type="button" className="link-button"
            onClick={() => { search.current?.focus(); retryThemeSave(); }}>{t('app.theme.retrySave')}</button> : undefined}>
          {issueText}
        </Notice> : null}
        <div className="theme-selector-preferences">
          <SegmentedControl className="theme-selector-modes" aria-label={t('app.theme.label')} value={mode} onChange={chooseMode}
            buttonClassName="theme-selector-mode" selectedClassName="selected"
            items={modes.map(({ id, label: modeLabel, Icon }) => ({ value: id, label: <><Icon size={14} aria-hidden="true" />{modeLabel}</> }))} />
          <p className="theme-selector-current">{t('app.theme.current', { name })}</p>
          {mode === 'system' ? <p className="theme-selector-system-hint">{t('app.theme.catalog.systemHint')}</p> : null}
        </div>
        <div className="theme-selector-filters">
          <label className="theme-selector-search search-control" data-size="default">
            <Search size={16} aria-hidden="true" />
            <input ref={search} type="search" className="config-dialog-text-input"
              aria-label={t('app.theme.catalog.search')} placeholder={t('app.theme.catalog.searchHint')}
              value={query} onChange={event => setQuery(event.target.value)} />
          </label>
          <Select className="config-dialog-text-input" aria-label={t('app.theme.catalog.source')} value={source}
            onChange={event => setSource(event.target.value as Source)}>
            <option value="all">{t('app.theme.catalog.all')}</option>
            <option value="builtin">{t('app.theme.catalog.builtin')}</option>
            <option value="custom">{t('app.theme.catalog.custom')}</option>
          </Select>
        </div>
        <p className="theme-selector-count" aria-live="polite" aria-atomic="true">
          {t('app.theme.catalog.count', { count: matches.length, total: registry.themes.length })}
        </p>
        <div className="theme-selector-results">
          {customProblems.length ? <details className="theme-selector-problems">
            <summary>{t('app.theme.catalog.problems', { count: customProblems.length })}</summary>
            <Notice className="theme-selector-custom-problems" tone="warn" variant="text" live={false}>
              {customProblems.map((problem, index) => <div key={`${index}-${problem}`}>{problem}</div>)}
            </Notice>
          </details> : null}
          {matches.length ? (['light', 'dark'] as const).map(appearance => {
            const themes = matches.filter(theme => theme.appearance === appearance);
            if (!themes.length) return null;
            const chosen = slot(appearance);
            const group = t(appearance === 'light' ? 'app.theme.lightGroup' : 'app.theme.darkGroup');
            return <div key={appearance} className="theme-selector-group" data-appearance={appearance} role="group" aria-label={group}>
              <div className="theme-selector-heading" aria-hidden="true">{group}<span>{themes.length}</span></div>
              <div className="theme-selector-grid">
                {themes.map(theme => <button key={theme.id} type="button" data-theme-id={theme.id}
                  aria-pressed={chosen === theme.id} title={themeTitle(theme)}
                  className={`theme-selector-card surface-card${chosen === theme.id ? ' selected' : ''}`}
                  onClick={() => chooseTheme(theme)}>
                  <ThemeThumbnail theme={theme} />
                  <span className="theme-selector-name">{themeName(theme)}</span>
                  <span className="theme-selector-description">{themeDescription(theme)}</span>
                  <span className="theme-selector-id">{theme.id}</span>
                  <span className="theme-selector-meta">
                    <span>{t(builtinIds.has(theme.id) ? 'app.theme.catalog.builtin' : 'app.theme.catalog.custom')}</span>
                    {current.id === theme.id ? <span className="theme-selector-active">{t('app.theme.catalog.current')}</span> : null}
                  </span>
                  {chosen === theme.id ? <Check className="theme-selector-check" size={16} aria-hidden="true" /> : null}
                </button>)}
              </div>
              {appearance === 'light' && (chosen === 'anime-light' || current.id === 'anime-light') ? (
                <div className="theme-selector-anime-backdrop surface-section">
                  <div className="theme-selector-anime-header">
                    <strong>{t('app.theme.anime.backdropTitle')}</strong>
                    <div className="theme-selector-anime-actions">
                      <input
                        ref={backdropInput}
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/avif"
                        hidden
                        onChange={handleBackdropUpload}
                      />
                      <button
                        type="button"
                        className="secondary-button compact-button"
                        data-action="upload-anime-backdrop"
                        onClick={() => backdropInput.current?.click()}
                      >
                        <ImagePlus size={14} aria-hidden="true" />
                        {t('app.theme.anime.upload')}
                      </button>
                      {animeBackdrop.hasCustomImage ? (
                        <button
                          type="button"
                          className="secondary-button compact-button"
                          data-action="clear-anime-backdrop"
                          onClick={() => {
                            setUploadFailed(!setCustomAnimeBackdropImage(null));
                          }}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                          {t('app.theme.anime.clearCustom')}
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <SegmentedControl
                    className="theme-selector-modes theme-selector-anime-presets"
                    aria-label={t('app.theme.anime.backdropTitle')}
                    value={animeBackdrop.preset}
                    onChange={(preset) => {
                      setUploadFailed(!setAnimeBackdropPreset(preset));
                    }}
                    buttonClassName="theme-selector-mode"
                    selectedClassName="selected"
                    items={animePresets.map(({ id, label: presetLabel }) => ({ value: id, label: presetLabel }))}
                  />
                  {uploadFailed ? (
                    <Notice tone="error" variant="text">{t('app.theme.anime.uploadFailed')}</Notice>
                  ) : null}
                </div>
              ) : null}
            </div>;
          }) : <EmptyState variant="compact" icon={<Search size={24} />} title={t('app.theme.catalog.empty')}
            action={<button type="button" className="secondary-button compact-button" onClick={resetFilters}>
              {t('app.theme.catalog.reset')}
            </button>} />}
        </div>
        <div className="theme-selector-footer">
          {customText ? <Notice className="theme-selector-custom-notice" tone={custom.failed || openFailed ? 'error' : 'warn'} variant="text">
            {customText}
          </Notice> : null}
          <p className="theme-selector-hint">{t('app.theme.custom.folderHint')}</p>
          <div className="theme-selector-actions">
            <button type="button" className="secondary-button compact-button" data-action="theme-diy-guide"
              onClick={() => setGuideOpen(true)}>
              <Palette size={15} aria-hidden="true" />{t('app.theme.diy.title')}
            </button>
            <div className="theme-selector-file-actions">
            <button type="button" className="secondary-button compact-button" data-action="open-themes" onClick={openDirectory}>
              <FolderOpen size={15} aria-hidden="true" />{t('app.theme.custom.openFolder')}
            </button>
            <button type="button" className="secondary-button compact-button" data-action="reload-themes" disabled={custom.loading}
              onClick={() => { setOpenFailed(false); void reloadCustomThemes(); }}>
              <RefreshCw size={15} aria-hidden="true" />{t('app.theme.custom.reload')}
            </button>
            </div>
          </div>
        </div>
      </Dialog> : null}
      {open && guideOpen ? <ThemeDiyGuide onClose={() => setGuideOpen(false)} /> : null}
    </div>
  );
}
