import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const technicalText = new Set([
  'EasyCLIProxyAPI',
  'WebSocket',
  'Fast',
  'HTTP',
  'auto',
  'excluded_models',
  'headers',
  'ms',
  'note',
  'Models.dev',
  'LiteLLM',
]);
const technicalPlaceholders = new Set([
  '1h',
  'sk-...',
  'gpt-5.6-terra',
  'https://...',
  'socks5://127.0.0.1:1080',
]);

function componentFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'i18n' ? [] : componentFiles(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

describe('UI localization boundaries', () => {
  it('preserves the raw reasoning effort under the usage model name', () => {
    const file = join(sourceRoot, 'pages', 'UsageEventsView.tsx');
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let modelCase: ts.CaseClause | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && node.expression.text === 'model') {
        modelCase = node;
      } else {
        ts.forEachChild(node, visit);
      }
    };
    const component = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'UsageEventCell');
    expect(component).toBeDefined();
    if (component) visit(component);
    const displayedExpressions: string[] = [];
    const titleExpressions: string[] = [];
    const inspectEffort = (node: ts.Node) => {
      if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent) && node.expression) {
        displayedExpressions.push(node.expression.getText(source));
      }
      if (ts.isJsxAttribute(node) && node.name.getText(source) === 'title' && node.initializer) {
        titleExpressions.push(node.initializer.getText(source));
      }
      ts.forEachChild(node, inspectEffort);
    };
    expect(modelCase).toBeDefined();
    if (modelCase) inspectEffort(modelCase);
    expect(displayedExpressions).toContain('effort');
    expect(titleExpressions).toContain('{effort}');
    expect(source.getText()).toContain("const effort = record.reasoning_effort || 'auto'");
    expect(source.getText()).not.toContain("case 'effort'");
  });

  it('routes visible prose and accessibility labels through translations', () => {
    const hardcoded: string[] = [];
    for (const file of componentFiles(sourceRoot)) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const report = (node: ts.Node, text: string, allowed = technicalText) => {
        const normalized = text.trim();
        if (/\p{L}/u.test(normalized) && !allowed.has(normalized)) {
          const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          hardcoded.push(`${file}:${line}: ${normalized}`);
        }
      };
      const inspectExpression = (expression?: ts.Expression) => {
        if (!expression) return;
        if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
          report(expression, expression.text);
        } else if (ts.isConditionalExpression(expression)) {
          inspectExpression(expression.whenTrue);
          inspectExpression(expression.whenFalse);
        } else if (ts.isBinaryExpression(expression)) {
          inspectExpression(expression.right);
        }
      };
      const visit = (node: ts.Node) => {
        if (ts.isJsxText(node)) report(node, node.text);
        if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent)) inspectExpression(node.expression);
        if (ts.isJsxAttribute(node) && node.initializer) {
          const name = node.name.getText(source);
          if (['title', 'aria-label', 'alt', 'placeholder'].includes(name) && ts.isStringLiteral(node.initializer)) {
            report(node, node.initializer.text, name === 'placeholder' ? technicalPlaceholders : technicalText);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(hardcoded).toEqual([]);
  });

  it('does not add a redundant hardcoded caption above localized page titles', () => {
    for (const file of ['ApiAccessPage', 'ManagementPages', 'AuthFileManagementPage', 'AgentsPage', 'QuotaPage']) {
      const source = readFileSync(join(sourceRoot, 'pages', `${file}.tsx`), 'utf8');
      expect(source).not.toMatch(/<span>(?:Providers|OAuth|Auth Files|Agent Clients|Quota)<\/span>/);
    }
  });
});
