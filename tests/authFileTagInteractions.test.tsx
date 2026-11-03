import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider, translate } from '../src/i18n';
import { AuthFileBatchDialog } from '../src/components/AuthFileBatchDialog';
import { AuthFileSettingsDialog } from '../src/components/AuthFileSettingsDialog';
import { AuthFileManagementPage } from '../src/pages/AuthFileManagementPage';
import { countAuthFileTags } from '../src/services/authFiles';

describe('credential tag component interactions', () => {
  const sampleFiles = [
    { name: 'codex-a.json', provider: 'codex', source: 'file', tags: ['team', 'xai-weekly'] },
    { name: 'codex-b.json', provider: 'codex', source: 'file', tags: ['team'] },
    { name: 'claude-c.json', provider: 'claude', source: 'file', tags: ['staging'] },
  ];

  it('renders the management page without misleading tag totals or inline tag editors', () => {
    const html = renderToStaticMarkup(<I18nProvider><AuthFileManagementPage /></I18nProvider>);
    expect(html).toContain('All tags</option>');
    expect(html).not.toContain('All tags (');
    expect(html).not.toContain('auth-tag-add-trigger');
    expect(html).not.toContain('auth-card-quick-tag-editor');
  });

  it('keeps settings saving disabled until credential metadata is loaded', () => {
    const html = renderToStaticMarkup(<I18nProvider><AuthFileSettingsDialog
      name="test.json" existingTags={['weekly']} onClose={() => {}} onSaved={() => {}}
    /></I18nProvider>);
    expect(html).toContain('credential-settings-dialog');
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/type="submit"[^>]*disabled=""/);
    expect(html).not.toContain('credential-tag-input');
  });

  it('renders only the all-tags option when a batch has no tags', () => {
    const html = renderToStaticMarkup(<I18nProvider><AuthFileBatchDialog
      files={[{ name: 'test.json', provider: 'codex', source: 'file' }]}
      onClose={() => {}} onChanged={async () => {}}
    /></I18nProvider>);
    expect(html).toContain('All tags</option>');
    expect(html).not.toContain('All tags (');
    expect(html).not.toContain('auth-batch-tag-badge');
  });

  it('renders tag filter with counts and tag badges in AuthFileBatchDialog', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <AuthFileBatchDialog
          files={sampleFiles}
          onClose={() => {}}
          onChanged={async () => {}}
        />
      </I18nProvider>
    );

    expect(html).toContain('team (2)');
    expect(html).toContain('xai-weekly (1)');
    expect(html).toContain('staging (1)');
    expect(html).toContain('All tags</option>');
    expect(html).not.toContain('All tags (');

    expect(html).toContain('auth-batch-tags');
    expect(html).toContain('auth-batch-tag-badge');
    expect(html).toContain('Select group by tag');
  });

  it('translates all tag operations correctly in all four supported locales', () => {
    for (const locale of ['zh-CN', 'zh-TW', 'en', 'ja'] as const) {
      const selectAll = translate(locale, 'authFiles.tags.selectAllInGroup');
      const batchAdd = translate(locale, 'authFiles.tags.batchAdd');
      const batchRemove = translate(locale, 'authFiles.tags.batchRemove');
      const filterBy = translate(locale, 'authFiles.tags.filterBy', { tag: 'team' });
      const addSuccess = translate(locale, 'authFiles.tags.batchAddSuccess', { count: 3, tag: 'team' });

      expect(selectAll).not.toBe('');
      expect(batchAdd).not.toBe('');
      expect(batchRemove).not.toBe('');
      expect(filterBy).toContain('team');
      expect(addSuccess).toContain('3');
      expect(addSuccess).toContain('team');
      for (const key of ['authFiles.tags.label', 'authFiles.tags.all', 'authFiles.tags.hint',
        'authFiles.tags.selectGroup', 'authFiles.tags.inputPlaceholder', 'authFiles.tags.batchRemoveSuccess'] as const) {
        expect(translate(locale, key)).not.toBe(key);
      }
    }
  });

  it('calculates tag counts correctly via countAuthFileTags', () => {
    const counts = countAuthFileTags(sampleFiles);
    expect(counts.get('team')).toBe(2);
    expect(counts.get('xai-weekly')).toBe(1);
    expect(counts.get('staging')).toBe(1);
    expect(counts.get('unknown')).toBeUndefined();
  });
});
