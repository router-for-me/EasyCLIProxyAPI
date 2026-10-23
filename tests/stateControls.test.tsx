import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import postcss from 'postcss';
import ts from 'typescript';
import { I18nProvider } from '../src/i18n';
import { EmptyState } from '../src/components/EmptyState';
import { Notice } from '../src/components/Notice';

const root = join(import.meta.dir, '..', 'src');
const emptyHooks = [
  'management-empty', 'config-empty-list', 'config-unavailable', 'plugin-empty', 'usage-empty', 'usage-initial-loading', 'usage-analysis-empty',
  'core-health-empty', 'codex-session-empty', 'config-search-empty', 'model-transfer-empty', 'thinking-model-empty', 'agent-model-empty',
];
const emptyExceptions: Record<string, string> = {
  'app-release-notes-empty': 'Left-aligned status paragraph inside the release notes dialog flow.',
  'credential-quota-empty': 'One-line status inside the dense credential quota cell with its own font scale.',
  'config-sensitive-words-empty': 'One-line muted text under a form list.',
  'home-field-empty': 'Field placeholder inside the access panel.',
  'thinking-level-empty': 'Inline muted text inside a field.',
  'usage-analysis-muted': 'Inline muted text inside an analysis card.',
  'usage-activity-empty': 'Overlay positioned on the chart plot area.',
  'usage-trend-tooltip-empty': 'Chart tooltip content.',
};
const noticeHooks = [
  'plugin-banner', 'plugin-oauth-provider-status', 'template-config-notice', 'codex-session-notice', 'codex-session-notice-message', 'claude-code-model-error',
  'quota-card-error', 'agent-detection-help', 'credential-settings-error', 'plugin-warning',
];
const removed = [
  'oauth-flow-status', 'plugin-oauth-error', 'plugin-oauth-notice', 'home-runtime-error', 'vertex-login-error', 'usage-price-sync-error',
  'config-delete-warning', 'config-diagnostics-commercial-note', 'reasoning-edit-warning', 'agent-inline-message', 'agent-desktop-model-notice',
  'credential-settings-warning', 'management-alert', 'close-dialog-error', 'model-discovery-inline-error', 'quota-action-feedback', 'simple-mode-core-alert',
  'easy-mode-hint', 'easy-mode-alert-icon', 'core-locked-panel', 'thinking-alias-feedback',
];
const roleExceptions: Record<string, [number, number, string]> = {
  'components/AppReleaseNotes.tsx': [0, 1, 'Release notes empty message.'],
  'components/AuthFileQuotaPanel.tsx': [0, 2, 'Dense credential quota cell loading and error lines.'],
  'components/AuthFileSettingsDialog.tsx': [0, 1, 'Catalog loading text.'],
  'components/StructuredConfigEditor.tsx': [1, 0, 'Field-level key error.'],
  'components/TemplateConfigSection.tsx': [1, 2, 'Field-level validation error, loading text and save status.'],
  'components/claude-code/ClaudeCodeModelInputs.tsx': [0, 1, 'Field hint.'],
  'pages/AgentClientList.tsx': [0, 2, 'Result count and selection summary.'],
  'pages/AgentConfigBackupDialog.tsx': [0, 1, 'Loading text.'],
  'pages/AgentsPage.tsx': [0, 4, 'Model hints.'],
  'pages/ApiAccessPage.tsx': [0, 1, 'Model summary count.'],
  'pages/ConfigPanel.tsx': [2, 6, 'Reserved status slots, dirty badges, search count and disabled text.'],
  'pages/CoreHealthPanel.tsx': [1, 1, 'Role passed to EmptyState for the load error and loading placeholder.'],
  'pages/Kernel.tsx': [0, 1, 'Runtime state badge.'],
  'pages/PluginInstallDialog.tsx': [1, 0, 'Field-level version error.'],
  'pages/PluginResourcePage.tsx': [0, 1, 'Loading text.'],
  'pages/PluginSettingsPanel.tsx': [0, 1, 'Loading text.'],
  'pages/PluginsPage.tsx': [0, 2, 'Loading text.'],
  'pages/UsageEventsView.tsx': [0, 1, 'Role passed to EmptyState for the loading placeholder.'],
  'pages/VertexLoginCard.tsx': [0, 1, 'Login result summary.'],
};
const appearance = /^(background(-color|-image)?|border(-(top|right|bottom|left|color|style|width|radius|inline|block)[a-z-]*)?|border-radius|color|font-size|font-weight|box-shadow|opacity)$/;

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
const literals = (node: ts.Node) => {
  const found: string[] = [];
  const visit = (child: ts.Node) => {
    if (ts.isStringLiteralLike(child)) found.push(child.text);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
};
const scan = (text: string, file: string) => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const elements: { tag: string; classes: string[]; line: number }[] = [];
  const roles = { alert: 0, status: 0 };
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attributes = node.attributes.properties.filter((item): item is ts.JsxAttribute => ts.isJsxAttribute(item));
      const className = attributes.find(item => item.name.getText(source) === 'className');
      elements.push({ tag: node.tagName.getText(source), classes: classTokens(className?.initializer), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
      const role = attributes.find(item => item.name.getText(source) === 'role');
      if (role?.initializer) for (const value of literals(role.initializer)) if (value === 'alert' || value === 'status') roles[value]++;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { elements, roles };
};

const sources = walk(root, /\.tsx$/).map(path => ({ file: name(path), ...scan(readFileSync(path, 'utf8'), name(path)) }));

describe('shared empty states and notices', () => {
  it('renders EmptyState variants with the optional parts only when given', () => {
    const html = renderToStaticMarkup(<EmptyState variant="box" tone="error" icon={<svg />} title="Title" action={<button type="button">Retry</button>} role="alert" className="layout">Body</EmptyState>);
    for (const fragment of ['class="empty-state empty-state-box empty-state-error layout"', 'role="alert"', 'class="empty-state-icon" aria-hidden="true"', '<strong class="empty-state-title">Title</strong>', 'class="empty-state-description">Body', '<button type="button">Retry</button>']) expect(html).toContain(fragment);
    const bare = renderToStaticMarkup(<EmptyState>Only text</EmptyState>);
    expect(bare).toContain('empty-state empty-state-page');
    for (const fragment of ['empty-state-icon', 'empty-state-title', 'role=']) expect(bare).not.toContain(fragment);
  });
  it('gives error notices an assertive alert and every other tone a polite status', () => {
    const render = (props: Partial<Parameters<typeof Notice>[0]>) => renderToStaticMarkup(<I18nProvider><Notice tone="info" {...props}>Text</Notice></I18nProvider>);
    const error = render({ tone: 'error' });
    for (const fragment of ['role="alert"', 'aria-live="assertive"', 'aria-atomic="true"', 'notice notice-box notice-error']) expect(error).toContain(fragment);
    for (const tone of ['info', 'success', 'warn'] as const) {
      const html = render({ tone });
      for (const fragment of ['role="status"', 'aria-live="polite"', 'aria-atomic="true"', `notice-${tone}`]) expect(html).toContain(fragment);
    }
    const quiet = render({ tone: 'warn', live: false, id: 'x' });
    for (const fragment of ['role=', 'aria-live']) expect(quiet).not.toContain(fragment);
    expect(quiet).toContain('id="x"');
  });
  it('draws a tone icon on boxes only and a labelled dismiss button on request', () => {
    const render = (props: Partial<Parameters<typeof Notice>[0]>) => renderToStaticMarkup(<I18nProvider><Notice tone="success" {...props}>Text</Notice></I18nProvider>);
    expect(render({})).toContain('class="notice-icon"');
    expect(render({ variant: 'text' })).not.toContain('notice-icon');
    expect(render({ icon: false })).not.toContain('notice-icon');
    expect(render({})).not.toContain('notice-dismiss');
    const dismissible = render({ onDismiss: () => {}, dismissLabel: 'Close' });
    expect(dismissible).toContain('aria-label="Close"');
    expect(dismissible).toContain('notice-dismiss');
  });

  it('keeps private empty-state classes on EmptyState only and rejects new ones', () => {
    const violations: string[] = [];
    for (const { file, elements } of sources) for (const item of elements) for (const token of item.classes) {
      if (file === 'components/EmptyState.tsx') continue;
      if (token.startsWith('empty-state')) violations.push(`${file}:${item.line} uses ${token}`);
      if (emptyHooks.includes(token) && item.tag !== 'EmptyState') violations.push(`${file}:${item.line} <${item.tag} className="${token}"> must be an EmptyState`);
      if (/(^|-)empty(-list)?$/.test(token) && !emptyHooks.includes(token) && !(token in emptyExceptions)) violations.push(`${file}:${item.line} unknown empty class ${token}`);
    }
    expect(violations).toEqual([]);
  });
  it('rejects removed notice classes in markup and stylesheets', () => {
    const violations: string[] = [];
    for (const { file, elements } of sources) for (const item of elements) for (const token of item.classes) if (removed.includes(token)) violations.push(`${file}:${item.line} uses removed class ${token}`);
    for (const path of walk(root, /\.css$/)) {
      const text = readFileSync(path, 'utf8');
      postcss.parse(text, { from: path }).walkRules(rule => {
        for (const token of removed) if (new RegExp(`\\.${token}(?![\\w-])`).test(rule.selector)) violations.push(`${name(path)}:${rule.source?.start?.line} styles removed class ${token}`);
      });
    }
    expect(violations).toEqual([]);
  });
  it('keeps role alert and status in Notice and an explicit exception list', () => {
    const violations: string[] = [];
    for (const { file, roles } of sources) {
      if (file === 'components/Notice.tsx') continue;
      const [alert, status] = roleExceptions[file] ?? [0, 0];
      if (roles.alert !== alert) violations.push(`${file}: ${roles.alert} role="alert", expected ${alert}`);
      if (roles.status !== status) violations.push(`${file}: ${roles.status} role="status", expected ${status}`);
    }
    for (const file of Object.keys(roleExceptions)) if (!sources.some(item => item.file === file)) violations.push(`${file}: listed but missing`);
    expect(violations).toEqual([]);
  });
  it('limits stylesheets to layout on empty-state and notice hook classes', () => {
    const hooks = new Set([...emptyHooks, ...noticeHooks]);
    const violations: string[] = [];
    for (const path of walk(root, /\.css$/)) {
      postcss.parse(readFileSync(path, 'utf8'), { from: path }).walkRules(rule => {
        for (const selector of rule.selectors) {
          const subject = selector.trim().split(/\s*[>+~]\s*|\s+/).pop() ?? '';
          const classes = [...subject.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map(match => match[1]);
          if (!classes.some(item => hooks.has(item)) || classes.some(item => item.startsWith('empty-state') || item.startsWith('notice'))) continue;
          rule.walkDecls(declaration => {
            if (appearance.test(declaration.prop)) violations.push(`${name(path)}:${rule.source?.start?.line} ${selector.replace(/\s+/g, ' ')} sets ${declaration.prop}`);
          });
        }
      });
    }
    expect(violations).toEqual([]);
  });
});
