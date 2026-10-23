import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import postcss from 'postcss';
import ts from 'typescript';
import { createThemeApplicator } from '../src/themes/applyTheme';
import { builtinThemes } from '../src/themes/registry';

const srcRoot = join(import.meta.dir, '..', 'src');
const projectRoot = join(import.meta.dir, '..');

const DECLARED_LAYERS: Record<string, true> = {
  reset: true,
  tokens: true,
  primitives: true,
  components: true,
  pages: true,
  theme: true,
};

function walkCss(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') return [];
      return walkCss(full);
    }
    return entry.name.endsWith('.css') ? [full] : [];
  });
}

describe('CSS layer architecture and specificity regression', () => {
  it('declares consistent layer order before component styles and imports global styles last', () => {
    const indexCss = readFileSync(join(srcRoot, 'styles/index.css'), 'utf8');
    const firstNonEmptyLine = indexCss
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith('/*'));

    const layersCss = readFileSync(join(srcRoot, 'styles/layers.css'), 'utf8').trim();
    expect(layersCss).toBe('@layer reset, tokens, primitives, components, pages, theme;');
    expect(firstNonEmptyLine).toBe(layersCss);

    const mainTsx = readFileSync(join(srcRoot, 'main.tsx'), 'utf8');
    const imports = ts.createSourceFile('main.tsx', mainTsx, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      .statements.filter(ts.isImportDeclaration)
      .map((statement) => (statement.moduleSpecifier as ts.StringLiteral).text);

    const stylesheets = imports.filter((specifier) => specifier.endsWith('.css'));
    expect(imports[0]).toBe('./styles/layers.css');
    expect(stylesheets.at(-1)).toBe('./styles/index.css');
    expect(imports.indexOf('./App')).toBeGreaterThan(0);
    expect(imports.indexOf('./App')).toBeLessThan(imports.indexOf('./styles/index.css'));

    const indexHtml = readFileSync(join(projectRoot, 'index.html'), 'utf8');
    expect(indexHtml).not.toMatch(/@layer\b/);
  });

  it('prohibits !important across all src CSS stylesheets', () => {
    const files = walkCss(srcRoot);
    const violations: string[] = [];

    for (const filePath of files) {
      const relPath = relative(srcRoot, filePath).replaceAll('\\', '/');
      const content = readFileSync(filePath, 'utf8');
      const ast = postcss.parse(content, { from: filePath });

      ast.walkDecls((decl) => {
        if (decl.important) {
          violations.push(`${relPath}:${decl.source?.start?.line ?? 0} ${decl.prop}: ${decl.value} !important`);
        }
      });
    }

    expect(violations).toEqual([]);
  });

  it('ensures window material styles are driven by tokens and data-window-material', () => {
    const materialCss = readFileSync(join(srcRoot, 'styles/theme-window-material.css'), 'utf8');
    const ast = postcss.parse(materialCss, { from: 'theme-window-material.css' });

    let tokenRuleFound = false;
    let hasWorkspaceToken = false;
    let hasSidebarToken = false;
    let workspaceUsesToken = false;
    let sidebarUsesToken = false;

    ast.walkRules((rule) => {
      for (const selector of rule.selectors) {
        expect(selector.startsWith(':root[data-window-material]')).toBe(true);
      }
      if (rule.selector.trim() === ':root[data-window-material]') {
        tokenRuleFound = true;
        rule.walkDecls((decl) => {
          if (decl.prop === '--workspace-surface') hasWorkspaceToken = true;
          if (decl.prop === '--sidebar-surface') hasSidebarToken = true;
        });
      }
      if (rule.selectors.some((s) => s.includes('.workspace'))) {
        rule.walkDecls('background', (decl) => {
          if (decl.value.includes('var(--workspace-surface)')) workspaceUsesToken = true;
        });
      }
      if (rule.selectors.some((s) => s.includes('.sidebar'))) {
        rule.walkDecls('background', (decl) => {
          if (decl.value.includes('var(--sidebar-surface)')) sidebarUsesToken = true;
        });
      }
    });

    expect(tokenRuleFound).toBe(true);
    expect(hasWorkspaceToken).toBe(true);
    expect(hasSidebarToken).toBe(true);
    expect(workspaceUsesToken).toBe(true);
    expect(sidebarUsesToken).toBe(true);

    const componentsCss = readFileSync(join(srcRoot, 'styles/tokens/components.css'), 'utf8');
    expect(componentsCss).toMatch(/--workspace-surface:\s*var\(--color-workspace\);/);
    expect(componentsCss).toMatch(/--sidebar-surface:\s*var\(--sidebar-bg\);/);
  });

  it('ensures all src CSS files belong to a declared layer without unlayered style escape', () => {
    const indexCss = readFileSync(join(srcRoot, 'styles/index.css'), 'utf8');
    const layerImports = new Set<string>();

    for (const match of indexCss.matchAll(/@import\s+['"]([^'"]+)['"]\s+layer\(([^)]+)\);/g)) {
      const target = match[1];
      const layerName = match[2].trim();
      expect(Boolean(DECLARED_LAYERS[layerName])).toBe(true);
      const normalized = join('styles', target).replaceAll('\\', '/');
      layerImports.add(normalized);
    }

    const files = walkCss(srcRoot);
    const unlayeredFiles: string[] = [];

    for (const filePath of files) {
      const relPath = relative(srcRoot, filePath).replaceAll('\\', '/');
      if (relPath === 'styles/index.css' || relPath === 'styles/layers.css') continue;
      if (layerImports.has(relPath)) continue;
      if (relPath.startsWith('styles/tokens/')) continue;

      const content = readFileSync(filePath, 'utf8');
      const ast = postcss.parse(content, { from: filePath });

      const bareNodes = ast.nodes.filter((node) => {
        if (node.type === 'comment') return false;
        if (node.type === 'atrule' && node.name === 'layer') {
          const params = node.params.trim();
          return !DECLARED_LAYERS[params];
        }
        return true;
      });

      if (bareNodes.length > 0) {
        unlayeredFiles.push(`${relPath} has ${bareNodes.length} unlayered root node(s)`);
      }
    }

    expect(unlayeredFiles).toEqual([]);
  });

  it('prohibits internal @layer blocks inside files imported with layer()', () => {
    const indexCss = readFileSync(join(srcRoot, 'styles/index.css'), 'utf8');
    const violations: string[] = [];

    for (const match of indexCss.matchAll(/@import\s+['"]([^'"]+)['"]\s+layer\(([^)]+)\);/g)) {
      const target = match[1];
      const filePath = join(srcRoot, 'styles', target);
      const content = readFileSync(filePath, 'utf8');
      const ast = postcss.parse(content, { from: filePath });

      ast.walkAtRules('layer', (rule) => {
        const relPath = relative(srcRoot, filePath).replaceAll('\\', '/');
        violations.push(`${relPath}:${rule.source?.start?.line ?? 0} contains nested @layer ${rule.params}`);
      });
    }

    expect(violations).toEqual([]);
  });

  it('scopes runtime injected theme materials strictly inside a single @layer theme block', () => {
    let overlayElement: { dataset: Record<string, string>; textContent: string } | null = null;
    const documentMock = {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      body: { style: {} },
      querySelector: () => null,
      head: {
        append: (element: unknown) => {
          overlayElement = element as { dataset: Record<string, string>; textContent: string };
        },
      },
      createElement: () => ({
        dataset: {},
        textContent: '',
        remove: () => {
          overlayElement = null;
        },
      }),
    } as unknown as Document;

    const themeWithOverlay = builtinThemes.find((t) => t.tokens && Object.keys(t.tokens).length > 0)!;
    const apply = createThemeApplicator(documentMock);
    apply(themeWithOverlay);

    expect(overlayElement).not.toBeNull();
    const cssText = overlayElement?.textContent ?? '';
    const ast = postcss.parse(cssText);

    expect(ast.nodes.length).toBe(1);
    const rootNode = ast.nodes[0];
    expect(rootNode.type).toBe('atrule');
    const atRule = rootNode as postcss.AtRule;
    expect(atRule.name).toBe('layer');
    expect(atRule.params.trim()).toBe('theme');
    expect(atRule.nodes && atRule.nodes.length > 0).toBe(true);
  });
});
