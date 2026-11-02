import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss from 'postcss';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { EmptyState } from '../src/components/EmptyState';

const readStyle = (file: string) => postcss.parse(readFileSync(resolve(import.meta.dir, '../src', file), 'utf8'));
const refinements = readStyle('styles/ui-refinements.css');
const home = readStyle('pages/HomeDashboard.css');
const quota = readStyle('pages/QuotaPage.css');
const clients = readStyle('pages/AgentClientList.css');
const declarations = (sheet: postcss.Root, selector: string, property: string, reducedMotion = false) => {
  const values: string[] = [];
  sheet.walkRules(rule => {
    if (!rule.selectors.includes(selector)) return;
    const parent = rule.parent;
    const reduced = parent?.type === 'atrule' && parent.name === 'media'
      && parent.params === '(prefers-reduced-motion: reduce)';
    if (reduced !== reducedMotion) return;
    rule.walkDecls(property, declaration => { values.push(declaration.value); });
  });
  return values;
};

describe('shared UI refinements', () => {
  it('keeps overview cards readable and scrollable in short windows', () => {
    const styles = readStyle('styles.css');
    const page = readFileSync(resolve(import.meta.dir, '../src/pages/UsageRecordsPage.tsx'), 'utf8');
    expect(page).toContain('Math.max(0.88, Math.min(1, width / 900, height / 420))');
    expect(declarations(styles, '.usage-overview-panels', 'min-height')).toEqual(['380px']);
    for (const sheet of [styles, refinements]) {
      expect(declarations(sheet, '.usage-overview-layout', 'grid-template-rows')).toContain('max-content minmax(380px, 1fr)');
    }
    expect(declarations(refinements, '.usage-tab-panel > .usage-overview-layout', 'flex-shrink')).toEqual(['0']);
    expect(declarations(styles, '.usage-tab-panel', 'overflow-y')).toEqual(['auto']);
    for (const selector of ['.usage-trend-y-axis', '.usage-trend-x-axis span', '.usage-trend-legend-item']) {
      expect(declarations(styles, selector, 'font-size')).toEqual(['13px']);
      expect(declarations(styles, selector, 'font-weight')).toEqual(['500']);
      expect(declarations(styles, selector, 'color')).toEqual(['var(--color-text-secondary)']);
    }
    for (const [selector, size] of [
      ['.usage-overview-canvas .usage-section-heading strong', '17px'],
      ['.usage-token-donut-label strong', 'clamp(20px, 16cqi, 36px)'],
      ['.usage-token-donut-label span', '12.5px'],
      ['.usage-token-name', '13.5px'],
      ['.usage-token-count', '14.5px'],
      ['.usage-token-pct', '13.5px'],
      ['.usage-token-notes', '13.5px'],
      ['.usage-token-notes b', '18px'],
      ['.usage-token-context-group h3', '13.5px'],
      ['.usage-token-context-metrics dt', '12.5px'],
      ['.usage-token-context-metrics dd', '20px'],
    ]) {
      expect(declarations(styles, selector, 'font-size')).toEqual([size]);
    }
    expect(declarations(styles, '.usage-token-results .usage-token-context-metrics dt', 'font-size')).toEqual([]);
    for (const selector of ['.usage-token-count', '.usage-token-notes b', '.usage-token-context-metrics dd']) {
      expect(declarations(styles, selector, 'font-variant-numeric')).toEqual(['tabular-nums']);
    }
  });

  it('compacts only empty routing panels on the usage page', () => {
    const routing = readStyle('components/routing/RoutingPanel.css');
    expect(declarations(routing, '.usage-records-page .live-routing-panel', 'flex-shrink')).toEqual(['0']);
    expect(declarations(routing, '.usage-records-page .live-routing-panel:has(.live-routing-empty)', 'padding')).toEqual(['10px 16px']);
    expect(declarations(routing, '.usage-records-page .live-routing-empty', 'min-height')).toEqual(['44px']);
    expect(declarations(routing, '.usage-records-page .live-routing-empty', 'flex-direction')).toEqual(['row']);
    expect(declarations(routing, '.usage-records-page .live-routing-empty', 'gap')).toEqual(['10px']);
    for (const property of ['width', 'height']) {
      expect(declarations(routing, '.usage-records-page .live-routing-empty > svg', property)).toEqual(['18px']);
    }
  });

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

  it('keeps dashboard spacing compact without larger responsive overrides', () => {
    expect(declarations(home, '.home-page.home-dashboard', 'gap')).toEqual(['16px']);
    expect(declarations(home, '.home-top-grid', 'gap')).toEqual(['16px']);
    const panels = '.home-dashboard .home-top-grid > :is(.control-panel, .home-access-panel)';
    expect(declarations(home, panels, 'padding')).toEqual(['18px 20px']);
    expect(declarations(home, panels, 'gap')).toEqual(['14px']);
    expect(declarations(home, '.home-dashboard .control-panel .panel-detail-row', 'padding')).toEqual(['8px 0']);
  });

  it('uses smooth state transitions and disables them for reduced motion', () => {
    for (const [sheet, selector] of [
      [home, '.home-dashboard button'],
      [quota, '.quota-page .quota-category-filter button'],
      [clients, '.agents-page .agent-client-list .agent-list-items button'],
    ] as const) {
      const transitions = declarations(sheet, selector, 'transition');
      expect(transitions).toHaveLength(1);
      for (const property of ['color', 'background-color', 'border-color', 'box-shadow']) {
        expect(transitions[0].split(', ')).toContain(`${property} 0.15s ease`);
      }
      expect(declarations(sheet, selector, 'transition', true)).toEqual(['none']);
    }
  });

  it('keeps protocol selection bordered and softly highlighted without changing border width', () => {
    expect(declarations(home, '.home-protocol-tabs button', 'border')).toEqual(['1px solid transparent']);
    expect(declarations(home, '.home-protocol-tabs button.active', 'border')).toEqual(['1px solid var(--home-line)']);
    expect(declarations(home, '.home-protocol-tabs button.active', 'background')).toEqual([
      'color-mix(in srgb, var(--ui-accent) 6%, var(--bg-card))',
    ]);
  });

  it('keeps client selection distinct on hover and keyboard focus inside the clipped list', () => {
    const button = '.agents-page .agent-client-list .agent-list-items button';
    expect(declarations(clients, `${button}:hover:not(:disabled, .active)`, 'background')).toEqual(['var(--color-surface-hover)']);
    for (const selector of [`${button}.active`, `${button}.active:hover:not(:disabled)`]) {
      expect(declarations(clients, selector, 'border-color')).toEqual(['var(--ui-accent)']);
      expect(declarations(clients, selector, 'background')).toEqual(['var(--ui-accent-soft)']);
    }
    expect(declarations(clients, `${button}:focus-visible`, 'outline')).toEqual(['2px solid var(--ui-accent)']);
    expect(declarations(clients, `${button}:focus-visible`, 'outline-offset')).toEqual(['-3px']);
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
