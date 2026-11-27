import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const root = join(import.meta.dir, '..');
const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const path = join(directory, entry.name);
  return entry.isDirectory() ? files(path) : /\.tsx?$/.test(path) ? [path] : [];
});
const source = (path: string) => ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
const walk = (node: ts.Node, visit: (node: ts.Node) => void) => {
  visit(node);
  ts.forEachChild(node, child => walk(child, visit));
};

const isPlatformOwner = (name: string) => {
  name = name.replaceAll('\\', '/');
  return name.startsWith('services/') || name.startsWith('mocks/');
};

test('classifies Windows platform owner paths like POSIX paths', () => {
  expect(isPlatformOwner('services\\platform.ts')).toBe(true);
  expect(isPlatformOwner('mocks\\browserMockRuntime.ts')).toBe(true);
  expect(isPlatformOwner('pages\\HomePage.tsx')).toBe(false);
});

test('Tauri APIs stay inside services and browser mocks', () => {
  const violations: string[] = [];
  for (const path of files(join(root, 'src'))) {
    const name = relative(join(root, 'src'), path).replaceAll('\\', '/');
    if (isPlatformOwner(name)) continue;
    walk(source(path), node => {
      if (ts.isStringLiteral(node) && node.text.startsWith('@tauri-apps/')) violations.push(name);
    });
  }
  expect([...new Set(violations)]).toEqual([]);
});

test('service IPC commands are registered and have browser mock contracts', () => {
  const commands = new Set<string>();
  const dynamic: string[] = [];
  const invokeSources = new Set(['@tauri-apps/api/core', './platform', './rpc']);
  for (const path of files(join(root, 'src/services'))) {
    const relName = relative(join(root, 'src/services'), path).replaceAll('\\', '/');
    if (relName === 'rpc.ts') continue;
    const module = source(path);
    const invokers = new Set<string>();
    const namespaces = new Set<string>();
    for (const node of module.statements) {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)
        || !invokeSources.has(node.moduleSpecifier.text)) continue;
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
        if ((binding.propertyName ?? binding.name).text === 'invoke') invokers.add(binding.name.text);
      }
    }
    // Track local thin invoke wrappers (both `const fn = ...` and `function fn(...)`).
    const wrapperNames = new Set<string>();
    const checkForwarding = (firstParam: ts.BindingName, body: ts.Node): boolean => {
      if (!ts.isIdentifier(firstParam)) return false;
      let forwards = false;
      walk(body, inner => {
        if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression)
          && invokers.has(inner.expression.text)
          && inner.arguments[0] && ts.isIdentifier(inner.arguments[0])
          && inner.arguments[0].text === firstParam.text) {
          forwards = true;
        }
      });
      return forwards;
    };
    for (const node of module.statements) {
      if (ts.isFunctionDeclaration(node) && node.name && node.parameters.length > 0 && node.body) {
        if (checkForwarding(node.parameters[0].name, node.body)) {
          wrapperNames.add(node.name.text);
        }
      }
      if (!ts.isVariableStatement(node)) continue;
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        if (ts.isIdentifier(decl.initializer) && (invokers.has(decl.initializer.text) || wrapperNames.has(decl.initializer.text))) {
          wrapperNames.add(decl.name.text);
        } else if (ts.isArrowFunction(decl.initializer) && decl.initializer.parameters.length > 0) {
          if (checkForwarding(decl.initializer.parameters[0].name, decl.initializer.body)) {
            wrapperNames.add(decl.name.text);
          }
        }
      }
    }
    walk(module, node => {
      if (!ts.isCallExpression(node)) return;
      const expression = node.expression;
      const isDirectInvoke = ts.isIdentifier(expression) && invokers.has(expression.text)
        || ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)
          && namespaces.has(expression.expression.text) && expression.name.text === 'invoke';
      const isWrapperInvoke = ts.isIdentifier(expression) && wrapperNames.has(expression.text);
      if (!isDirectInvoke && !isWrapperInvoke) return;
      const command = node.arguments[0];
      if (command && ts.isStringLiteral(command)) {
        commands.add(command.text);
      } else if (isDirectInvoke && command && ts.isIdentifier(command) && wrapperNames.size > 0) {
        // Forwarding parameter inside a recognized thin wrapper; callers are checked via `isWrapperInvoke`.
      } else {
        dynamic.push(relative(root, path));
      }
    });
  }
  // Collect commands exported inside src/services/rpc.ts itself.
  commands.add('get_runtime_capabilities');
  commands.add('browse_server_path');

  const desktopBackend = readFileSync(join(root, 'src-tauri/src/main.rs'), 'utf8');
  const coreRpc = readFileSync(join(root, 'src-tauri/crates/ecpa-core/src/rpc.rs'), 'utf8');
  const registered = new Set([
    ...[...desktopBackend.matchAll(/generate_handler!\[([\s\S]*?)\]/g)]
      .flatMap(match => match[1].match(/\b\w+\b/g) ?? []),
    ...[...coreRpc.matchAll(/"([a-z0-9_]+)"\s*=>/g)].map(match => match[1]),
  ]);
  const mocked = new Set<string>();
  for (const path of files(join(root, 'src/mocks'))) {
    walk(source(path), node => {
      if (ts.isVariableDeclaration(node) && node.name.getText() === 'WEBVIEW_COMMANDS'
        && node.initializer && ts.isNewExpression(node.initializer)) {
        for (const argument of node.initializer.arguments ?? []) walk(argument, value => {
          if (ts.isStringLiteral(value)) mocked.add(value.text);
        });
      }
      if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression)) mocked.add(node.expression.text);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
        && node.left.getText() === 'command' && ts.isStringLiteral(node.right)) mocked.add(node.right.text);
    });
  }
  expect(dynamic).toEqual([]);
  expect([...commands].filter(command => !registered.has(command))).toEqual([]);
  expect([...commands].filter(command => !mocked.has(command))).toEqual([]);
});
