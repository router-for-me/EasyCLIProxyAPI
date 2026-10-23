import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postcss from 'postcss';

const componentsCss = readFileSync(join(import.meta.dir, '../src/styles/tokens/components.css'), 'utf8');
const baseCss = readFileSync(join(import.meta.dir, '../src/styles/tokens/base.css'), 'utf8');

function getRootDeclarations(css: string): Record<string, string> {
  const root = postcss.parse(css);
  const decls: Record<string, string> = {};
  root.walkRules((rule) => {
    if (rule.selector === ':root') {
      rule.walkDecls((decl) => {
        decls[decl.prop] = decl.value;
      });
    }
  });
  return decls;
}

describe('request log semantic tokens regression', () => {
  it('maps request log metric, duration, and subpage colors to expected tokens and palette', () => {
    const baseDecls = getRootDeclarations(baseCss);
    const compDecls = getRootDeclarations(componentsCss);

    expect(baseDecls['--palette-blue-600']).toBe('#2563eb');
    expect(baseDecls['--palette-teal-600']).toBe('#0f766e');

    expect(compDecls['--request-log-input']).toBe('var(--palette-blue-600)');
    expect(compDecls['--request-log-output']).toBe('var(--palette-teal-600)');
    expect(compDecls['--request-log-cache-read']).toBe('var(--palette-teal-600)');
    expect(compDecls['--request-log-reasoning']).toBe('#b45309');
    expect(compDecls['--request-log-cache-write']).toBe('#b45309');
    expect(compDecls['--request-log-response-model']).toBe('#9a5808');
    expect(compDecls['--request-log-duration-good']).toBe('#16a34a');
    expect(compDecls['--request-log-duration-warn']).toBe('#d97706');
    expect(compDecls['--request-log-duration-bad']).toBe('#dc2626');

    expect(compDecls['--request-log-text']).toBe('var(--color-text-primary)');
    expect(compDecls['--request-log-muted']).toBe('var(--color-text-muted)');
    expect(compDecls['--request-log-line']).toBe('var(--color-border-default)');
    expect(compDecls['--usage-subpage-text']).toBe('var(--theme-text-primary, #17212f)');
    expect(compDecls['--usage-subpage-muted']).toBe('var(--theme-text-muted, #526071)');

    expect(compDecls['--request-log-input']).not.toBe(compDecls['--request-log-output']);
    expect(compDecls['--request-log-input']).not.toBe(compDecls['--request-log-reasoning']);
    expect(compDecls['--request-log-output']).not.toBe(compDecls['--request-log-reasoning']);

    const dataSeriesTokens = [
      '--request-log-input',
      '--request-log-output',
      '--request-log-reasoning',
      '--request-log-cache-read',
      '--request-log-cache-write',
      '--request-log-response-model',
    ];
    for (const token of dataSeriesTokens) {
      expect(compDecls[token]).not.toContain('color-info');
      expect(compDecls[token]).not.toContain('color-warning');
      expect(compDecls[token]).not.toContain('color-success');
      expect(compDecls[token]).not.toContain('color-danger');
    }
    const validatedTokens = [
      '--request-log-input',
      '--request-log-output',
      '--request-log-reasoning',
      '--request-log-cache-read',
      '--request-log-cache-write',
      '--request-log-response-model',
      '--request-log-duration-good',
      '--request-log-duration-warn',
      '--request-log-duration-bad',
      '--usage-subpage-text',
      '--usage-subpage-muted',
    ];

    for (const token of validatedTokens) {
      expect(compDecls[token]).not.toContain('border');
      expect(compDecls[token]).not.toContain('surface');
    }
  });
});
