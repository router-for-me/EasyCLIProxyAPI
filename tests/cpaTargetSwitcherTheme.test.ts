import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { themeTokenProperties } from '../src/themes/types';

const css = postcss.parse(readFileSync(new URL('../src/components/CpaTargetSwitcher.css', import.meta.url), 'utf8'));
function value(selector: string, property: string) {
  let result: string | undefined;
  css.walkRules(rule => {
    if (!rule.selectors.includes(selector)) return;
    rule.walkDecls(property, declaration => { result = declaration.value; });
  });
  return result;
}

describe('CPA target selector theme integration', () => {
  it('uses the sidebar palette independently of workspace surfaces', () => {
    expect(value('.sidebar .cpa-target-trigger', 'background')).toBe('transparent');
    expect(value('.sidebar .cpa-target-trigger', 'color')).toBe('var(--sidebar-text)');
    expect(value('.sidebar .cpa-target-trigger-text small', 'color')).toBe('var(--sidebar-text-subtle)');
    expect(value('.sidebar .cpa-target-menu', 'background')).toBe('var(--sidebar-popover-bg)');
    expect(value('.sidebar .cpa-target-menu', 'border-color')).toBe('var(--sidebar-popover-edge)');
    expect(value('.sidebar .cpa-target-menu', 'box-shadow')).toBe('var(--sidebar-popover-shadow)');
    expect(value('.cpa-target-trigger', 'background')).toBe('var(--color-surface)');
  });
  it('keeps selection, hover, press and keyboard focus themed', () => {
    expect(value(".sidebar .cpa-target-trigger[aria-expanded='true']", 'background')).toBe('var(--sidebar-selected-bg)');
    expect(value(".sidebar .cpa-target-menu > button[aria-checked='true']", 'background')).toBe('var(--sidebar-selected-bg)');
    expect(value('.sidebar .cpa-target-trigger:hover:not(:disabled)', 'background')).toBe('var(--sidebar-hover-bg)');
    expect(value('.sidebar .cpa-target-menu > button:is(:hover,:focus-visible)', 'background')).toBe('var(--sidebar-hover-bg)');
    expect(value('.sidebar .cpa-target-menu > button:active', 'background')).toBe('var(--sidebar-press-bg)');
    expect(value('.sidebar .cpa-target-trigger:focus-visible', 'outline-color')).toBe('var(--sidebar-focus)');
    expect(value('.sidebar .cpa-target-menu > button:focus-visible', 'outline-color')).toBe('var(--sidebar-focus)');
    expect(value('.cpa-target-trigger:focus-visible', 'outline')).toBe('2px solid var(--ui-focus-ring)');
  });
  it('consumes registered custom-theme slots rather than appearance-specific literals', () => {
    const registered = new Set(Object.values(themeTokenProperties).flat());
    for (const property of ['--sidebar-text', '--sidebar-text-subtle', '--sidebar-popover-bg', '--sidebar-popover-edge', '--sidebar-selected-bg', '--sidebar-hover-bg', '--sidebar-focus']) {
      expect(registered.has(property)).toBe(true);
    }
    expect(css.toString()).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(/i);
  });
});
