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
function resolveToken(value: string, tokens: Record<string, string>): string {
  let curr = value.trim();
  for (let i = 0; i < 15; i++) {
    const next = curr.replace(/var\((--[\w-]+)(?:,\s*((?:[^()]+|\([^()]*\))*))?\)/g, (_, name, fallback) => {
      return tokens[name] ?? (fallback ? fallback.trim() : '');
    });
    if (next === curr) break;
    curr = next;
  }
  return curr;
}

function hexToRgb(hex: string): [number, number, number] {
  let clean = hex.replace('#', '');
  if (clean.length === 3) clean = clean.split('').map((c) => c + c).join('');
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function luminance([r, g, b]: [number, number, number]): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function contrastRatio(hex1: string, hex2: string): number {
  const l1 = luminance(hexToRgb(hex1));
  const l2 = luminance(hexToRgb(hex2));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

describe('Stage 2 acceptance fixes regression', () => {
  const baseRoot = parseCss('styles/tokens/base.css');
  const semanticRoot = parseCss('styles/tokens/semantic.css');
  const compRoot = parseCss('styles/tokens/components.css');
  const surfacesRoot = parseCss('styles/surfaces.css');
  const workspaceWhiteRoot = parseCss('styles/workspace-white.css');
  const uiRefinementsRoot = parseCss('styles/ui-refinements.css');
  const quotaPageRoot = parseCss('pages/QuotaPage.css');
  const authFileQuotaPanelRoot = parseCss('components/AuthFileQuotaPanel.css');

  const baseLight = getDeclarations(baseRoot, ':root');
  const semanticLight = getDeclarations(semanticRoot, ':root');
  const compLight = getDeclarations(compRoot, ':root');
  const allTokensLight = { ...baseLight, ...semanticLight, ...compLight };

  const semanticDark = getDeclarations(semanticRoot, ":root[data-theme='dark']");
  const compDark = getDeclarations(compRoot, ":root[data-theme='dark']");
  const allTokensDark = { ...baseLight, ...semanticLight, ...compLight, ...semanticDark, ...compDark };

  it('P1-1: preserves credentials page primary text, muted text, and success badge colors without border mapping', () => {
    const lightText = resolveToken(compLight['--auth-file-text'], allTokensLight);
    const lightMuted = resolveToken(compLight['--auth-file-muted'], allTokensLight);
    const lightSuccess = resolveToken(compLight['--auth-file-success-color'], allTokensLight);
    const lightAccent = resolveToken(compLight['--auth-file-accent'], allTokensLight);

    expect(lightText).toBe('#1e293b');
    expect(lightMuted).toBe('#475569');
    expect(lightSuccess).toBe('#16b653');
    expect(lightAccent).toBe('#3b82f6');

    expect(contrastRatio(lightText, '#ffffff')).toBeGreaterThan(10);
    expect(contrastRatio(lightMuted, '#ffffff')).toBeGreaterThan(4.5);
    expect(contrastRatio(lightSuccess, '#ffffff')).toBeGreaterThan(2.5);

    const borderDefault = resolveToken('var(--color-border-default)', allTokensLight);
    expect(lightText).not.toBe(borderDefault);
    expect(lightMuted).not.toBe(borderDefault);
    expect(lightSuccess).not.toBe(borderDefault);

    const darkText = resolveToken(compDark['--auth-file-text'], allTokensDark);
    const darkMuted = resolveToken(compDark['--auth-file-muted'], allTokensDark);
    const darkSuccess = resolveToken(compDark['--auth-file-success-color'], allTokensDark);

    expect(darkText).toBe('#f1f5f9');
    expect(darkMuted).toBe('#cbd5e1');
    expect(darkSuccess).toBe('#34d399');

    const quotaMedium = getDeclarations(authFileQuotaPanelRoot, '.credential-quota-dense .credential-quota-row.medium')['--quota-color'];
    const quotaLow = getDeclarations(authFileQuotaPanelRoot, '.credential-quota-dense .credential-quota-row.low')['--quota-color'];
    expect(quotaMedium).not.toContain('border');
    expect(quotaLow).not.toContain('border');
    expect(resolveToken(quotaMedium, allTokensLight)).toBe('#c77b30');
    expect(resolveToken(quotaLow, allTokensLight)).toBe('#9f2d20');
  });

  it('P1-2: keeps usage analysis success, failed, and canceled series mutually distinct and readable', () => {
    const lightSuccess = resolveToken(compLight['--usage-analysis-success'], allTokensLight);
    const lightFailed = resolveToken(compLight['--usage-analysis-failed'], allTokensLight);
    const lightCanceled = resolveToken(compLight['--usage-analysis-canceled'], allTokensLight);

    expect(lightSuccess).toBe('#28a786');
    expect(lightFailed).toBe('#e66b70');
    expect(lightCanceled).toBe('#a8b1bf');

    expect(lightSuccess).not.toBe(lightFailed);
    expect(lightSuccess).not.toBe(lightCanceled);
    expect(lightFailed).not.toBe(lightCanceled);

    const borderDefault = resolveToken('var(--color-border-default)', allTokensLight);
    expect(lightSuccess).not.toBe(borderDefault);
    expect(lightFailed).not.toBe(borderDefault);
    expect(lightCanceled).not.toBe(borderDefault);

    expect(contrastRatio(lightFailed, '#ffffff')).toBeGreaterThan(2.5);

    const darkSuccess = resolveToken(compDark['--usage-analysis-success'], allTokensDark);
    const darkFailed = resolveToken(compDark['--usage-analysis-failed'], allTokensDark);
    const darkCanceled = resolveToken(compDark['--usage-analysis-canceled'], allTokensDark);

    expect(darkSuccess).toBe('#49b7a1');
    expect(darkFailed).toBe('#eb8c80');
    expect(darkCanceled).toBe('#8896a9');
  });

  it('P1-3: danger button preserves red semantics across normal, hover, and disabled states', () => {
    const dangerDecls = getDeclarations(uiRefinementsRoot, '.danger-button');
    const hoverDecls = getDeclarations(uiRefinementsRoot, '.danger-button:hover:not(:disabled)');

    const lightNormalText = resolveToken(dangerDecls.color, allTokensLight);
    const lightNormalBg = resolveToken(dangerDecls.background, allTokensLight);
    const lightNormalBorder = resolveToken(dangerDecls.border, allTokensLight);

    expect(lightNormalText).toBe('#e11d48');
    expect(lightNormalBg).toBe('#fff1f2');
    expect(lightNormalBorder).toBe('1px solid #fecdd3');

    const darkNormalText = resolveToken(dangerDecls.color, allTokensDark);
    const darkNormalBg = resolveToken(dangerDecls.background, allTokensDark);
    const darkNormalBorder = resolveToken(dangerDecls.border, allTokensDark);

    expect(darkNormalText).toBe('#fb7185');
    expect(darkNormalBg).toBe('rgba(225, 29, 72, 0.14)');
    expect(darkNormalBorder).toBe('1px solid rgba(225, 29, 72, 0.35)');

    const lightHoverBg = resolveToken(hoverDecls.background, allTokensLight);
    const lightHoverBorder = resolveToken(hoverDecls['border-color'], allTokensLight);
    const lightHoverText = resolveToken(hoverDecls.color, allTokensLight);

    expect(lightHoverBg).toBe('#e11d48');
    expect(lightHoverBorder).toBe('#e11d48');
    expect(lightHoverText).toBe('#ffffff');

    const darkHoverBg = resolveToken(hoverDecls.background, allTokensDark);
    const darkHoverBorder = resolveToken(hoverDecls['border-color'], allTokensDark);
    const darkHoverText = resolveToken(hoverDecls.color, allTokensDark);

    expect(darkHoverBg).toBe('#e11d48');
    expect(darkHoverBorder).toBe('#e11d48');
    expect(darkHoverText).toBe('#ffffff');
  });

  it('P2-1: dark usage collector has no border and preserves toolbar dimensions', () => {
    const lightBorder = resolveToken(compLight['--usage-collector-border'], allTokensLight);
    const darkBorder = resolveToken(compDark['--usage-collector-border'], allTokensDark);

    expect(lightBorder).toBe('1px solid #dce3eb');
    expect(darkBorder).toBe('none');

    const darkBg = resolveToken(compDark['--usage-collector-bg'], allTokensDark);
    expect(darkBg).toBe('#2c2c2e');

    const collectorDecls = getDeclarations(workspaceWhiteRoot, '.workspace .usage-records-page\n  .usage-collector-state');
    expect(collectorDecls.border).toBe('var(--usage-collector-border)');
    expect(collectorDecls.background).toBe('var(--usage-collector-bg)');
  });

  it('P2-4: surface-sunken implements subtle background and subtle border', () => {
    const sunkenDecls = getDeclarations(surfacesRoot, ':where(.surface-sunken)');
    expect(sunkenDecls.background).toBe('var(--color-surface-subtle)');
    expect(sunkenDecls.border).toBe('var(--card-border-width) solid var(--color-border-subtle)');

    const lightBg = resolveToken(sunkenDecls.background, allTokensLight);
    const lightBorder = resolveToken(sunkenDecls.border, allTokensLight);
    expect(lightBg).toBe('#eff3f0');
    expect(lightBorder).toBe('1px solid #f1f5f9');

    const darkBg = resolveToken(sunkenDecls.background, allTokensDark);
    const darkBorder = resolveToken(sunkenDecls.border, allTokensDark);
    expect(darkBg).toBe('#1c212c');
    expect(darkBorder).toBe('1px solid #222836');
  });

  it('P2-5: request log series do not borrow status tokens and stay distinct', () => {
    const seriesTokens = [
      '--request-log-input',
      '--request-log-output',
      '--request-log-reasoning',
      '--request-log-cache-read',
      '--request-log-cache-write',
      '--request-log-response-model',
    ];

    for (const token of seriesTokens) {
      expect(compLight[token]).not.toContain('color-info');
      expect(compLight[token]).not.toContain('color-warning');
      expect(compLight[token]).not.toContain('color-success');
      expect(compLight[token]).not.toContain('color-danger');
    }

    const inputVal = resolveToken(compLight['--request-log-input'], allTokensLight);
    const outputVal = resolveToken(compLight['--request-log-output'], allTokensLight);
    const reasoningVal = resolveToken(compLight['--request-log-reasoning'], allTokensLight);

    expect(inputVal).toBe('#2563eb');
    expect(outputVal).toBe('#0f766e');
    expect(reasoningVal).toBe('#b45309');
    expect(inputVal).not.toBe(outputVal);
    expect(inputVal).not.toBe(reasoningVal);
    expect(outputVal).not.toBe(reasoningVal);
  });

  it('P2-2: removes duplicate real-quota-track rule in QuotaPage.css', () => {
    let count = 0;
    quotaPageRoot.walkRules((rule) => {
      if (rule.selector === '.quota-page .real-quota-track span') {
        count++;
      }
    });
    expect(count).toBe(1);
  });

  it('Rework 2: verifies all newly restored component and semantic values', () => {
    expect(resolveToken(compLight['--usage-request-color'], allTokensLight)).toBe('#1d1d1f');
    expect(resolveToken(compDark['--usage-request-color'], allTokensDark)).toBe('#f5f5f7');
    expect(resolveToken(compLight['--usage-subpage-muted'], allTokensLight)).toBe('#526071');
    expect(resolveToken(compLight['--usage-th-color'], allTokensLight)).toBe('#3e4c5a');
    expect(resolveToken(compDark['--usage-th-color'], allTokensDark)).toBe('#d5deea');
    expect(resolveToken(compLight['--status-dot-success-bg'], allTokensLight)).toBe('#10b981');
    expect(resolveToken(compLight['--config-dialog-shadow'], allTokensLight)).toBe('0 18px 48px rgba(45, 42, 38, 0.24)');
    expect(resolveToken(compLight['--state-pill-success-bg'], allTokensLight)).toBe('#f0fdf4');
    expect(resolveToken(compLight['--state-pill-success-text'], allTokensLight)).toBe('#15803d');
    expect(resolveToken(compLight['--agent-claude-toggle-checked-text'], allTokensLight)).toBe('#554075');
    expect(resolveToken(compDark['--agent-claude-toggle-checked-text'], allTokensDark)).toBe('#b0aaa2');
    expect(resolveToken(compLight['--usage-token-input'], allTokensLight)).toBe('#5595f9');
    expect(resolveToken(compLight['--usage-token-output'], allTokensLight)).toBe('#22b573');
    expect(resolveToken(compLight['--usage-token-cache-read'], allTokensLight)).toBe('#ed9205');
    expect(resolveToken(compLight['--usage-token-cache-creation'], allTokensLight)).toBe('#ee5182');

    const stylesRoot = parseCss('styles.css');
    const providerEnabledColor = getDeclarations(stylesRoot, '.provider-enabled-control').color;
    expect(providerEnabledColor).toBe('var(--color-text-tertiary)');

    const categoryColor = getDeclarations(stylesRoot, '.app-release-notes-markdown > .release-notes-category').color;
    expect(categoryColor).toBe('var(--color-text-secondary)');

    const featureRoot = parseCss('styles/feature-pages.css');
    const connectorBg = getDeclarations(featureRoot, '.simple-mode-step-status-connector').background;
    expect(connectorBg).toBe('var(--color-border-strong)');
  });
});

describe('Stage 2 review 4 cleanup', () => {
  it('keeps component colors on semantic inputs without color-named aliases or unreachable fallbacks', () => {
    const css = readFileSync(join(srcDir, 'styles/tokens/components.css'), 'utf8');
    expect(css).not.toMatch(/var\(--theme-(?:[\da-f]{3}|[\da-f]{6})\b/);
    expect(css).not.toContain('--theme-primary-contrast');
    expect(css).not.toContain('--model-config-card-bg');
    const root = getDeclarations(parseCss('styles/tokens/components.css'), ':root');
    expect(root['--config-network-section-color']).toBe('var(--theme-text-secondary, #334155)');
    expect(root['--config-count-bg']).toBe('var(--theme-soft-surface, #ffffff)');
    expect(root['--config-key-index-bg']).toBe('var(--theme-soft-surface, #ffffff)');
    expect(root['--usage-trend-grid-stroke']).toBe('var(--color-border-default)');
    expect(root['--switch-track-bg']).toBe('var(--color-border-subtle)');
  });

  it('uses the shared button appearance path and keeps the copy layout selector minimal', () => {
    const subpages = parseCss('styles/usage-subpages.css');
    const privateRules: string[] = [];
    subpages.walkRules((rule) => {
      if (rule.selector.includes('.usage-error-copy')) {
        rule.walkDecls((decl) => {
          if (/^(?:color|border|background)/.test(decl.prop)) privateRules.push(rule.selector);
        });
      }
    });
    expect(privateRules).toEqual([]);
    const layout = parseCss('pages/UsageEventsView.css');
    expect(getDeclarations(layout, '.usage-request-log .usage-error-copy').flex).toBe('0 0 24px');
    expect(getDeclarations(layout, '.usage-records-page .usage-request-log .usage-error-copy')).toEqual({});
  });
});

describe('Stage 2 review 5 cleanup', () => {
  it('inherits identical danger hover values from the root', () => {
    const root = parseCss('styles/tokens/components.css');
    const dark = getDeclarations(root, ":root[data-theme='dark']");
    for (const property of ['--button-danger-hover-bg', '--button-danger-hover-border', '--button-danger-hover-text']) {
      expect(dark[property]).toBeUndefined();
      expect(getDeclarations(root, ':root')[property]).toBeDefined();
    }
  });
});
