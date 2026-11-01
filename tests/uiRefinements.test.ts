import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss from 'postcss';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { EmptyState } from '../src/components/EmptyState';

const readStyle = (file: string) => postcss.parse(readFileSync(resolve(import.meta.dir, '../src', file), 'utf8'));
const refinements = readStyle('styles/ui-refinements.css');

describe('shared UI refinements', () => {
  it('keeps motion keyframes out of layout and leaves enter transforms temporary', () => {
    const names: string[] = [];
    refinements.walkAtRules('keyframes', keyframes => {
      if (!keyframes.params.startsWith('ui-')) return;
      names.push(keyframes.params);
      keyframes.walkDecls(declaration => {
        expect(['opacity', 'transform']).toContain(declaration.prop);
      });
    });
    expect(names).toEqual(['ui-view-enter', 'ui-dialog-enter', 'ui-notice-enter', 'ui-notice-exit']);
    refinements.walkDecls('animation', declaration => {
      if (declaration.value.includes('ui-') && !declaration.value.includes('exit')) {
        expect(declaration.value).not.toMatch(/forwards|both/);
      }
    });
  });

  it('turns off shared enter and exit animations for reduced motion', () => {
    const disabled: string[] = [];
    refinements.walkAtRules('media', media => {
      if (media.params !== '(prefers-reduced-motion: reduce)') return;
      media.walkRules(rule => {
        rule.walkDecls('animation', declaration => {
          if (declaration.value === 'none') disabled.push(...rule.selectors);
        });
      });
    });
    expect(disabled).toContain('.app-dialog');
    expect(disabled).toContain('.app-notice-entry');
    expect(disabled).toContain(".app-notice-entry[data-closing='true']");
    expect(disabled).toContain("[role='tabpanel']:not([hidden])");
  });

  it('keeps styles in the existing component and token layers', () => {
    const imports = readStyle('styles/index.css');
    const params: string[] = [];
    imports.walkAtRules('import', rule => { params.push(rule.params); });
    expect(params).toContain("'./ui-refinements.css' layer(components)");
    expect(params).toContain("'./surfaces.css' layer(components)");
    expect(params).toContain("'./tokens/index.css' layer(tokens)");
    expect(params.indexOf("'./surfaces.css' layer(components)")).toBeLessThan(params.indexOf("'./theme-surfaces.css' layer(theme)"));
  });

  it('groups optional empty-state actions without adding an empty action row', () => {
    const empty = renderToStaticMarkup(createElement(EmptyState, { title: 'No results' }));
    expect(empty).not.toContain('empty-state-actions');
    const actionable = renderToStaticMarkup(createElement(EmptyState, {
      title: 'No results',
      action: createElement('button', { type: 'button' }, 'Retry'),
    }));
    expect(actionable).toContain('<div class="empty-state-actions"><button type="button">Retry</button></div>');
  });
});
