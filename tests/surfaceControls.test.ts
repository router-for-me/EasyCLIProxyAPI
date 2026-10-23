import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import postcss from 'postcss';
import ts from 'typescript';

const root = join(import.meta.dir, '..', 'src');
const migrated: Record<string, string[]> = {
  'plugin-card': ['surface-card'],
  'plugin-settings-card': ['surface-card'],
  'oauth-page-toolbar': ['surface-card'],
  'structured-list-item': ['surface-card'],
  'structured-map-item': ['surface-card'],
  'template-config-custom': ['surface-section'],
  'config-search-result-list': ['surface-card'],
  'config-keys-panel': ['surface-card'],
  'config-management-panel': ['surface-card'],
  'config-network-section': ['surface-card'],
  'config-diagnostics-panel': ['surface-card'],
  'config-software-panel': ['surface-card'],
  'config-sensitive-words-panel': ['surface-bare'],
  'thinking-alias-list-panel': ['surface-bare'],
  'version-list': ['surface-bare'],
  'version-metric-tile': ['surface-section', 'surface-muted'],
  'oauth-card': ['surface-panel'],
  'agent-config-panel': ['surface-panel'],
  'auth-files-panel': ['surface-bare'],
  'model-discovery-content': ['surface-section'],
  'model-transfer-panel': ['surface-section'],
  'provider-settings-group': ['surface-section'],
  'model-config-card': ['surface-section', 'surface-muted'],
  'agent-claude-desktop-mapping-row': ['surface-section'],
  'agent-desktop-model-row': ['surface-section'],
  'agent-claude-code-runtime-settings': ['surface-section', 'surface-muted'],
  'codex-session-overview': ['surface-section', 'surface-muted'],
  'codex-session-list-section': ['surface-section'],
  'codex-session-repair-panel': ['surface-section'],
  'codex-session-list': ['surface-section'],
  'codex-session-cleanup-list': ['surface-section'],
  'codex-catalog-body': ['surface-section'],
  'context-meta-card': ['surface-section'],
  'context-add-message-card': ['surface-section'],
  'context-message-card': ['surface-section'],
  'control-panel': ['surface-panel'],
  'home-access-panel': ['surface-panel'],
  'home-stat-grid': ['surface-card'],
  'home-connection-details': ['surface-bare'],
  'client-api-card': ['surface-bare'],
  'usage-filter-panel': ['surface-bare'],
  'usage-stat-grid': ['surface-card'],
  'usage-trend-panel': ['surface-card'],
  'usage-health-panel': ['surface-card'],
  'usage-analysis-card': ['surface-card'],
  'usage-analysis-context': ['surface-card'],
  'usage-activity-card': ['surface-card'],
  'usage-pricing-panel': ['surface-card'],
  'usage-data-management-panel': ['surface-card'],
  'usage-data-management-action': ['surface-card'],
  'usage-price-editor': ['surface-section'],
  'usage-data-management-result-item': ['surface-card'],
  'credential-settings-catalog': ['surface-frame'],
  'provider-template-rule': ['surface-frame'],
  'provider-template-section': ['surface-frame'],
  'codex-catalog-choice-group': ['surface-frame'],
  'plugin-oauth-code': ['surface-frame', 'surface-muted'],
  'plugin-source-errors': ['surface-frame'],
  'version-source-row': ['surface-panel'],
  'version-list-item': ['surface-panel'],
  'app-release-notes': ['surface-panel'],
  'auth-file-card': ['surface-card'],
  'real-quota-card': ['surface-card'],
  'quota-reset-credit-summary': ['surface-section', 'surface-muted'],
  'model-config-summary': ['surface-dashed'],
  'provider-cloak-settings': ['surface-dashed'],
  'provider-advanced-settings': ['surface-sunken'],
  'thinking-level-config': ['surface-sunken'],
  'provider-group-key': ['surface-sunken'],
  'oauth-auth-url-box': ['surface-sunken'],
  'vertex-login-result': ['surface-sunken'],
  'usage-token-context-group': ['surface-sunken'],
  'credential-alias-details': ['surface-sunken'],
  'agent-core-setting-section': ['surface-section'],
  'deepseek-harness-launch-options': ['surface-section', 'surface-muted'],
};
const ids = new Set(['config-native-aliases', 'config-native-sensitive-words']);
const stateSelectors: Record<string, Record<string, RegExp>> = {
  'styles/config-settings.css': {
    '.config-settings-cards > section:focus-visible, .config-settings-content .template-config-card:focus-visible': /^outline(?:-offset)?$/,
  },
  'styles/template-config.css': {
    '.template-config-field-dirty .config-network-input, .template-config-field-dirty .template-config-custom': /^border-color$/,
  },
  'styles/ui-refinements.css': {
    '.usage-stat-card': /^outline$/,
    '.oauth-card.is-waiting': /^border-color$/,
    '.oauth-card:hover': /^(?:border-color|box-shadow)$/,
  },
  'styles.css': {
    '.agent-claude-desktop-mapping-row:has(.agent-claude-context-toggle input:checked)': /^(?:border-color|box-shadow)$/,
    '.context-message-card': /^border-left(?:-|$)/,
    '.context-message-card.deleted': /^(?:background|border-style)$/,
    '.context-message-card.modified': /^border-color$/,
    '.context-message-card.new-item': /^border-style$/,
  },
};
const appearance = /^(?:background(?:-|$)|border(?:-|$)|outline(?:-|$)|box-shadow$)/;
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? walk(path) : [path];
});
const markupFiles = () => [
  ...walk(root).filter(path => path.endsWith('.tsx')),
  ...walk(join(import.meta.dir, 'fixtures')).filter(path => path.endsWith('.tsx')),
];
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

const split = (text: string, comma = false) => {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\\') { i++; continue; }
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '(' || char === '[') depth++;
    if (char === ')' || char === ']') depth--;
    if (!depth && (comma ? char === ',' : /[\s>+~]/.test(char))) {
      if (text.slice(start, i).trim()) parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (text.slice(start).trim()) parts.push(text.slice(start).trim());
  return parts;
};
const subjects = (selector: string): string[] => split(selector, true).flatMap(part => {
  const subject = split(part).at(-1) ?? '';
  const nested: string[] = [];
  let plain = '';
  for (let i = 0; i < subject.length; i++) {
    const match = subject.slice(i).match(/^:(is|where|not|has)\(/);
    if (!match) { plain += subject[i]; continue; }
    const start = i + match[0].length;
    let end = start;
    let depth = 1;
    for (; end < subject.length && depth; end++) {
      if (subject[end] === '(') depth++;
      if (subject[end] === ')') depth--;
    }
    if (match[1] === 'is' || match[1] === 'where') nested.push(...subjects(subject.slice(start, end - 1)));
    i = end - 1;
  }
  return [plain, ...nested];
});
const tokens = (subject: string) => [...subject.replace(/\[[^\]]*\]/g, '').matchAll(/[.#]([\w-]+)/g)].map(match => match[1]);
const containerSelector = (selector: string) => subjects(selector).some(subject => {
  if (tokens(subject).some(token => token in migrated || ids.has(token) || token.startsWith('surface-'))) return true;
  return /^section(?:$|[.:#[])/.test(subject) && selector.includes('.config-settings-cards');
});
const cssViolations = (text: string, file: string) => {
  const violations: string[] = [];
  postcss.parse(text).walkRules(rule => {
    if (/\.quiet-panel(?![\w-])/.test(rule.selector)) violations.push(`${file} uses retired quiet-panel`);
    const container = containerSelector(rule.selector);
    const statCard = subjects(rule.selector).some(subject => tokens(subject).includes('usage-stat-card'));
    if (!container && !statCard) return;
    if (file === 'styles/surfaces.css' && [
      '.panel, .surface-panel', '.panel:hover, .surface-panel:hover',
      ':where(.surface-card), .panel.surface-card', ':where(.surface-section)',
      ':where(.surface-muted)', ':where(.surface-bare), .panel.surface-bare',
      ':where(.surface-frame)', ':where(.surface-dashed)', ':where(.surface-sunken)',
    ].includes(normalize(rule.selector))) return;
    const allowed = stateSelectors[file]?.[normalize(rule.selector)];
    for (const declaration of rule.nodes) {
      if (declaration.type === 'decl' && (container ? appearance.test(declaration.prop) : statCard && /^outline(?:-|$)/.test(declaration.prop))) {
        if (allowed && allowed.test(declaration.prop)) continue;
        violations.push(`${file}:${rule.source?.start?.line} ${normalize(rule.selector)} ${declaration.prop}`);
      }
    }
  });
  return violations;
};
const jsxViolations = (text: string, file: string) => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
      const literals = (name: string) => {
        const values: string[] = [];
        const visitValue = (item: ts.Node) => {
          if (ts.isStringLiteralLike(item) || ts.isTemplateHead(item) || ts.isTemplateMiddle(item) || ts.isTemplateTail(item)) values.push(...item.text.split(/\s+/));
          ts.forEachChild(item, visitValue);
        };
        const value = attrs.find(attr => attr.name.getText(source) === name)?.initializer;
        if (value) visitValue(value);
        return values;
      };
      const classes = literals('className');
      for (const hook of classes) for (const required of migrated[hook] ?? []) {
        if (!classes.includes(required)) violations.push(`${file} ${hook} requires ${required}`);
      }
      if (literals('id').some(id => ids.has(id)) && !classes.includes('surface-card')) violations.push(`${file} settings region requires surface-card`);
      if (classes.includes('quiet-panel')) violations.push(`${file} uses retired quiet-panel`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
};

const orderedStyles = (file: string): postcss.Root[] => {
  const sheet = postcss.parse(readFileSync(file, 'utf8'));
  const imported: postcss.Root[] = [];
  sheet.walkAtRules('import', rule => {
    const target = rule.params.match(/['"]([^'"]+)['"]/)?.[1];
    if (target) imported.push(...orderedStyles(resolve(dirname(file), target)));
  });
  return [...imported, sheet];
};
const usageStatAppearance = (hover: boolean) => {
  const rules: { priority: number; declarations: Record<string, string> }[] = [];
  for (const sheet of orderedStyles(join(root, 'styles/index.css'))) sheet.walkRules(rule => {
    if (rule.parent?.type !== 'root') return;
    for (const selector of rule.selectors) {
      if (!['.panel', '.usage-stat-card', ...(hover ? ['.panel:hover', '.usage-stat-card:hover'] : [])].includes(selector)) continue;
      const declarations: Record<string, string> = {};
      for (const node of rule.nodes) if (node.type === 'decl') declarations[node.prop] = node.value;
      rules.push({ priority: selector.includes(':hover') ? 2 : 1, declarations });
    }
  });
  return Object.assign({}, ...rules.sort((a, b) => a.priority - b.priority).map(rule => rule.declarations)) as Record<string, string>;
};

describe('shared container surfaces', () => {
  it('keeps migrated container appearance in the shared stylesheet', () => {
    const violations = walk(root).filter(path => path.endsWith('.css')).flatMap(path => cssViolations(readFileSync(path, 'utf8'), relative(root, path).replaceAll('\\', '/')));
    expect(violations).toEqual([]);
  });
  it('requires shared classes at migrated markup and region IDs', () => {
    const tsxFiles = markupFiles();
    expect(tsxFiles).toContain(join(import.meta.dir, 'fixtures/themeExtensions.tsx'));
    const violations = tsxFiles.flatMap(path => jsxViolations(readFileSync(path, 'utf8'), relative(join(root, '..'), path).replaceAll('\\', '/')));
    expect(violations).toEqual([]);
  });
  it('keeps surface definitions before theme overrides without padding or material rules', () => {
    const css = readFileSync(join(root, 'styles/surfaces.css'), 'utf8');
    const index = readFileSync(join(root, 'styles/index.css'), 'utf8');
    const imports: string[] = [];
    postcss.parse(index).walkAtRules('import', rule => { imports.push(rule.params.match(/['"]([^'"]+)['"]/)?.[1] ?? ''); });
    const surfaceIndex = imports.indexOf('./surfaces.css');
    expect(surfaceIndex).toBeGreaterThan(imports.indexOf('./feature-pages.css'));
    expect(surfaceIndex).toBeLessThan(imports.indexOf('./ui-refinements.css'));
    for (const theme of imports.filter(file => /\/theme-[^/]+\.css$/.test(file))) expect(surfaceIndex).toBeLessThan(imports.indexOf(theme));
    expect(css.indexOf('.panel:hover')).toBeLessThan(css.indexOf('.panel.surface-card'));
    for (const name of ['surface-panel', 'surface-card', 'surface-section', 'surface-muted', 'surface-bare']) expect(css).toContain('.' + name);
    expect(css).not.toMatch(/padding|!important|window-material/);
    expect(readFileSync(join(root, 'styles.css'), 'utf8')).not.toContain('.quiet-panel');
  });
  it('keeps usage stat cards flat and preserves their own hover after shared panel defaults', () => {
    const normal = usageStatAppearance(false);
    expect(normal.border).toBe('0');
    expect(normal['border-radius']).toBe('var(--radius-none)');
    expect(normal['box-shadow']).toBe('none');
    const hover = usageStatAppearance(true);
    expect(hover.border).toBe('0');
    expect(hover['border-radius']).toBe('var(--radius-none)');
    expect(hover['border-color']).toBe('transparent');
    expect(hover['box-shadow']).toBe('var(--usage-stat-hover-shadow)');
  });
  it('rejects appearance mutations including logical properties and pseudo-elements', () => {
    for (const prop of ['border', 'background', 'border-radius', 'box-shadow', 'outline', 'outline-color', 'outline-offset', 'border-inline-start-color', 'border-start-start-radius', 'background-image']) {
      for (const selector of ['.plugin-card', ':is(.page .plugin-card, .other)', ':where(.plugin-card)', '.plugin-card:not(.selected)', '.plugin-card:has(input:checked)', '.plugin-card::before', '#config-native-aliases', '.config-settings-cards > section', '.page:has(.x) > :is(.plugin-card)']) {
        expect(cssViolations(`${selector} { ${prop}: initial }`, 'pages/Example.css')).toHaveLength(1);
      }
    }
  });
  it('permits layout, child controls and only the precise existing state rules', () => {
    for (const selector of ['.plugin-card', '.plugin-card:not(.selected)', '.plugin-card:has(input)']) expect(cssViolations(`${selector} { padding: 2px; gap: 4px; width: 100% }`, 'pages/Example.css')).toEqual([]);
    for (const selector of ['.page:has(.plugin-card)', '.page:not(.plugin-card)', '.plugin-card > button', '.plugin-card input', '.unmigrated-card']) expect(cssViolations(`${selector} { background: red }`, 'pages/Example.css')).toEqual([]);
    expect(cssViolations('.template-config-field-dirty .config-network-input, .template-config-field-dirty .template-config-custom { border-color: red }', 'styles/template-config.css')).toEqual([]);
    expect(cssViolations('.template-config-field-dirty .config-network-input, .template-config-field-dirty .template-config-custom { border-color: red }', 'pages/Example.css')).toHaveLength(1);
    expect(cssViolations('.surface-card.private-card { background: red }', 'styles/surfaces.css')).toHaveLength(1);
    expect(cssViolations('.quiet-panel { gap: 1px }', 'pages/Example.css')).toHaveLength(1);
    expect(cssViolations('.plugin-card { background: red }', 'styles/surfaces.css')).toHaveLength(1);
    expect(cssViolations('.template-config-field-dirty .template-config-custom:hover { background: red }', 'styles/template-config.css')).toHaveLength(1);
    expect(cssViolations('.oauth-card { border: 1px solid red }', 'pages/Example.css')).toHaveLength(1);
    expect(cssViolations('.model-discovery-content { background: red }', 'pages/Example.css')).toHaveLength(1);
    expect(cssViolations('.codex-session-list { border-radius: 12px }', 'pages/Example.css')).toHaveLength(1);
    expect(cssViolations('.context-meta-card { box-shadow: 0 1px 3px black }', 'pages/Example.css')).toHaveLength(1);
    expect(cssViolations('.oauth-card.is-waiting { border-color: red }', 'styles/ui-refinements.css')).toEqual([]);
    expect(cssViolations('.oauth-card.unauthorized { border-color: red }', 'styles/ui-refinements.css')).toHaveLength(1);
    expect(cssViolations('.context-message-card.deleted { border-color: red }', 'styles.css')).toHaveLength(1);
    expect(cssViolations('.context-message-card:hover { background: red }', 'styles.css')).toHaveLength(1);
    expect(cssViolations('.agent-claude-desktop-mapping-row:hover { border-color: red }', 'styles.css')).toHaveLength(1);
    expect(cssViolations('.context-message-card { background: red; border-radius: 14px; box-shadow: 0 0 0 4px red }', 'styles.css')).toHaveLength(3);
    expect(cssViolations('.oauth-card:hover { background: red; border-radius: 2px }', 'styles/ui-refinements.css')).toHaveLength(2);
    expect(cssViolations('.control-panel { border-radius: 20px }', 'pages/HomeDashboard.css')).toHaveLength(1);
    expect(cssViolations('.home-stat-grid { background: red }', 'pages/HomeDashboard.css')).toHaveLength(1);
    expect(cssViolations('.usage-trend-panel { border-radius: 18px }', 'styles/ui-refinements.css')).toHaveLength(1);
    expect(cssViolations('.usage-analysis-card { box-shadow: 0 2px 6px red }', 'pages/UsageAnalysisView.css')).toHaveLength(1);
    expect(cssViolations('.home-dashboard .home-top-grid > :is(.control-panel, .home-access-panel) { border-radius: 20px; box-shadow: var(--home-shadow) }', 'pages/HomeDashboard.css')).toHaveLength(2);
    expect(cssViolations('.usage-data-management-result-item { border-radius: 10px; box-shadow: 0 1px 3px red }', 'styles.css')).toHaveLength(2);
    expect(cssViolations('.usage-records-page .usage-stat-grid { background: var(--border-color) }', 'styles/ui-refinements.css')).toHaveLength(1);
    expect(cssViolations('.usage-stat-card { outline: 1px solid var(--border-color) }', 'styles/ui-refinements.css')).toEqual([]);
    expect(cssViolations('.usage-stat-card { outline: 1px solid red }', 'styles.css')).toHaveLength(1);
    expect(cssViolations('.usage-stat-card:hover { outline: none }', 'styles/ui-refinements.css')).toHaveLength(1);
    expect(cssViolations('.usage-stat-card { outline-offset: 2px }', 'styles/ui-refinements.css')).toHaveLength(1);
    expect(cssViolations('.usage-stat-grid { outline: 0 }', 'styles/ui-refinements.css')).toHaveLength(1);
    expect(cssViolations('.config-settings-cards > section:focus-visible, .config-settings-content .template-config-card:focus-visible { outline: 2px solid red; outline-offset: 2px }', 'styles/config-settings.css')).toEqual([]);
    expect(cssViolations('.config-settings-cards > section:focus-visible { outline: 0 }', 'styles/config-settings.css')).toHaveLength(1);
    expect(cssViolations('.config-settings-cards > section:focus-visible, .config-settings-content .template-config-card:focus-visible { outline-color: red }', 'styles/config-settings.css')).toHaveLength(1);
    expect(cssViolations('.usage-records-page .usage-stat-grid { background: red }', 'styles.css')).toHaveLength(1);
    expect(cssViolations('.usage-records-page .usage-stat-grid:hover { background: red }', 'styles/ui-refinements.css')).toHaveLength(1);
    expect(cssViolations('.usage-records-page .usage-stat-grid { border: 0; background-image: none }', 'styles/ui-refinements.css')).toHaveLength(2);
    expect(cssViolations('.usage-price-editor { background: red }', 'styles.css')).toHaveLength(1);
  });
  it('detects missing surface classes in literals, arrays, conditional and template classes', () => {
    for (const jsx of ['<article className="plugin-card" />', '<div className={["structured-map-item"].join(" ")} />', '<section className={`plugin-card ${dirty ? "selected" : ""}`} />', '<div id="config-native-aliases" />']) expect(jsxViolations(jsx, 'Example.tsx')).toHaveLength(1);
    expect(jsxViolations('<article className="surface-card plugin-card" />', 'Example.tsx')).toEqual([]);
    expect(jsxViolations('<div className={["surface-card", "structured-map-item"].join(" ")} />', 'Example.tsx')).toEqual([]);
    expect(jsxViolations('<section className="oauth-card" />', 'Example.tsx')).toHaveLength(1);
    expect(jsxViolations('<div className="model-discovery-content" />', 'Example.tsx')).toHaveLength(1);
    expect(jsxViolations('<article className="context-message-card user" />', 'Example.tsx')).toHaveLength(1);
    expect(jsxViolations('<section className="panel auth-files-panel" />', 'Example.tsx')).toHaveLength(1);
    expect(jsxViolations('<section className="panel surface-panel oauth-card" />', 'Example.tsx')).toEqual([]);
    expect(jsxViolations('<section className="surface-section surface-muted model-config-card" />', 'tests/fixtures/Example.tsx')).toEqual([]);
    expect(jsxViolations('<div className="usage-data-management-result-item" />', 'UsageRecordsPage.tsx')).toHaveLength(1);
    expect(jsxViolations('<div className="control-panel" />', 'Kernel.tsx')).toHaveLength(1);
    expect(jsxViolations('<div className="home-stat-grid" />', 'HomeOverviewCards.tsx')).toHaveLength(1);
    expect(jsxViolations('<section className="usage-trend-panel" />', 'UsageRecordsPage.tsx')).toHaveLength(1);
    expect(jsxViolations('<div className="surface-card home-stat-grid" />', 'HomeOverviewCards.tsx')).toEqual([]);
    expect(jsxViolations('<section className="panel surface-card usage-trend-panel" />', 'UsageRecordsPage.tsx')).toEqual([]);
  });
});
