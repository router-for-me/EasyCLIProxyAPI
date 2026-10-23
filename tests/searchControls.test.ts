import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const owners: Record<string, readonly string[]> = {
  'pages/ApiAccessPage.tsx': ['api-access-search', 'model-discovery-search'],
  'pages/AuthFileManagementPage.tsx': ['auth-files-search', 'model-discovery-search'],
  'components/AuthFileModelsDialog.tsx': ['model-discovery-search'],
  'components/ModelSelectionPanel.tsx': ['model-transfer-search'],
  'pages/ConfigPanel.tsx': ['config-settings-search'],
  'pages/PluginsPage.tsx': ['plugin-search'],
  'pages/AgentClientList.tsx': ['agent-client-search'],
  'pages/CoreHealthPanel.tsx': ['core-health-search'],
  'pages/ThinkingAliasesPage.tsx': ['thinking-model-search'],
  'components/AgentModelPicker.tsx': ['agent-model-search'],
  'pages/CodexModelCatalogDialog.tsx': ['codex-catalog-search'],
  'pages/DeepSeekHarnessCatalogDialog.tsx': ['codex-catalog-search'],
  'pages/CodexSessionContextEditor.tsx': ['context-search-box'],
  'components/ThemeSelector.tsx': ['theme-selector-search'],
  'pages/UsageRecordsPage.tsx': ['usage-pricing-search'],
};

it('keeps every inventoried search frame on the shared focus and sizing contract', () => {
  for (const [file, hooks] of Object.entries(owners)) {
    const source = ts.createSourceFile(file, readFileSync(`${import.meta.dir}/../src/${file}`, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const matches = new Map<string, ts.JsxAttributes[]>();
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const attribute = node.attributes.properties.find(property => ts.isJsxAttribute(property) && property.name.getText(source) === 'className');
        if (attribute && ts.isJsxAttribute(attribute) && attribute.initializer && ts.isStringLiteral(attribute.initializer)) {
          const classes = attribute.initializer.text.split(/\s+/);
          for (const hook of hooks.filter(hook => classes.includes(hook))) {
            expect(classes).toContain('search-control');
            const size = node.attributes.properties.find(property => ts.isJsxAttribute(property) && property.name.getText(source) === 'data-size');
            expect(size && ts.isJsxAttribute(size) && size.initializer && ts.isStringLiteral(size.initializer) && ['default', 'compact'].includes(size.initializer.text)).toBe(true);
            matches.set(hook, [...matches.get(hook) ?? [], node.attributes]);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const hook of hooks) expect(matches.get(hook)?.length).toBeGreaterThan(0);
  }
});
