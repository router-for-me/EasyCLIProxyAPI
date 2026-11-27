import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postcss from 'postcss';

const srcDir = join(import.meta.dir, '../src');

function parseCss(relPath: string) {
  return postcss.parse(readFileSync(join(srcDir, relPath), 'utf8'));
}

function getDeclarations(root: postcss.Root, selector: string): Record<string, string> {
  const decls: Record<string, string> = {};
  root.walkRules((rule) => {
    if (rule.selector === selector) {
      rule.walkDecls((decl) => {
        decls[decl.prop] = decl.value;
      });
    }
  });
  return decls;
}

describe('window close button red highlight tokens', () => {
  const compRoot = parseCss('styles/tokens/components.css');
  const frameRoot = parseCss('components/WindowFrame.css');
  const compLight = getDeclarations(compRoot, ':root');
  const compDark = getDeclarations(compRoot, ":root[data-theme='dark']");

  it('defines Windows red hover/active background and white glyph tokens shared across themes', () => {
    expect(compLight['--window-close-hover-bg']).toBe('#c42b1c');
    expect(compLight['--window-close-active-bg']).toBe('#a82317');
    expect(compLight['--window-close-hover-text']).toBe('#ffffff');
    expect(compDark['--window-close-hover-bg']).toBeUndefined();
    expect(compDark['--window-close-active-bg']).toBeUndefined();
    expect(compDark['--window-close-hover-text']).toBeUndefined();
  });

  it('applies red close button tokens on hover, focus-visible, and active states', () => {
    expect(getDeclarations(frameRoot, '.window-controls .window-close:hover')).toEqual({
      background: 'var(--window-close-hover-bg)',
      color: 'var(--window-close-hover-text)',
    });
    expect(getDeclarations(frameRoot, '.window-controls .window-close:focus-visible')).toEqual({
      background: 'var(--window-close-hover-bg)',
      color: 'var(--window-close-hover-text)',
    });
    expect(getDeclarations(frameRoot, '.window-controls .window-close:active')).toEqual({
      background: 'var(--window-close-active-bg)',
      color: 'var(--window-close-hover-text)',
    });
  });
});
