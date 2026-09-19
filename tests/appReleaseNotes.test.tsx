import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppReleaseNotes, releaseNotesUrl } from '../src/components/AppReleaseNotes';
import { I18nProvider, supportedLocales, translate, type AppLocale } from '../src/i18n';

const translations = {
  'zh-CN': '## 新增\n\n- 支持 **更新说明**。\n',
  'zh-TW': '## 新增\n\n- 支援 **更新說明**。\n',
  en: '## Added\n\n- Supports **release notes**.\n',
  ja: '## 新機能\n\n- **更新内容**を表示します。\n',
};
const info = {
  latestVersion: '0.2.98',
  publishedAt: '2026-09-19T00:00:00Z',
  releaseNotes: translations,
};

function renderNotes(overrides: Partial<Parameters<typeof AppReleaseNotes>[0]> = {}, locale: AppLocale = 'zh-CN') {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  // The provider reads the saved UI language on mount; effects do not run during SSR.
  Object.defineProperty(globalThis, 'window', {
    configurable: true, value: { localStorage: { getItem: () => locale } },
  });
  try {
    return renderToStaticMarkup(
      <I18nProvider>
        <AppReleaseNotes info={info} checking={false} failed={false} onOpenUrl={() => {}} {...overrides} />
      </I18nProvider>,
    );
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

describe('localized release notes display', () => {
  test('renders versioned Markdown with date and release link without requiring an available update', () => {
    const html = renderNotes();
    expect(html).toContain('v0.2.98');
    expect(html).toMatch(/<time datetime="2026-09-19T00:00:00Z"/i);
    expect(html).toContain('release-notes-category');
    expect(html).toContain('<strong>更新说明</strong>');
    expect(html).toContain('查看完整发布说明');
    expect(html).toContain('aria-expanded="true"');
  });

  test.each(supportedLocales)('renders only the %s translation', (locale) => {
    const html = renderNotes({}, locale);
    const body = html.split('app-release-notes-markdown')[1].split('</footer>')[0];
    expect(body).toContain('lang="' + locale + '"');
    const expected = { 'zh-CN': '更新说明', 'zh-TW': '更新說明', en: 'release notes', ja: '更新内容' };
    for (const [language, text] of Object.entries(expected)) {
      if (language === locale) expect(body).toContain('<strong>' + text + '</strong>');
      else expect(body).not.toContain('<strong>' + text + '</strong>');
    }
  });

  test.each(supportedLocales)('shows a localized message when %s is missing, even if all other languages exist', (locale) => {
    const remaining: Partial<Record<AppLocale, string>> = { ...translations };
    delete remaining[locale];
    for (const releaseNotes of [remaining, { ...remaining, [locale]: ' \n' }, {}, null]) {
      const html = renderNotes({ info: { ...info, releaseNotes } }, locale);
      expect(html).toContain(translate(locale, 'appUpdate.notes.empty'));
      expect(html).not.toContain('app-release-notes-markdown');
    }
  });

  test('distinguishes loading and failure states', () => {
    expect(renderNotes({ info: null, checking: true })).toContain('正在获取更新说明');
    expect(renderNotes({ info: null, failed: true })).toContain('暂时无法获取更新说明');
    expect(renderNotes({ info: null })).toContain('检查软件更新后');
    expect(renderNotes({ info: { ...info, publishedAt: 'invalid' } })).not.toContain('<time');
  });

  test('uses fully localized Traditional Chinese labels and missing-content notice', () => {
    expect(renderNotes({}, 'zh-TW')).toContain('軟體更新說明');
    expect(renderNotes({ info: { ...info, releaseNotes: {} } }, 'zh-TW'))
      .toContain('尚未取得目前語言的更新說明。');
  });

  test('does not render remote HTML, images, or executable links', () => {
    const html = renderNotes({ info: { ...info, releaseNotes: { 'zh-CN':
      '<script>alert(1)</script>\n\n<img src="https://example.com/raw.png" onerror="alert(2)">\n\n'
      + '![tracking](https://example.com/tracking.png)\n\n[unsafe](javascript:alert%281%29)\n\n'
      + '[release](https://github.com/router-for-me/EasyCLIProxyAPI/releases/tag/v0.2.98)',
    } } });
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('tracking.png');
    expect(html).toContain('href="https://github.com/router-for-me/EasyCLIProxyAPI/releases/tag/v0.2.98"');
  });

  test('only permits web links for the native opener', () => {
    for (const url of ['javascript:alert(1)', 'file:///C:/test', 'data:text/html,hi', '/relative', '#section']) {
      expect(releaseNotesUrl(url)).toBe('');
    }
    expect(releaseNotesUrl('https://example.com/notes')).toBe('https://example.com/notes');
  });
});
