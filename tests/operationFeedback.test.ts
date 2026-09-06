import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function actionCalls(file: string, action: string, callback: string) {
  const source = ts.createSourceFile(
    file,
    readFileSync(new URL(`../src/pages/${file}`, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const calls: ts.CallExpression[] = [];
  let found = false;
  const visitAction = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === callback) calls.push(node);
    ts.forEachChild(node, visitAction);
  };
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === action && node.initializer) {
      found = true;
      visitAction(node.initializer);
    } else {
      ts.forEachChild(node, visit);
    }
  };
  visit(source);
  expect(found).toBe(true);
  return { source, calls };
}

describe('控件自身反馈', () => {
  it('API 开关只报告失败，不再为成功切换插入额外消息', () => {
    const { calls } = actionCalls('ApiAccessPage.tsx', 'toggleProvider', 'setNotice');
    const nonEmptyCalls = calls.filter((call) => !ts.isStringLiteral(call.arguments[0]) || call.arguments[0].text !== '');
    expect(nonEmptyCalls).toHaveLength(1);
    expect(nonEmptyCalls[0].arguments[1].getText()).toBe("'error'");
  });

  it('凭证文件的启用停用由按钮与状态标签反馈', () => {
    expect(actionCalls('AuthFileManagementPage.tsx', 'toggleStatus', 'showNotice').calls).toHaveLength(0);
  });

  it('停用凭证的启用按钮使用主题高亮，停用操作仍使用次要样式', () => {
    const file = 'AuthFileManagementPage.tsx';
    const source = ts.createSourceFile(file, readFileSync(new URL(`../src/pages/${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let button: ts.JsxOpeningElement | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) && node.tagName.getText(source) === 'button'
        && node.attributes.properties.some((attribute) => ts.isJsxAttribute(attribute)
          && attribute.name.getText(source) === 'onClick'
          && attribute.initializer?.getText(source).includes('toggleStatus(file)'))) button = node;
      ts.forEachChild(node, visit);
    };
    visit(source);
    const attributes = button?.attributes.properties.filter(ts.isJsxAttribute);
    expect(attributes?.find((attribute) => attribute.name.getText(source) === 'className')?.initializer?.getText(source))
      .toBe("{`${disabled ? 'primary-button' : 'secondary-button'} compact-button`}");
    expect(attributes?.find((attribute) => attribute.name.getText(source) === 'disabled')?.initializer?.getText(source))
      .toBe('{busy}');
    const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    expect(styles).toMatch(/\.real-auth-file-row\.disabled\s*>\s*:not\(\.auth-file-actions\)\s*\{\s*opacity:\s*0\.68;/);
    expect(styles).not.toMatch(/\.real-auth-file-row\.disabled\s*\{[^}]*opacity:/);
  });

  it('开关切换只后台刷新数据，不卸载整张列表和焦点控件', () => {
    for (const [file, action, callback] of [
      ['ApiAccessPage.tsx', 'toggleProvider', 'loadProviders'],
      ['AuthFileManagementPage.tsx', 'toggleStatus', 'loadFiles'],
    ]) {
      const { calls } = actionCalls(file, action, callback);
      expect(calls).toHaveLength(1);
      expect(calls[0].arguments[0]?.getText()).toBe('false');
    }
  });

  it('复制密钥仅保留原按钮勾选和失败提示', () => {
    const { calls } = actionCalls('ConfigPanel.tsx', 'copyApiKey', 'keyFeedback.showNotice');
    expect(calls).toHaveLength(1);
    expect(calls[0].arguments[1].getText()).toBe("'error'");
  });

  it('首页启动和停止不重复报成功，只有重启需要额外结果', () => {
    const { source, calls } = actionCalls('Kernel.tsx', 'runCoreProcessCommand', 'showProcessNotice');
    const successCalls = calls.filter((call) => call.arguments[1]?.getText(source) === "'success'");
    expect(successCalls).toHaveLength(1);
    let ancestor: ts.Node | undefined = successCalls[0].parent;
    while (ancestor && !ts.isIfStatement(ancestor)) ancestor = ancestor.parent;
    expect(ancestor && ts.isIfStatement(ancestor) ? ancestor.expression.getText(source) : '')
      .toBe("command === 'restart_core_process'");
  });
});
