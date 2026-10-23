import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import postcss, { type Declaration } from 'postcss';
import ts from 'typescript';
import { themeOpacityTokenProperties, themeTokenProperties } from '../src/themes/types';

const srcRoot = join(import.meta.dir, '..', 'src');

const EXCLUDED_DIRECTORIES = [
  {
    path: 'styles/tokens',
    reason: 'Token definitions layer where baseline palettes, semantic colors, and component tokens are authored',
  },
  {
    path: 'mocks',
    reason: 'Browser mock preview environment only; dev toolbar overlay not loaded in production desktop application',
  },
];

const REGISTERED_THEME_VARIABLES = new Set([
  ...Object.values(themeTokenProperties).flat().filter((name) => name.startsWith('--theme-')),
  '--theme-backdrop-image',
  '--theme-backdrop-position',
  '--theme-backdrop-color',
  '--theme-backdrop-sidebar',
  '--theme-backdrop-panel',
  '--theme-sticky-background',
  '--theme-sticky-hover-background',
  '--theme-overlay-surface',
  '--theme-overlay-soft-surface',
  '--theme-overlay-hover-background',
  '--theme-scrollbar-thumb',
  '--theme-scrollbar-hover',
]);
const BASE_RADIUS_TIERS = new Set([
  '--radius-none',
  '--radius-sm',
  '--radius-md',
  '--radius-lg',
  '--radius-full',
]);

export function resolveRegisteredRadiusVariables(
  decls: { prop: string; value: string }[],
): Set<string> {
  const declsByProp = new Map<string, string[]>();
  for (const d of decls) {
    const prop = unescapeCss(d.prop).trim();
    if (!prop.startsWith('--')) continue;
    if (!declsByProp.has(prop)) declsByProp.set(prop, []);
    declsByProp.get(prop)!.push(d.value.trim());
  }

  const valid = new Set(BASE_RADIUS_TIERS);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [prop, values] of declsByProp.entries()) {
      if (valid.has(prop)) continue;
      const allValid = values.every((val) => {
        const m = /^var\((--[\w-]+)\)$/.exec(val);
        return m && valid.has(m[1]);
      });
      if (allValid) {
        valid.add(prop);
        changed = true;
      }
    }
  }
  return valid;
}

function loadRegisteredRadiusVariables(): Set<string> {
  const tokenFiles = ['base.css', 'semantic.css', 'components.css'];
  const decls: { prop: string; value: string }[] = [];
  for (const tf of tokenFiles) {
    const p = join(srcRoot, 'styles/tokens', tf);
    const root = postcss.parse(readFileSync(p, 'utf8'), { from: p });
    root.walkDecls((decl) => {
      decls.push({ prop: decl.prop, value: decl.value });
    });
  }
  return resolveRegisteredRadiusVariables(decls);
}
export const REGISTERED_RADIUS_VARIABLES = loadRegisteredRadiusVariables();

const NAMED_COLORS = new Set([
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque',
  'black', 'blanchedalmond', 'blue', 'blueviolet', 'brown', 'burlywood', 'cadetblue',
  'chartreuse', 'chocolate', 'coral', 'cornflowerblue', 'cornsilk', 'crimson', 'cyan',
  'darkblue', 'darkcyan', 'darkgoldenrod', 'darkgray', 'darkgreen', 'darkgrey',
  'darkkhaki', 'darkmagenta', 'darkolivegreen', 'darkorange', 'darkorchid', 'darkred',
  'darksalmon', 'darkseagreen', 'darkslateblue', 'darkslategray', 'darkslategrey',
  'darkturquoise', 'darkviolet', 'deeppink', 'deepskyblue', 'dimgray', 'dimgrey',
  'dodgerblue', 'firebrick', 'floralwhite', 'forestgreen', 'fuchsia', 'gainsboro',
  'ghostwhite', 'gold', 'goldenrod', 'gray', 'green', 'greenyellow', 'grey',
  'honeydew', 'hotpink', 'indianred', 'indigo', 'ivory', 'khaki', 'lavender',
  'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral', 'lightcyan',
  'lightgoldenrodyellow', 'lightgray', 'lightgreen', 'lightgrey', 'lightpink',
  'lightsalmon', 'lightseagreen', 'lightskyblue', 'lightslategray', 'lightslategrey',
  'lightsteelblue', 'lightyellow', 'lime', 'limegreen', 'linen', 'magenta',
  'maroon', 'mediumaquamarine', 'mediumblue', 'mediumorchid', 'mediumpurple',
  'mediumseagreen', 'mediumslateblue', 'mediumspringgreen', 'mediumturquoise',
  'mediumvioletred', 'midnightblue', 'mintcream', 'mistyrose', 'moccasin',
  'navajowhite', 'navy', 'oldlace', 'olive', 'olivedrab', 'orange', 'orangered',
  'orchid', 'palegoldenrod', 'palegreen', 'paleturquoise', 'palevioletred',
  'papayawhip', 'peachpuff', 'peru', 'pink', 'plum', 'powderblue', 'purple',
  'rebeccapurple', 'red', 'rosybrown', 'royalblue', 'saddlebrown', 'salmon',
  'sandybrown', 'seagreen', 'seashell', 'sienna', 'silver', 'skyblue',
  'slateblue', 'slategray', 'slategrey', 'snow', 'springgreen', 'steelblue',
  'tan', 'teal', 'thistle', 'tomato', 'turquoise', 'violet', 'wheat',
  'white', 'whitesmoke', 'yellow', 'yellowgreen',
]);

const ALLOWED_KEYWORDS = new Set(['transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'none']);

interface WhitelistEntry {
  file: string;
  selector: string;
  value: string;
  reason: string;
}

const WHITELIST: WhitelistEntry[] = [];

function canPropertyTakeColor(prop: string): boolean {
  const p = prop.toLowerCase();
  if (p.startsWith('--')) return true;
  if (/^(animation|font|grid|counter|container|view-transition|columns|column-count|column-width|column-gap|gap|row-gap|z-index|opacity|order|flex|overflow|display|visibility|clip|cursor|user-select|resize|transform|transition|width|height|min-|max-|margin|padding|top|right|bottom|left|align-|justify-|place-)/.test(p)) {
    if (/color|shadow|fill|stroke|border|outline|image|background/.test(p)) {
      return true;
    }
    return false;
  }
  return true;
}

function unescapeCss(str: string): string {
  return str.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\r\n\f]?|([\s\S]))/g, (_, hex: string | undefined, char: string | undefined) => {
    if (hex) {
      const code = Number.parseInt(hex, 16);
      if (code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) {
        return '\uFFFD';
      }
      return String.fromCodePoint(code);
    }
    return char ?? '';
  });
}

function cssLexemes(value: string): string[] {
  return [...value.matchAll(/\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|(?:\\(?:[0-9a-fA-F]{1,6}[ \t\r\n\f]?|[^\r\n\f])|[\w-])+|[^\s]/g)]
    .map(match => match[0])
    .filter(token => !token.startsWith('/*'));
}

function extractVarTokensFromCssValue(value: string): string[] {
  const lexemes = cssLexemes(value);
  const found: string[] = [];
  const functions: string[] = [];
  for (let i = 0; i < lexemes.length; i++) {
    const token = unescapeCss(lexemes[i]);
    if (token === ')') functions.pop();
    if (lexemes[i + 1] !== '(' || /^["']/.test(lexemes[i])) continue;
    functions.push(token.toLowerCase());
    if (!functions.includes('url') && token.toLowerCase() === 'var') {
      const name = unescapeCss(lexemes[i + 2] ?? '');
      if (name.startsWith('--')) found.push(name);
    }
    i++;
  }
  return found;
}

function extractTokensFromTs(content: string, declared: Set<string>, fileName = 'probe.tsx'): Set<string> {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = new Set<string>();
  const program = ts.createProgram([fileName], { noLib: true, noResolve: true }, {
    ...ts.createCompilerHost({}),
    getSourceFile: name => name === fileName ? sourceFile : undefined,
    fileExists: name => name === fileName,
    readFile: () => undefined,
  });
  const checker = program.getTypeChecker();
  const roots: ts.Node[] = [];
  const sinkNames = new Set(['style', 'className', 'cssText', 'fill', 'stroke']);
  const nameOf = (node: ts.Node) => ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : '';
  function index(node: ts.Node) {
    if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer) && ts.isCallExpression(node.expression)) {
      const binding = node.initializer.declarations[0]?.name;
      const entries = node.expression;
      if (binding && ts.isArrayBindingPattern(binding) && ts.isPropertyAccessExpression(entries.expression) && entries.expression.getText(sourceFile) === 'Object.entries') {
        const key = binding.elements[0];
        function findWriter(child: ts.Node) {
          if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression) && child.expression.name.text === 'setProperty' && key && ts.isBindingElement(key) && child.arguments[0]?.getText(sourceFile) === key.name.getText(sourceFile) && entries.arguments[0]) roots.push(entries.arguments[0]);
          ts.forEachChild(child, findWriter);
        }
        findWriter(node.statement);
      }
    }
    if (ts.isJsxAttribute(node) && sinkNames.has(node.name.getText(sourceFile)) && node.initializer) roots.push(node.initializer);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left) && (sinkNames.has(node.left.name.text) || (ts.isPropertyAccessExpression(node.left.expression) && node.left.expression.name.text === 'style'))) roots.push(node.right);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && /^(setProperty|getPropertyValue|removeProperty)$/.test(node.expression.name.text)) {
      const name = node.arguments[0];
      if (name && (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) && declared.has(name.text)) found.add(name.text);
      if (node.expression.name.text === 'setProperty' && node.arguments[1]) roots.push(node.arguments[1]);
    }
    ts.forEachChild(node, index);
  }
  index(sourceFile);
  const visited = new Map<ts.Node, Set<string>>();
  function consume(node: ts.Node, property = '') {
    if (!visited.has(node)) visited.set(node, new Set());
    if (visited.get(node)!.has(property)) return;
    visited.get(node)!.add(property);
    if (ts.isPropertyAccessExpression(node)) {
      consume(node.expression, node.name.text);
      return;
    }
    if (ts.isIdentifier(node)) {
      const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) consume(declaration.initializer, property);
      if (declaration && ts.isParameter(declaration)) {
        const callback = declaration.parent;
        const call = callback.parent;
        if (ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'map') consume(call.expression.expression, property);
      }
      return;
    }
    if (property) {
      if (ts.isArrayLiteralExpression(node)) for (const item of node.elements) consume(item, property);
      if (ts.isObjectLiteralExpression(node)) for (const item of node.properties) {
        if (ts.isPropertyAssignment(item) && nameOf(item.name) === property) consume(item.initializer);
      }
      return;
    }
    if (ts.isPropertyAssignment(node)) {
      const key = ts.isComputedPropertyName(node.name) ? node.name.expression : node.name;
      const name = nameOf(key);
      if (declared.has(name)) found.add(name);
      consume(node.initializer);
      return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      for (const name of extractVarTokensFromCssValue(node.text)) if (declared.has(name)) found.add(name);
    }
    ts.forEachChild(node, child => consume(child));
  }
  for (const node of roots) consume(node);
  return found;
}

function scanValueTokens(prop: string, val: string): string[] {
  const violations: string[] = [];
  const checkColor = canPropertyTakeColor(prop);

  let i = 0;
  const n = val.length;

  while (i < n) {
    if (/[\s,;/]/.test(val[i])) {
      i += 1;
      continue;
    }

    if (val[i] === '"' || val[i] === "'") {
      const quote = val[i];
      i += 1;
      while (i < n && val[i] !== quote) {
        if (val[i] === '\\') i += 1;
        i += 1;
      }
      if (i < n) i += 1;
      continue;
    }

    if (val[i] === '[') {
      let depth = 1;
      i += 1;
      while (i < n && depth > 0) {
        if (val[i] === '"' || val[i] === "'") {
          const q = val[i];
          i += 1;
          while (i < n && val[i] !== q) {
            if (val[i] === '\\') i += 1;
            i += 1;
          }
          if (i < n) i += 1;
          continue;
        }
        if (val[i] === '[') depth += 1;
        else if (val[i] === ']') depth -= 1;
        i += 1;
      }
      continue;
    }

    if (val.slice(i, i + 4).toLowerCase() === 'url(') {
      i += 4;
      let depth = 1;
      while (i < n && depth > 0) {
        if (val[i] === '"' || val[i] === "'") {
          const q = val[i];
          i += 1;
          while (i < n && val[i] !== q) {
            if (val[i] === '\\') i += 1;
            i += 1;
          }
          if (i < n) i += 1;
          continue;
        }
        if (val[i] === '(') depth += 1;
        else if (val[i] === ')') depth -= 1;
        i += 1;
      }
      continue;
    }

    const start = i;
    while (i < n && !/[\s,;()[\]"']/.test(val[i])) {
      if (val[i] === '\\') {
        i += 1;
        while (i < n && /[0-9a-fA-F]/.test(val[i])) i += 1;
        if (i < n && /[ \t\r\n\f]/.test(val[i])) i += 1;
      } else {
        i += 1;
      }
    }
    const token = val.slice(start, i);

    if (i < n && val[i] === '(') {
      const fnName = unescapeCss(token).toLowerCase();
      i += 1;
      let depth = 1;
      const bodyStart = i;
      while (i < n && depth > 0) {
        if (val[i] === '"' || val[i] === "'") {
          const q = val[i];
          i += 1;
          while (i < n && val[i] !== q) {
            if (val[i] === '\\') i += 1;
            i += 1;
          }
          if (i < n) i += 1;
          continue;
        }
        if (val[i] === '(') depth += 1;
        else if (val[i] === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
        i += 1;
      }
      const fnBody = val.slice(bodyStart, i);
      if (i < n && val[i] === ')') i += 1;

      if (fnName === 'var') {
        const commaIdx = fnBody.indexOf(',');
        const rawVar = (commaIdx === -1 ? fnBody : fnBody.slice(0, commaIdx)).trim();
        const unescapedVar = unescapeCss(rawVar);
        if (unescapedVar.startsWith('--theme-') && !REGISTERED_THEME_VARIABLES.has(unescapedVar)) {
          violations.push(`unregistered theme variable reference: ${unescapedVar}`);
        }
        if (commaIdx !== -1) {
          violations.push(...scanValueTokens(prop, fnBody.slice(commaIdx + 1).trim()));
        }
      } else {
        const isColorFn = /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)$/.test(fnName);
        if (isColorFn) {
          if (/^\s*from\s+/i.test(fnBody)) {
            violations.push(...scanValueTokens(prop, fnBody.replace(/^\s*from\s+/i, '')));
          } else if (checkColor) {
            violations.push(`color literal function: ${token}(${fnBody})`);
          }
        } else {
          violations.push(...scanValueTokens(prop, fnBody));
        }
      }
      continue;
    }

    if (token.startsWith('#')) {
      if (checkColor && /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(token)) {
        violations.push(`color literal hex: ${token}`);
      }
      continue;
    }

    if (token) {
      const unescaped = unescapeCss(token);
      if (unescaped.startsWith('--theme-')) {
        if (!REGISTERED_THEME_VARIABLES.has(unescaped)) {
          violations.push(`unregistered theme variable reference: ${unescaped}`);
        }
        continue;
      }

      if (checkColor) {
        const lower = unescaped.toLowerCase();
        if (NAMED_COLORS.has(lower) && !ALLOWED_KEYWORDS.has(lower)) {
          violations.push(`named color literal: ${lower}`);
        }
      }
    }
  }

  return violations;
}

function walkCss(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return walkCss(full);
    }
    return entry.name.endsWith('.css') ? [full] : [];
  });
}

function getSelector(decl: Declaration): string {
  if (decl.parent?.type === 'rule' && 'selector' in decl.parent && typeof decl.parent.selector === 'string') {
    return decl.parent.selector;
  }
  return decl.parent?.type ?? 'unknown';
}

function findViolationsInDecl(relPath: string, decl: Declaration): string[] {
  const violations: string[] = [];
  const line = decl.source?.start?.line ?? 0;
  const selector = getSelector(decl);
  const prop = decl.prop;
  const value = decl.value;

  if (decl.important) {
    violations.push(`${relPath}:${line} [${selector}] ${prop}: ${value} !important (forbidden !important)`);
  }

  if (prop.startsWith('--theme-')) {
    const unescapedProp = unescapeCss(prop);
    if (!REGISTERED_THEME_VARIABLES.has(unescapedProp)) {
      violations.push(`${relPath}:${line} [${selector}] ${prop}: ${value} (unregistered theme variable declaration)`);
    }
  }

  const isWhitelisted = WHITELIST.some((entry) => {
    if (entry.file !== relPath) return false;
    if (entry.selector && !selector.includes(entry.selector)) return false;
    return value.includes(entry.value);
  });
  if (isWhitelisted) {
    return violations;
  }

  const valueViolations = scanValueTokens(prop, value);
  for (const violation of valueViolations) {
    violations.push(`${relPath}:${line} [${selector}] ${prop}: ${value} (${violation})`);
  }

  return violations;
}
function splitCssValues(str: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let parenDepth = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth--;
    if (/\s/.test(ch) && parenDepth === 0) {
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

export function checkRadiusDeclaration(
  decl: Declaration,
  relPath: string,
  registeredTokens: Set<string> = REGISTERED_RADIUS_VARIABLES,
): string[] {
  const rawProp = unescapeCss(decl.prop).trim();
  const selector = getSelector(decl);
  const line = decl.source?.start?.line ?? 0;
  const violations: string[] = [];

  if (rawProp.startsWith('--')) {
    if (BASE_RADIUS_TIERS.has(rawProp) && relPath !== 'styles/tokens/base.css') {
      violations.push(`${relPath}:${line} [${selector}] ${decl.prop}: ${decl.value} (forbidden definition of tier variable outside base.css: ${rawProp})`);
      return violations;
    }
    if (registeredTokens.has(rawProp) && !relPath.startsWith('styles/tokens/')) {
      violations.push(`${relPath}:${line} [${selector}] ${decl.prop}: ${decl.value} (forbidden definition or override of radius token outside tokens: ${rawProp})`);
      return violations;
    }
    return violations;
  }

  const normProp = rawProp.toLowerCase();
  if (!/^border(-.+)?-radius$/.test(normProp)) return violations;
  const trimmed = decl.value.trim();
  if (trimmed === 'inherit') return violations;
  const parts = splitCssValues(trimmed);
  if (parts.length === 0 || parts.length > 4) {
    violations.push(`${relPath}:${line} [${selector}] ${decl.prop}: ${decl.value} (invalid radius value: ${decl.value})`);
    return violations;
  }
  for (const part of parts) {
    const varMatch = part.match(/^var\((--[\w-]+)\)$/);
    if (!varMatch) {
      violations.push(`${relPath}:${line} [${selector}] ${decl.prop}: ${decl.value} (non-tier radius literal or expression: ${part})`);
      continue;
    }
    if (!registeredTokens.has(varMatch[1])) {
      violations.push(`${relPath}:${line} [${selector}] ${decl.prop}: ${decl.value} (unregistered radius variable: ${varMatch[1]})`);
    }
  }
  return violations;
}
export function checkRadiusAtRule(
  atRule: { name: string; params: string; source?: { start?: { line?: number } }; raws?: { afterName?: string } },
  relPath: string,
  registeredTokens: Set<string> = REGISTERED_RADIUS_VARIABLES,
): string[] {
  const keyword = cssLexemes(`${atRule.name}${atRule.raws?.afterName ?? ' '}${atRule.params}`);
  if (unescapeCss(keyword[0] ?? '').toLowerCase() !== 'property') return [];
  const rawParam = unescapeCss(keyword[1] ?? '');
  const line = atRule.source?.start?.line ?? 0;
  if (BASE_RADIUS_TIERS.has(rawParam) || registeredTokens.has(rawParam)) {
    return [`${relPath}:${line} @property ${atRule.params} (forbidden @property registration of radius token: ${rawParam})`];
  }
  return [];
}



export function scanCssViolations(
  cssText: string,
  relPath: string,
  registeredTokens: Set<string> = REGISTERED_RADIUS_VARIABLES,
): string[] {
  const ast = postcss.parse(cssText, { from: relPath });
  const violations: string[] = [];
  ast.walkDecls((decl) => {
    violations.push(...findViolationsInDecl(relPath, decl));
    violations.push(...checkRadiusDeclaration(decl, relPath, registeredTokens));
  });
  ast.walkAtRules((atRule) => {
    violations.push(...checkRadiusAtRule(atRule, relPath, registeredTokens));
  });
  return violations;
}

describe('CSS tokenization and theme variable lint', () => {
  it('prohibits color literals, unregistered --theme-* variables, non-tier radius, and !important outside tokens layer', () => {
    const allFiles = walkCss(srcRoot);
    const nonExcludedFiles = allFiles.filter((filePath) => {
      const rel = relative(srcRoot, filePath).replaceAll('\\', '/');
      return !EXCLUDED_DIRECTORIES.some((exc) => rel === exc.path || rel.startsWith(`${exc.path}/`));
    });

    const allViolations: string[] = [];
    for (const filePath of nonExcludedFiles) {
      const relPath = relative(srcRoot, filePath).replaceAll('\\', '/');
      const css = readFileSync(filePath, 'utf8');
      allViolations.push(...scanCssViolations(css, relPath));
    }

    expect(allViolations).toEqual([]);
  });
  it('tolerates non-color identifiers, strings, urls, and token-derived relative colors', () => {
    const negativeCases = [
      'background: url("icons.svg#abcdef");',
      'background: url("--theme-abcdef.svg");',
      'background: url(white.svg);',
      'background: URL(white.svg);',
      'content: "white #abcdef rgba(0,0,0,.5) --theme-abcdef";',
      'animation-name: red;',
      'animation: red 1s ease;',
      'font-family: "Black", sans-serif;',
      'font: 12px Black;',
      'grid-template-areas: "white red";',
      'grid-template-columns: [red] 1fr [blue];',
      'color: rgb(from var(--color-text-primary) r g b);',
      'color: var(--color-text-primary);',
      'color: var(--theme-\\73 urface);',
      '--probe: \\ffffff;',
      'color: transparent;',
      'color: currentColor;',
    ];

    for (const snippet of negativeCases) {
      expect(scanCssViolations(`.sample { ${snippet} }`, 'sample.css')).toEqual([]);
    }
  });

  it('detects color literals in var fallbacks, modern color functions, and escaped names', () => {
    expect(scanCssViolations('.sample { color: var(--color-text-primary, white); }', 'sample.css')).toEqual([
      'sample.css:1 [.sample] color: var(--color-text-primary, white) (named color literal: white)',
    ]);

    expect(scanCssViolations('.sample { color: var(--color-text-primary, #123456); }', 'sample.css')).toEqual([
      'sample.css:1 [.sample] color: var(--color-text-primary, #123456) (color literal hex: #123456)',
    ]);

    expect(scanCssViolations('.sample { color: var(--color-text-primary, rgba(0,0,0,.5)); }', 'sample.css')).toEqual([
      'sample.css:1 [.sample] color: var(--color-text-primary, rgba(0,0,0,.5)) (color literal function: rgba(0,0,0,.5))',
    ]);

    expect(scanCssViolations('.sample { color: var(--foo, var(--theme-abcdef)); }', 'sample.css')).toEqual([
      'sample.css:1 [.sample] color: var(--foo, var(--theme-abcdef)) (unregistered theme variable reference: --theme-abcdef)',
    ]);

    expect(scanCssViolations('.sample { color: var(--theme-\\61 bcdef); }', 'sample.css')).toEqual([
      'sample.css:1 [.sample] color: var(--theme-\\61 bcdef) (unregistered theme variable reference: --theme-abcdef)',
    ]);

    expect(scanCssViolations('.sample { color: r\\67 b(1 2 3); }', 'sample.css')).toEqual([
      'sample.css:1 [.sample] color: r\\67 b(1 2 3) (color literal function: r\\67 b(1 2 3))',
    ]);

    expect(scanCssViolations('.sample { color: color(srgb 1 0 0); }', 'sample.css')).toEqual([
      'sample.css:1 [.sample] color: color(srgb 1 0 0) (color literal function: color(srgb 1 0 0))',
    ]);

    expect(scanCssViolations('.sample { color: r\\65 d; }', 'sample.css')).toEqual([
      'sample.css:1 [.sample] color: r\\65 d (named color literal: red)',
    ]);
  });

  it('mutates on hex color literal, rgba color literal, and unregistered theme variable', () => {
    const hexSample = '.sample { color: #123456; }';
    expect(scanCssViolations(hexSample, 'sample.css')).toEqual([
      'sample.css:1 [.sample] color: #123456 (color literal hex: #123456)',
    ]);

    const rgbaSample = '.sample { background: rgba(0, 0, 0, 0.5); }';
    expect(scanCssViolations(rgbaSample, 'sample.css')).toEqual([
      'sample.css:1 [.sample] background: rgba(0, 0, 0, 0.5) (color literal function: rgba(0, 0, 0, 0.5))',
    ]);

    const unregisteredThemeVarSample = '.sample { color: var(--theme-abcdef); }';
    expect(scanCssViolations(unregisteredThemeVarSample, 'sample.css')).toEqual([
      'sample.css:1 [.sample] color: var(--theme-abcdef) (unregistered theme variable reference: --theme-abcdef)',
    ]);

    const importantSample = '.sample { color: var(--color-text-primary) !important; }';
    expect(scanCssViolations(importantSample, 'sample.css')).toEqual([
      'sample.css:1 [.sample] color: var(--color-text-primary) !important (forbidden !important)',
    ]);

    const namedColorSample = '.sample { color: white; }';
    expect(scanCssViolations(namedColorSample, 'sample.css')).toEqual([
      'sample.css:1 [.sample] color: white (named color literal: white)',
    ]);
  });

  it('mutates on non-tier radius literal and unregistered radius variable', () => {
    const literalSample = '.sample { border-radius: 7px; }';
    expect(scanCssViolations(literalSample, 'sample.css')).toEqual([
      'sample.css:1 [.sample] border-radius: 7px (non-tier radius literal or expression: 7px)',
    ]);

    const percentSample = '.sample { border-radius: 50%; }';
    expect(scanCssViolations(percentSample, 'sample.css')).toEqual([
      'sample.css:1 [.sample] border-radius: 50% (non-tier radius literal or expression: 50%)',
    ]);

    const unregSample = '.sample { border-radius: var(--unregistered-radius); }';
    expect(scanCssViolations(unregSample, 'sample.css')).toEqual([
      'sample.css:1 [.sample] border-radius: var(--unregistered-radius) (unregistered radius variable: --unregistered-radius)',
    ]);

    const escapedPropSample = '.sample { border-\\72 adius: 7px; }';
    expect(scanCssViolations(escapedPropSample, 'sample.css')).toEqual([
      'sample.css:1 [.sample] border-\\72 adius: 7px (non-tier radius literal or expression: 7px)',
    ]);

    const uppercasePropSample = '.sample { BORDER-RADIUS: 7px; }';
    expect(scanCssViolations(uppercasePropSample, 'sample.css')).toEqual([
      'sample.css:1 [.sample] BORDER-RADIUS: 7px (non-tier radius literal or expression: 7px)',
    ]);

    const calcSample = '.sample { border-radius: calc(var(--radius-md) + 1px); }';
    expect(scanCssViolations(calcSample, 'sample.css')).toEqual([
      'sample.css:1 [.sample] border-radius: calc(var(--radius-md) + 1px) (non-tier radius literal or expression: calc(var(--radius-md) + 1px))',
    ]);

    const multiWithLiteralSample = '.sample { border-radius: var(--radius-md) 7px; }';
    expect(scanCssViolations(multiWithLiteralSample, 'sample.css')).toEqual([
      'sample.css:1 [.sample] border-radius: var(--radius-md) 7px (non-tier radius literal or expression: 7px)',
    ]);

    const fallbackSample = '.sample { border-radius: var(--radius-md, 7px); }';
    expect(scanCssViolations(fallbackSample, 'sample.css')).toEqual([
      'sample.css:1 [.sample] border-radius: var(--radius-md, 7px) (non-tier radius literal or expression: var(--radius-md, 7px))',
    ]);

    const redefSample = '.sample { --radius-md: 7px; }';
    expect(scanCssViolations(redefSample, 'sample.css')).toEqual([
      'sample.css:1 [.sample] --radius-md: 7px (forbidden definition of tier variable outside base.css: --radius-md)',
    ]);

    const validCompoundSample = '.sample { border-radius: var(--radius-md) var(--radius-md) var(--radius-none) var(--radius-none); }';
    expect(scanCssViolations(validCompoundSample, 'sample.css')).toEqual([]);

    const validLonghandSample = '.sample { border-top-left-radius: var(--radius-md); }';
    expect(scanCssViolations(validLonghandSample, 'sample.css')).toEqual([]);

    const inheritSample = '.sample { border-radius: inherit; }';
    expect(scanCssViolations(inheritSample, 'sample.css')).toEqual([]);
  });

  it('enforces strict radius alias registration, case sensitivity, and forbids scope override leaks', () => {
    const registeredWithChains = resolveRegisteredRadiusVariables([
      { prop: '--chain-a', value: 'var(--radius-sm)' },
      { prop: '--chain-b', value: 'var(--chain-a)' },
      { prop: '--CASE-ALIAS', value: 'var(--radius-md)' },
      { prop: '--case-alias', value: '7px' },
      { prop: '--scope-alias', value: '7px' },
      { prop: '--scope-alias', value: 'var(--radius-md)' },
    ]);

    expect(registeredWithChains.has('--chain-a')).toBe(true);
    expect(registeredWithChains.has('--chain-b')).toBe(true);
    expect(registeredWithChains.has('--CASE-ALIAS')).toBe(true);
    expect(registeredWithChains.has('--case-alias')).toBe(false);
    expect(registeredWithChains.has('--scope-alias')).toBe(false);

    const overrideChainA = '.sample { --chain-a: 7px; border-radius: var(--chain-a); }';
    expect(scanCssViolations(overrideChainA, 'sample.css', registeredWithChains)).toEqual([
      'sample.css:1 [.sample] --chain-a: 7px (forbidden definition or override of radius token outside tokens: --chain-a)',
    ]);

    const chainInScope = '.sample { --chain-b: var(--chain-a); --chain-c: var(--chain-b); border-radius: var(--chain-c); }';
    expect(scanCssViolations(chainInScope, 'sample.css', registeredWithChains)).toEqual([
      'sample.css:1 [.sample] --chain-b: var(--chain-a) (forbidden definition or override of radius token outside tokens: --chain-b)',
      'sample.css:1 [.sample] border-radius: var(--chain-c) (unregistered radius variable: --chain-c)',
    ]);

    const conditionalOverride = '@supports (display: grid) { .sample { --chain-a: 7px; border-radius: var(--chain-a); } }';
    expect(scanCssViolations(conditionalOverride, 'sample.css', registeredWithChains)).toEqual([
      'sample.css:1 [.sample] --chain-a: 7px (forbidden definition or override of radius token outside tokens: --chain-a)',
    ]);

    const mediaOverride = '@media (min-width: 0px) { .sample { --radius-md: 7px; border-radius: var(--radius-md); } }';
    expect(scanCssViolations(mediaOverride, 'sample.css', registeredWithChains)).toEqual([
      'sample.css:1 [.sample] --radius-md: 7px (forbidden definition of tier variable outside base.css: --radius-md)',
    ]);

    const caseAliasSample = '.sample { border-radius: var(--case-alias); }';
    expect(scanCssViolations(caseAliasSample, 'sample.css', registeredWithChains)).toEqual([
      'sample.css:1 [.sample] border-radius: var(--case-alias) (unregistered radius variable: --case-alias)',
    ]);

    const scopeAliasSample = '.sample { border-radius: var(--scope-alias); }';
    expect(scanCssViolations(scopeAliasSample, 'sample.css', registeredWithChains)).toEqual([
      'sample.css:1 [.sample] border-radius: var(--scope-alias) (unregistered radius variable: --scope-alias)',
    ]);

    const validCaseSample = '.sample { border-radius: var(--CASE-ALIAS); }';
    expect(scanCssViolations(validCaseSample, 'sample.css', registeredWithChains)).toEqual([]);

    const validChainSample = '.sample { border-radius: var(--chain-b); }';
    expect(scanCssViolations(validChainSample, 'sample.css', registeredWithChains)).toEqual([]);

    const atPropertyTier = '@property --radius-md { syntax: "<length>"; inherits: false; initial-value: 7px; }';
    expect(scanCssViolations(atPropertyTier, 'sample.css', registeredWithChains)).toEqual([
      'sample.css:1 @property --radius-md (forbidden @property registration of radius token: --radius-md)',
    ]);

    const atPropertyAlias = '@property --chain-a { syntax: "<length>"; inherits: false; initial-value: 7px; }';
    expect(scanCssViolations(atPropertyAlias, 'sample.css', registeredWithChains)).toEqual([
      'sample.css:1 @property --chain-a (forbidden @property registration of radius token: --chain-a)',
    ]);

    const atPropertySupports = '@supports (display: grid) { @property --radius-md { syntax: "<length>"; inherits: false; initial-value: 7px; } }';
    expect(scanCssViolations(atPropertySupports, 'sample.css', registeredWithChains)).toEqual([
      'sample.css:1 @property --radius-md (forbidden @property registration of radius token: --radius-md)',
    ]);

    const atPropertyMedia = '@media (min-width: 0px) { @property --radius-md { syntax: "<length>"; inherits: false; initial-value: 7px; } }';
    expect(scanCssViolations(atPropertyMedia, 'sample.css', registeredWithChains)).toEqual([
      'sample.css:1 @property --radius-md (forbidden @property registration of radius token: --radius-md)',
    ]);

    const atPropertyEscaped = '@property --\\72 adius-md { syntax: "<length>"; inherits: false; initial-value: 7px; }';
    expect(scanCssViolations(atPropertyEscaped, 'sample.css', registeredWithChains)).toEqual([
      'sample.css:1 @property --\\72 adius-md (forbidden @property registration of radius token: --radius-md)',
    ]);
  });
  it.each([
    { name: "rejects escaped property keyword", css: "@pr\\6f perty --radius-md{syntax:\"<length>\";inherits:false;initial-value:7px}.sample{border-radius:var(--radius-md)}", expected: true },
    { name: "rejects escaped property keyword uppercase", css: "@P\\52 OPERTY --radius-md{syntax:\"<length>\";inherits:false;initial-value:7px}.sample{border-radius:var(--radius-md)}", expected: true },
    { name: "rejects supports escaped keyword", css: "@supports(display:grid){@pr\\6f perty --radius-md{syntax:\"<length>\";inherits:false;initial-value:7px}}.sample{border-radius:var(--radius-md)}", expected: true },
    { name: "rejects media escaped keyword", css: "@media(min-width:0px){@pr\\6f perty --radius-md{syntax:\"<length>\";inherits:false;initial-value:7px}}.sample{border-radius:var(--radius-md)}", expected: true },
    { name: "rejects layer escaped keyword", css: "@layer test{@pr\\6f perty --radius-md{syntax:\"<length>\";inherits:false;initial-value:7px}}.sample{border-radius:var(--radius-md)}", expected: true },
  ])('$name', ({ css, expected }) => {
    expect(scanCssViolations(css, 'sample.css').some(value => value.includes('forbidden @property'))).toBe(expected);
  });

  it.each([
    { name: "recognizes CSS consumption: double escaped quote string", css: ".probe{content:\"\\\"var(--audit-orphan)\\\"\"}", expected: [] },
    { name: "recognizes CSS consumption: single escaped quote string", css: ".probe{content:'\\'var(--audit-orphan)\\''}", expected: [] },
    { name: "recognizes CSS consumption: escaped quote conditional", css: "@supports(display:grid){.probe{content:\"\\\"var(--audit-orphan)\\\"\"}}", expected: [] },
    { name: "recognizes CSS consumption: comment markers inside strings with real var", css: ".probe{content:\"/*\" var(--audit-orphan) \"*/\"}", expected: ["--audit-orphan"] },
    { name: "recognizes CSS consumption: escaped var function", css: ".probe{width:v\\61 r(--audit-orphan)}", expected: ["--audit-orphan"] },
    { name: "recognizes CSS consumption: escaped var function in media", css: "@media(min-width:0px){.probe{width:v\\61 r(--audit-orphan)}}", expected: ["--audit-orphan"] },
    { name: "recognizes CSS consumption: escaped token hyphen", css: ".probe{width:var(--audit\\2d orphan)}", expected: ["--audit-orphan"] },
    { name: "recognizes CSS consumption: escaped token six digit", css: ".probe{width:var(--audit-\\00006f rphan)}", expected: ["--audit-orphan"] },
    { name: "recognizes CSS consumption: CSS quote-only comment", css: ".probe{content:\"/* var(--audit-orphan) */\"}", expected: [] },
    { name: "recognizes CSS consumption: CSS URL uppercase", css: ".probe{background:URL(\"var(--audit-orphan)\")}", expected: [] },
    { name: "recognizes CSS consumption: CSS URL escaped keyword", css: ".probe{background:u\\72 l(\"var(--audit-orphan)\")}", expected: [] },
    { name: "recognizes CSS consumption: CSS fallback live reference", css: ".probe{width:var(--not-defined,var(--audit-orphan))}", expected: ["--audit-orphan"] },
    { name: "recognizes CSS consumption: CSS string fallback phantom", css: ".probe{content:var(--other,\"var(--audit-orphan)\")}", expected: [] },
  ])('$name', ({ css, expected }) => {
    const found: string[] = [];
    postcss.parse(css).walkDecls(decl => { found.push(...extractVarTokensFromCssValue(decl.value)); });
    expect(found.filter(name => name === '--audit-orphan')).toEqual(expected);
  });

  it.each([
    { name: "recognizes TS consumption: TS unused exact literal", source: "export const documentation=\"--audit-orphan\";", fileName: "probe.tsx", expected: [] },
    { name: "recognizes TS consumption: TS unused var text", source: "console.log(\"var(--audit-orphan)\");", fileName: "probe.tsx", expected: [] },
    { name: "recognizes TS consumption: TS CSS quoted literal", source: "export const prose='content:\"var(--audit-orphan)\"';", fileName: "probe.tsx", expected: [] },
    { name: "recognizes TS consumption: TS unicode literal read", source: "document.documentElement.style.getPropertyValue(\"--audit-\\u006frphan\");", fileName: "probe.tsx", expected: ["--audit-orphan"] },
    { name: "recognizes TS consumption: TS CSS escaped var literal", source: "document.body.style.cssText=\"width:var(--audit-\\\\6f rphan)\";", fileName: "probe.tsx", expected: ["--audit-orphan"] },
    { name: "recognizes TS consumption: TS non substitution template read", source: "document.documentElement.style.getPropertyValue(`--audit-orphan`);", fileName: "probe.tsx", expected: ["--audit-orphan"] },
    { name: "recognizes TS consumption: TS literal lookalike suffix", source: "export const x=\"--audit-orphan-other\";", fileName: "probe.tsx", expected: [] },
    { name: "recognizes TS consumption: TS comment exact token", source: "/*\"--audit-orphan\"*/", fileName: "probe.tsx", expected: [] },
    { name: "recognizes TS consumption: style object key", source: "const style = {\"--audit-orphan\": \"1px\"}; <div style={style} />", fileName: "probe.tsx", expected: ["--audit-orphan"] },
    { name: "recognizes TS consumption: computed style key", source: "<div style={{[\"--audit-orphan\"]: \"1px\"}} />", fileName: "probe.tsx", expected: ["--audit-orphan"] },
    { name: "recognizes TS consumption: unused object key", source: "const docs = {\"--audit-orphan\": \"1px\"};", fileName: "probe.tsx", expected: [] },
    { name: "recognizes TS consumption: className reference", source: "const value = \"var(--audit-orphan)\"; <div className={value} />", fileName: "probe.tsx", expected: ["--audit-orphan"] },
    { name: "recognizes TS consumption: style object data", source: "const values = [{color: \"var(--audit-orphan)\"}]; values.map(item => <div style={{color: item.color}} />)", fileName: "probe.tsx", expected: ["--audit-orphan"] },
    { name: "recognizes TS consumption: removeProperty", source: "document.body.style.removeProperty(\"--audit-orphan\")", fileName: "probe.tsx", expected: ["--audit-orphan"] },
    { name: "recognizes TS consumption: CSS quoted style text", source: "document.body.style.cssText = 'content:\"var(--audit-orphan)\"';", fileName: "probe.tsx", expected: [] },
    { name: "recognizes TS consumption: theme injection key", source: "for (const [key,value] of Object.entries({\"--audit-orphan\": theme.color})) root.style.setProperty(key,value)", fileName: "src/themes/applyTheme.ts", expected: ["--audit-orphan"] },
  ])('$name', ({ source, fileName, expected }) => {
    expect([...extractTokensFromTs(source, new Set(['--audit-orphan']), fileName)]).toEqual(expected);
  });

  it('ignores unused style data and theme documentation', () => {
    const declared = new Set(['--audit-orphan']);
    expect([...extractTokensFromTs('const style = { color: "var(--audit-orphan)" };', declared)]).toEqual([]);
    expect([...extractTokensFromTs('const documentation = { "--audit-orphan": "1px" };', declared, 'src/themes/documentation.ts')]).toEqual([]);
  });

  it('does not follow unrelated property names or shadowed variables into styles', () => {
    const declared = new Set(['--audit-orphan']);
    expect([...extractTokensFromTs('const docs = { color: "var(--audit-orphan)" }; const actual = { color: "red" }; <div style={{ color: actual.color }} />;', declared)]).toEqual([]);
    expect([...extractTokensFromTs('const color = "var(--audit-orphan)"; <div style={{color: "red"}} />;', declared)]).toEqual([]);
    expect([...extractTokensFromTs('const value = "var(--audit-orphan)"; function Sample() { const value = "red"; return <div style={{color: value}} />; }', declared)]).toEqual([]);
  });

  it('recognizes CSS variable values assigned to style properties', () => {
    expect([...extractTokensFromTs('const color = "var(--audit-orphan)"; document.body.style.color = color;', new Set(['--audit-orphan']))]).toEqual(['--audit-orphan']);
  });

  it('verifies that every custom property in tokens directory is reachable by a real consumer', () => {
    const tokenFiles = ['base.css', 'semantic.css', 'components.css'];
    const declaredTokens = new Set<string>();
    const definitionEdges = new Map<string, Set<string>>();

    for (const tf of tokenFiles) {
      const p = join(srcRoot, 'styles/tokens', tf);
      const root = postcss.parse(readFileSync(p, 'utf8'), { from: p });
      root.walkDecls((decl) => {
        const prop = unescapeCss(decl.prop).trim();
        if (prop.startsWith('--')) {
          declaredTokens.add(prop);
          if (!definitionEdges.has(prop)) definitionEdges.set(prop, new Set());
          const refs = extractVarTokensFromCssValue(decl.value);
          for (const r of refs) definitionEdges.get(prop)!.add(r);
        }
      });
    }

    const themeRoots = new Set<string>([
      ...REGISTERED_THEME_VARIABLES,
      ...Object.values(themeTokenProperties).flat(),
      ...Object.values(themeOpacityTokenProperties).flat(),
    ]);

    const directlyConsumedTokens = new Set<string>(themeRoots);

    function walkAll(dir: string): string[] {
      const res: string[] = [];
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, ent.name);
        if (ent.isDirectory()) res.push(...walkAll(full));
        else if (/\.(css|ts|tsx)$/.test(ent.name)) res.push(full);
      }
      return res;
    }

    const nonTokenFiles = walkAll(srcRoot).filter((f) => !f.includes('styles/tokens/'));
    for (const f of nonTokenFiles) {
      const content = readFileSync(f, 'utf8');
      if (f.endsWith('.ts') || f.endsWith('.tsx')) {
        const tsConsumed = extractTokensFromTs(content, declaredTokens, f);
        for (const t of tsConsumed) directlyConsumedTokens.add(t);
      } else if (f.endsWith('.css')) {
        const root = postcss.parse(content, { from: f });
        root.walkDecls((decl) => {
          const prop = unescapeCss(decl.prop).trim();
          const isCustomProp = prop.startsWith('--');
          const refs = extractVarTokensFromCssValue(decl.value);
          if (isCustomProp) {
            if (!definitionEdges.has(prop)) definitionEdges.set(prop, new Set());
            for (const ref of refs) definitionEdges.get(prop)!.add(ref);
          } else {
            for (const ref of refs) {
              directlyConsumedTokens.add(ref);
            }
          }
        });
      }
    }

    function computeUnreachable(
      tokens: Set<string>,
      edges: Map<string, Set<string>>,
      roots: Set<string>,
    ): string[] {
      const reachable = new Set<string>();
      const queue = [...roots];
      for (const q of queue) reachable.add(q);
      let head = 0;
      while (head < queue.length) {
        const curr = queue[head++];
        const deps = edges.get(curr);
        if (deps) {
          for (const dep of deps) {
            if (!reachable.has(dep)) {
              reachable.add(dep);
              queue.push(dep);
            }
          }
        }
      }
      return [...tokens].filter((t) => !reachable.has(t));
    }

    const unreachable = computeUnreachable(declaredTokens, definitionEdges, directlyConsumedTokens);
    expect(unreachable).toEqual([]);

    const mutatedTokens = new Set(declaredTokens);
    mutatedTokens.add('--mutated-dead-token');
    const mutatedEdges = new Map(definitionEdges);
    mutatedEdges.set('--mutated-dead-alias', new Set(['--mutated-dead-token']));
    const mutatedUnreachable = computeUnreachable(mutatedTokens, mutatedEdges, directlyConsumedTokens);
    expect(mutatedUnreachable).toContain('--mutated-dead-token');

    const probeTokens = new Set(['--audit-orphan']);
    expect(extractVarTokensFromCssValue('content: "var(--audit-orphan)";')).toEqual([]);
    expect(extractVarTokensFromCssValue('background: url("var(--audit-orphan)");')).toEqual([]);
    expect(extractTokensFromTs('// --audit-orphan', probeTokens).has('--audit-orphan')).toBe(false);
    expect(extractTokensFromTs('/* --audit-orphan */', probeTokens).has('--audit-orphan')).toBe(false);
    expect(extractTokensFromTs('const text = "about --audit-orphan docs";', probeTokens).has('--audit-orphan')).toBe(false);
    expect(extractTokensFromTs('const name = "prefix--audit-orphan-suffix";', probeTokens).has('--audit-orphan')).toBe(false);

    expect(extractVarTokensFromCssValue('background: var( --audit-orphan);')).toEqual(['--audit-orphan']);
    expect(extractVarTokensFromCssValue('background: var(/*comment*/--audit-orphan);')).toEqual(['--audit-orphan']);
    expect(extractVarTokensFromCssValue('background: var(--audit-\\6f rphan);')).toEqual(['--audit-orphan']);
  });
});
