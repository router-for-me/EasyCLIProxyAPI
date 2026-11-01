import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider, translate } from '../src/i18n';
import { AuthFileBatchDialog } from '../src/components/AuthFileBatchDialog';
import { countAuthFileTags } from '../src/services/authFiles';

describe('credential tag component interactions', () => {
  const sampleFiles = [
    { name: 'codex-a.json', provider: 'codex', source: 'file', tags: ['team', 'xai-weekly'] },
    { name: 'codex-b.json', provider: 'codex', source: 'file', tags: ['team'] },
    { name: 'claude-c.json', provider: 'claude', source: 'file', tags: ['staging'] },
  ];

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

    // Should contain tag filter options with counts
    expect(html).toContain('team (2)');
    expect(html).toContain('xai-weekly (1)');
    expect(html).toContain('staging (1)');
    expect(html).toContain('All tags (3)');

    // Should display tags on credential rows
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
