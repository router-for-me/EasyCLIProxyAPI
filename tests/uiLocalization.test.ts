import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const technicalText = new Set(['EasyCLIProxyAPI', 'WebSocket', 'Fast', 'ms', 'auto']);
const technicalPlaceholders = new Set(['1h', 'sk-...', 'gpt-5.6-terra', 'https://...']);

function componentFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'i18n' ? [] : componentFiles(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

describe('UI localization boundaries', () => {
  it('preserves the raw reasoning effort in usage text and tooltips', () => {
    const file = join(sourceRoot, 'pages', 'UsageRecordsPage.tsx');
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let effortCell: ts.JsxElement | undefined;
    const findEffortCell = (node: ts.Node) => {
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'small') effortCell = node;
      ts.forEachChild(node, findEffortCell);
    };
    const visit = (node: ts.Node) => {
      if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && node.expression.text === 'model') {
        findEffortCell(node);
      } else {
        ts.forEachChild(node, visit);
      }
    };
    const component = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'UsageEventCell');
    expect(component).toBeDefined();
    if (component) visit(component);
    const text = effortCell?.children.find(ts.isJsxExpression);
    const title = effortCell?.openingElement.attributes.properties.find((attribute) =>
      ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'title',
    );
    expect(text?.expression?.getText(source)).toBe("record.reasoning_effort || 'auto'");
    expect(title && ts.isJsxAttribute(title) && title.initializer?.getText(source))
      .toBe("{record.reasoning_effort || 'auto'}");
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
