import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';

const stylesheet = postcss.parse([
  '../src/styles/tokens/base.css',
  '../src/styles/tokens/semantic.css',
  '../src/styles/tokens/components.css',
  '../src/styles.css',
  '../src/styles/feature-pages.css',
  '../src/styles/ui-refinements.css',
].map((file) => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n'));
const aliases: Record<string, string> = {
  '--text-primary': '--color-text-primary',
  '--text-secondary': '--color-text-secondary',
  '--text-tertiary': '--color-text-tertiary',
  '--text-quaternary': '--color-text-muted',
  '--text-muted': '--color-text-tertiary',
};
const surfaces = [
  '--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-hover', '--bg-card',
  '--color-surface', '--color-surface-subtle',
  '--color-surface-hover', '--color-surface-active',
  '--color-workspace', '--ui-accent-soft',
];
const textTokens = [
  '--text-primary', '--text-secondary', '--text-tertiary', '--text-quaternary',
  '--text-muted', '--text-placeholder', '--color-text-primary', '--color-text-secondary',
  '--color-text-tertiary', '--color-text-muted',
];
type RGB = [number, number, number];

function declarations(selector: string): Record<string, string> {
  const values: Record<string, string> = {};
  stylesheet.walkRules((rule) => {
    if (rule.selector.replace(/\r\n/g, '\n') !== selector) return;
    rule.walkDecls((declaration) => { values[declaration.prop] = declaration.value; });
  });
  return values;
}

function resolve(value: string, tokens: Record<string, string>, seen = new Set<string>()): string {
  const match = /^var\((--[\w-]+)\)$/.exec(value);
  if (!match) return value;
  const name = match[1];
  if (!tokens[name] || seen.has(name)) throw new Error(`Invalid color token: ${name}`);
  return resolve(tokens[name], tokens, new Set([...seen, name]));
}

function color(value: string, backdrop: RGB = [255, 255, 255]): RGB {
  if (/^#[\da-f]{3}$/i.test(value)) value = `#${[...value.slice(1)].map((digit) => digit.repeat(2)).join('')}`;
  if (/^#[\da-f]{6}$/i.test(value)) {
    return [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)) as RGB;
  }
  const match = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/.exec(value);
  if (!match) throw new Error(`Unsupported color: ${value}`);
  const alpha = Number(match[4]);
  return backdrop.map((channel, index) => Number(match[index + 1]) * alpha + channel * (1 - alpha)) as RGB;
}

function luminance(rgb: RGB): number {
  const linear = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrast(foreground: RGB, background: RGB): number {
  const values = [luminance(foreground), luminance(background)];
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
}

for (const theme of ['light', 'dark'] as const) {
  describe(`${theme} text contrast`, () => {
    const tokens = {
      ...declarations(':root'),
      ...(theme === 'dark' ? declarations(":root[data-theme='dark']") : {}),
    };
    const value = (token: string) => resolve(tokens[token], tokens);

    it('uses semantic colors for legacy text variables instead of separate low-contrast values', () => {
      for (const [alias, semantic] of Object.entries(aliases)) {
        expect(tokens[alias]).toBe(`var(${semantic})`);
        expect(value(alias)).toBe(value(semantic));
      }
    });

    it('keeps normal text and placeholders at 4.5:1 across application surfaces', () => {
      const failures: string[] = [];
      for (const base of ['--bg-card', '--bg-secondary']) {
        const backdrop = color(value(base));
        for (const surface of surfaces) {
          const background = color(value(surface), backdrop);
          for (const token of textTokens) {
            const ratio = contrast(color(value(token)), background);
            if (ratio < 4.5) failures.push(`${token} on ${surface} over ${base}: ${ratio.toFixed(3)}`);
          }
        }
      }
      expect(failures).toEqual([]);
    });

    it('preserves background layers and reserves lower contrast for disabled text', () => {
      expect(value('--bg-primary')).toBe(theme === 'light' ? '#ffffff' : '#141720');
      expect(value('--bg-card')).toBe(theme === 'light' ? '#ffffff' : '#141720');
      expect(value('--bg-secondary')).toBe(theme === 'light' ? '#ffffff' : '#0b0d11');
      expect(value('--bg-tertiary')).toBe(theme === 'light' ? '#eff3f0' : '#1c212c');
      expect(value('--bg-hover')).toBe(theme === 'light' ? '#f6f8f6' : '#252b38');
      expect(value('--color-surface-sunken')).toBe(theme === 'light' ? '#ffffff' : '#0b0d11');
      const background = color(value('--bg-card'));
      const hierarchy = ['primary', 'secondary', 'tertiary', 'quaternary', 'disabled']
        .map((role) => contrast(color(value(`--text-${role}`)), background));
      for (let index = 1; index < hierarchy.length; index += 1) {
        expect(hierarchy[index - 1]).toBeGreaterThan(hierarchy[index]);
      }
    });
  });
}

it('renders placeholders at full opacity using the shared readable color', () => {
  expect(declarations('input::placeholder,\ntextarea::placeholder')).toMatchObject({
    color: 'var(--text-placeholder)', opacity: '1',
  });
  for (const selector of ['.compact-text-input::placeholder', '.simple-mode-field .text-input::placeholder']) {
    expect(declarations(selector).color).toBe('var(--text-placeholder)');
  }
});

it('does not fade interactive hidden-series labels or ordinary table hints', () => {
  for (const selector of ['.usage-trend-legend-item.is-hidden', '.usage-col-hint']) {
    expect(declarations(selector).color).toBe('var(--text-quaternary)');
    expect(declarations(selector).opacity).toBeUndefined();
  }
  expect(declarations('.usage-trend-legend-item.is-hidden')['text-decoration']).toBe('line-through');
  expect(declarations('.usage-trend-legend-item.is-hidden .usage-trend-swatch').opacity).toBe('0.38');
});

it('preserves the light semantic palette independently of workspace aliases', () => {
  const tokens = declarations(':root');
  for (const [name, expected] of Object.entries({
    '--color-text-secondary': '#1e293b',
    '--color-text-tertiary': '#334155',
    '--color-text-muted': '#475569',
    '--color-border-default': '#e2e8f0',
    '--color-surface-subtle': '#eff3f0',
    '--count-badge-bg': '#eff3f0',
    '--info-color': '#0f766e',
  })) expect(resolve(tokens[name], tokens)).toBe(expected);
});

it('preserves failure and danger button text semantics across light and dark themes', () => {
  expect(declarations('.usage-token-context-metrics .tone-failed dd').color).toBe('var(--usage-result-failed-text)');
  expect(declarations('.danger-button').color).toBe('var(--button-danger-soft-text)');
  const lightTokens = declarations(':root');
  const darkTokens = { ...declarations(':root'), ...declarations(":root[data-theme='dark']") };
  expect(resolve(lightTokens['--usage-result-failed-text'], lightTokens)).toBe('#b91c1c');
  expect(resolve(lightTokens['--button-danger-soft-text'], lightTokens)).toBe('#e11d48');
  expect(resolve(darkTokens['--usage-result-failed-text'], darkTokens)).toBe('#f87171');
  expect(resolve(darkTokens['--button-danger-soft-text'], darkTokens)).toBe('#fb7185');
});
