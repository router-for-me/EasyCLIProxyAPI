import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import postcss from 'postcss';

const root = join(import.meta.dir, '..', 'src');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'mocks') return [];
      return walk(full);
    }
    return entry.name.endsWith('.css') ? [full] : [];
  });
}

describe('CSS syntax integrity', () => {
  it('requires all CSS property values to have balanced parentheses and brackets', () => {
    const files = walk(root);
    const violations: string[] = [];

    for (const filePath of files) {
      const relPath = relative(root, filePath).replaceAll('\\', '/');
      const content = readFileSync(filePath, 'utf8');

      let ast: postcss.Root;
      try {
        ast = postcss.parse(content);
      } catch (err: unknown) {
        violations.push(`${relPath}: PostCSS parse error: ${(err as Error).message}`);
        continue;
      }

      ast.walkDecls((decl) => {
        const val = decl.value;
        let parenBalance = 0;
        let bracketBalance = 0;

        for (let i = 0; i < val.length; i++) {
          if (val[i] === '(') parenBalance++;
          else if (val[i] === ')') parenBalance--;
          else if (val[i] === '[') bracketBalance++;
          else if (val[i] === ']') bracketBalance--;

          if (parenBalance < 0) {
            violations.push(`${relPath}:${decl.source?.start?.line ?? 0} ${decl.prop}: unexpected closing ')' in "${val}"`);
            break;
          }
          if (bracketBalance < 0) {
            violations.push(`${relPath}:${decl.source?.start?.line ?? 0} ${decl.prop}: unexpected closing ']' in "${val}"`);
            break;
          }
        }

        if (parenBalance > 0) {
          violations.push(`${relPath}:${decl.source?.start?.line ?? 0} ${decl.prop}: unclosed '(' in "${val}"`);
        }
        if (bracketBalance > 0) {
          violations.push(`${relPath}:${decl.source?.start?.line ?? 0} ${decl.prop}: unclosed '[' in "${val}"`);
        }
      });
    }

    expect(violations).toEqual([]);
  });
});
