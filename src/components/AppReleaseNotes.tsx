import { useId, useState } from 'react';
import { ChevronDown, ExternalLink, FileText } from 'lucide-react';
import Markdown from 'react-markdown';
import type { AppUpdateInfo } from '../appUpdate';
import { useI18n } from '../i18n';

type Props = {
  info: Pick<AppUpdateInfo, 'latestVersion' | 'releaseNotes' | 'publishedAt'> | null;
  checking: boolean;
  failed: boolean;
  onOpenUrl: (url?: string) => void | Promise<void>;
};

export function releaseNotesUrl(value: string): string {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

export function AppReleaseNotes({ info, checking, failed, onOpenUrl }: Props) {
  const { t, formatDate, locale } = useI18n();
  const [expanded, setExpanded] = useState(true);
  const contentId = useId();
  const headingId = useId();
  const notes = info?.releaseNotes?.[locale]?.trim();
  const publishedAt = info?.publishedAt && Number.isFinite(Date.parse(info.publishedAt))
    ? info.publishedAt
    : null;
  const emptyMessage = info
    ? t('appUpdate.notes.empty')
    : checking
      ? t('appUpdate.notes.loading')
      : failed
        ? t('appUpdate.notes.failed')
        : t('appUpdate.notes.notChecked');

  return (
    <section className="app-release-notes" aria-labelledby={headingId}>
      <header className="app-release-notes-heading">
        <div>
          <FileText size={17} aria-hidden="true" />
          <h2 id={headingId}>{t('appUpdate.notes.title')}</h2>
        </div>
        <button
          type="button"
          className="app-release-notes-toggle"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded((current) => !current)}
        >
          {t(expanded ? 'appUpdate.notes.collapse' : 'appUpdate.notes.expand')}
          <ChevronDown size={15} className={expanded ? 'is-expanded' : ''} aria-hidden="true" />
        </button>
      </header>
      <div id={contentId} hidden={!expanded}>
        <div className="app-release-notes-body">
          {info ? (
            <div className="app-release-notes-meta">
              <strong>{`v${info.latestVersion.replace(/^v/i, '')}`}</strong>
              <span className="app-release-notes-latest">{t('appUpdate.latest')}</span>
              {publishedAt ? (
                <time dateTime={publishedAt}>
                  {t('appUpdate.notes.publishedAt', {
                    date: formatDate(publishedAt, { year: 'numeric', month: 'long', day: 'numeric' }),
                  })}
                </time>
              ) : null}
            </div>
          ) : null}
          {notes ? (
            <div className="app-release-notes-markdown" lang={locale}>
              <Markdown
                skipHtml
                disallowedElements={['img']}
                urlTransform={releaseNotesUrl}
                components={{
                  h1: ({ children }) => <h3 className="release-notes-subtitle">{children}</h3>,
                  h2: ({ children }) => <h3 className="release-notes-category">{children}</h3>,
                  a: ({ href, children }) => href ? (
                    <a href={href} onClick={(event) => { event.preventDefault(); void onOpenUrl(href); }}>
                      {children}
                    </a>
                  ) : <span>{children}</span>,
                }}
              >
                {notes}
              </Markdown>
            </div>
          ) : (
            <p className="app-release-notes-empty" role="status">{emptyMessage}</p>
          )}
        </div>
        <footer className="app-release-notes-footer">
          <button type="button" className="app-release-notes-toggle" onClick={() => void onOpenUrl()}>
            {t('appUpdate.notes.openRelease')}
            <ExternalLink size={14} aria-hidden="true" />
          </button>
        </footer>
      </div>
    </section>
  );
}
