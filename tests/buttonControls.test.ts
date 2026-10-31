import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import postcss from 'postcss';
import ts from 'typescript';

const root = join(import.meta.dir, '..', 'src');
const trunk = ['primary-button', 'secondary-button', 'danger-button', 'icon-button', 'compact-button', 'small-button', 'tiny-button', 'link-button'];
const modifiers = new Set(['ghost', 'quiet', 'danger', 'muted', 'copied', 'active', 'selected', 'locked', 'open', 'disabled', 'is-hidden', 'is-expanded', 'has-accounts', 'highlight-save', 'spin', 'oauth', 'api']);
const trunkFiles = ['styles.css', 'styles/ui-refinements.css', 'styles/workspace-white.css', 'styles/theme-surfaces.css'];
const trunkOverrides: Record<string, string> = {
  'styles/usage-subpages.css': 'Usage panels recolor secondary buttons with page tokens (usage-page-*); moves into semantic tokens in stage 2.',
};
const allowedSelectors: Record<string, string> = {
  '.usage-records-page .usage-tab-panel .usage-price-row-actions button:hover': 'Keeps the page-token hover on the price table actions that the usage panel recolors above.',
};
const rowButtons: Record<string, [number, string]> = {
  'components/WindowFrame.tsx': [2, 'Native window chrome uses caption button dimensions.'],
  'App.tsx': [2, 'Sidebar navigation items and language list rows (.nav-section, .sidebar-language-list).'],
  'pages/EasyModePage.tsx': [1, 'Language menu items (.simple-mode-lang-menu).'],
  'pages/ThinkingAliasesPage.tsx': [3, 'Model list rows and effort options (.thinking-model-list, .thinking-effort-options).'],
  'pages/AgentClientList.tsx': [1, 'Client list rows (.agent-list-items).'],
  'pages/AgentsPage.tsx': [1, 'Launch directory history rows (.agent-launch-directory-history-list).'],
  'pages/ApiAccessPage.tsx': [2, 'Provider category rows and the thinking level tag remove control (.provider-category-panel, .thinking-level-tags).'],
  'pages/CodexModelCatalogDialog.tsx': [1, 'Catalog model rows (.codex-catalog-models).'],
  'pages/ConfigPanel.tsx': [1, 'Settings search result rows (.config-search-result-list).'],
  'pages/AgentConfigBackupDialog.tsx': [1, 'Backup version rows (.agent-backup-columns nav).'],
  'pages/DeepSeekHarnessCatalogDialog.tsx': [1, 'Harness model rows.'],
};
const removed = [
  'auth-list-action', 'auth-toolbar-quiet', 'oauth-toolbar-quiet', 'usage-page-nav-btn', 'usage-events-export-btn', 'home-runtime-refresh', 'core-health-row-check',
  'quiet-button', 'text-button', 'simple-mode-highlight-button', 'codex-session-dialog-close', 'plugin-search-clear-button',
];
const exceptions: Record<string, string[]> = {
  'Native window caption controls use OS-sized chrome': ['window-controls', 'window-close'],
  'Tabs and SegmentedControl choices (1.3)': [
    'tabs-control', 'routing-segmented', 'agent-subpage-tabs', 'oauth-subpage-tabs', 'config-subpage-tabs', 'usage-tabs', 'plugin-tabs', 'home-protocol-tabs', 'usage-analysis-metric',
    'quota-category-filter', 'thinking-effort-options', 'agent-auth-segmented', 'agent-auth-segmented-button', 'simple-mode-api-platforms', 'simple-mode-api-platform',
    'theme-selector-modes',
  ],
  'Sidebar and theme/language menus: navigation chrome with its own sidebar tokens': [
    'nav-section', 'sidebar-link', 'sidebar-contact', 'sidebar-easy-entry', 'sidebar-language-trigger', 'sidebar-language-list', 'sidebar-privacy-toggle', 'nav-plugin-toggle',
    'nav-plugin-drag', 'nav-plugin-entry', 'nav-plugin-parent', 'nav-plugin-children', 'nav-plugin-row', 'theme-selector-trigger', 'theme-selector-card', 'theme-selector-actions',
    'theme-selector-notice', 'simple-mode-lang-btn', 'simple-mode-lang-menu',
  ],
  'Dropdown triggers and options (1.4)': [
    'select-menu-trigger', 'select-menu-option', 'agent-model-trigger', 'agent-model-option', 'agent-model-editable-trigger',
  ],
  'Clickable cards and list rows: the row itself is the control': [
    'simple-mode-choice', 'simple-mode-step-status-item', 'provider-category-panel', 'agent-list-items', 'agent-backup-columns', 'codex-catalog-models',
    'model-discovery-row', 'model-transfer-row', 'auth-model-view-row', 'thinking-model-list', 'agent-launch-directory-picker', 'agent-launch-directory-history-list',
    'config-search-result-list', 'auth-health-summary', 'agent-client-list', 'harness-provider-button', 'harness-catalog-dialog', 'codex-model-catalog',
  ],
  'Chips, badges and legend toggles': [
    'usage-trend-legend-item', 'filter-chip', 'role-select-chip', 'oauth-account-count', 'context-badge', 'context-id-badge', 'context-meta-head', 'context-add-button',
    'thinking-level-tags', 'auth-file-request-block',
  ],
  'Multi-line content buttons whose height follows the content': ['agent-codex-catalog-button', 'close-choice-button'],
};
const exceptionNames = new Set(Object.values(exceptions).flat());
const banned = /^(background(-color|-image)?|border(-(top|right|bottom|left|color|style|width|radius|inline|block)[a-z-]*)?|border-radius|color|height|min-height|max-height|font-size|font-weight|box-shadow)$/;
const neutral = (property: string, value: string) => /^(min-)?height$/.test(property) && /^(auto|0|0px|100%|fit-content|max-content|inherit)$/.test(value.trim());

const walk = (dir: string, extension: RegExp): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? (entry.name === 'mocks' ? [] : walk(path, extension)) : extension.test(entry.name) ? [path] : [];
});
const name = (path: string) => relative(root, path).split(sep).join('/');
const tokens = (text: string) => text.split(/\s+/).filter(Boolean);
const classTokens = (node: ts.Node | undefined) => {
  const found: string[] = [];
  const visit = (child: ts.Node) => {
    if (ts.isStringLiteralLike(child) || ts.isTemplateHead(child) || ts.isTemplateMiddle(child) || ts.isTemplateTail(child)) found.push(...tokens(child.text));
    ts.forEachChild(child, visit);
  };
  if (node) visit(node);
  return found;
};
const elements = (text: string, file: string) => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: { tag: string; classes: string[]; hasClass: boolean; spread: boolean; line: number }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attributes = node.attributes.properties;
      const className = attributes.find((item): item is ts.JsxAttribute => ts.isJsxAttribute(item) && item.name.getText(source) === 'className');
      found.push({ tag: node.tagName.getText(source), classes: classTokens(className?.initializer), hasClass: Boolean(className), spread: attributes.some(ts.isJsxSpreadAttribute), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

const sources = walk(root, /\.tsx$/).map(path => ({ file: name(path), elements: elements(readFileSync(path, 'utf8'), name(path)) }));
const onButtons = new Set<string>();
const elsewhere = new Set<string>();
for (const { elements: list } of sources) for (const item of list) {
  for (const token of item.classes) (item.tag === 'button' ? onButtons : elsewhere).add(token);
}
const privateButtonClasses = new Set([...onButtons].filter(token => !elsewhere.has(token) && !modifiers.has(token) && !trunk.includes(token)));

const subjectOf = (selector: string) => {
  let depth = 0;
  const flat = [...selector].map(char => {
    if (char === '(' || char === '[') depth++;
    if (char === ')' || char === ']') depth--;
    return depth > 0 && /\s/.test(char) ? '\u0000' : char;
  }).join('');
  const compounds = flat.replace(/\s*([>+~])\s*/g, ' $1 ').trim().split(/\s+/);
  return compounds[compounds.length - 1].replaceAll('\u0000', ' ');
};
const classesOf = (text: string) => [...text.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map(match => match[1]);
const cssViolations = (text: string, file: string) => {
  const found: string[] = [];
  postcss.parse(text, { from: file }).walkRules(rule => {
    const declarations: string[] = [];
    rule.walkDecls(declaration => { if (banned.test(declaration.prop) && !neutral(declaration.prop, declaration.value)) declarations.push(declaration.prop); });
    if (!declarations.length) return;
    for (const selector of rule.selectors) {
      if (/::?(before|after|placeholder|-webkit)/.test(subjectOf(selector))) continue;
      const subject = subjectOf(selector).replace(/:(is|not|where|has)\([^)]*\)/g, match => (match.startsWith(':is') || match.startsWith(':where') ? match : ''));
      const subjectClasses = classesOf(subject);
      const buttonLike = /(^|[^\w-])button([.:#[\s>+~]|$)/.test(` ${subject} `) || subjectClasses.some(item => trunk.includes(item) || privateButtonClasses.has(item));
      if (!buttonLike) continue;
      if (classesOf(selector).some(item => exceptionNames.has(item))) continue;
      if (subjectClasses.some(item => trunk.includes(item)) && (trunkFiles.includes(file) || file in trunkOverrides)) continue;
      if (selector === 'button' && trunkFiles.includes(file)) continue;
      if (selector.replace(/\s+/g, ' ') in allowedSelectors) continue;
      found.push(`${file}:${rule.source?.start?.line} ${selector.replace(/\s+/g, ' ')} {${[...new Set(declarations)].join(', ')}}`);
    }
  });
  return found;
};
const jsxViolations = (file: string, list: ReturnType<typeof elements>) => list.flatMap(item => {
  if (item.tag !== 'button') return [];
  const issues: string[] = [];
  for (const token of item.classes) if (removed.includes(token)) issues.push(`${file}: removed class ${token}`);
  const styled = item.classes.some(token => trunk.includes(token) || exceptionNames.has(token));
  if (!styled && !(item.spread && !item.hasClass)) issues.push(`${file}:${item.line} <button className="${item.classes.join(' ')}"> has no shared button class`);
  return issues;
});
const unstyled = (issues: string[]) => issues.filter(issue => issue.includes('has no shared button class'));

describe('shared button controls', () => {
  it('keeps page stylesheets from restyling buttons', () => {
    const found = walk(root, /\.css$/).flatMap(path => cssViolations(readFileSync(path, 'utf8'), name(path)));
    expect(found).toEqual([]);
  });
  it('requires a shared button class on every <button> and rejects retired private classes', () => {
    const checked = sources.filter(item => !['components/SegmentedControl.tsx', 'components/Tabs.tsx'].includes(item.file));
    expect(checked.flatMap(item => jsxViolations(item.file, item.elements).filter(issue => !issue.includes('has no shared button class')))).toEqual([]);
    const counts = Object.fromEntries(checked.map(item => [item.file, unstyled(jsxViolations(item.file, item.elements)).length]).filter(([, count]) => count));
    expect(counts).toEqual(Object.fromEntries(Object.entries(rowButtons).map(([file, [count]]) => [file, count])));
  });
  it('detects page rules that restyle buttons', () => {
    const sample = (selector: string, declaration: string) => cssViolations(`${selector} { ${declaration} }`, 'pages/Example.css');
    expect(sample('.page .primary-button', 'background: red')).toHaveLength(1);
    expect(sample('.page > button', 'border-radius: 4px')).toHaveLength(1);
    expect(sample('.page button:hover:not(:disabled)', 'color: red')).toHaveLength(1);
    expect(sample('.page button', 'margin: 0; width: 100%; min-height: 0; height: auto; white-space: nowrap')).toEqual([]);
    expect(sample('.page .compact-button', 'min-height: 30px')).toHaveLength(1);
    expect(sample('.page-tabs button', 'color: red')).toHaveLength(1);
    expect(sample('.routing-segmented button', 'color: red')).toEqual([]);
    expect(sample('.page button > svg', 'color: red')).toEqual([]);
  });
  it('detects buttons without a shared class and retired classes', () => {
    const list = (text: string) => jsxViolations('Example.tsx', elements(text, 'Example.tsx'));
    expect(list('<button type="button" className="page-action" />')).toHaveLength(1);
    expect(list('<button type="button" />')).toHaveLength(1);
    expect(list('<button className={`${a ? "secondary-button" : "primary-button"} compact-button`} />')).toEqual([]);
    expect(list('<button className="secondary-button auth-list-action" />')).toHaveLength(1);
    expect(list('<div className="page-action" />')).toEqual([]);
  });
});
