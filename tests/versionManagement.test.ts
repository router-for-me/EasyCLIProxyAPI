import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {
  DEFAULT_VERSION_DOWNLOAD_SOURCE,
  displayAppVersion,
} from '../src/pages/VersionManagementPage';
import { coreUpdateAvailable } from '../src/coreUpdate';
import { appUpdateIndicatorState } from '../src/appUpdateModel';
import { createVersionManagementVisitTracker } from '../src/services/versionManagementVisits';

describe('VersionManagement visit counting', () => {
  it('checks on the fifth, tenth, and fifteenth visits, but not in between', () => {
    const recordVisit = createVersionManagementVisitTracker();
    const checkedVisits: number[] = [];
    for (let visitNumber = 1; visitNumber <= 15; visitNumber += 1) {
      if (recordVisit({})) checkedVisits.push(visitNumber);
    }
    expect(checkedVisits).toEqual([5, 10, 15]);
  });

  it('counts each mounted page once despite repeated effects or re-renders', () => {
    const recordVisit = createVersionManagementVisitTracker();
    for (let visitNumber = 1; visitNumber <= 10; visitNumber += 1) {
      const visit = {};
      expect(recordVisit(visit)).toBe(visitNumber % 5 === 0);
      expect(recordVisit(visit)).toBe(false);
      expect(recordVisit(visit)).toBe(false);
    }
  });

  it('starts counting from zero for a new application session', () => {
    const recordVisit = createVersionManagementVisitTracker();
    for (let visitNumber = 1; visitNumber <= 4; visitNumber += 1) {
      expect(recordVisit({})).toBe(false);
    }
    const recordNewSessionVisit = createVersionManagementVisitTracker();
    expect(recordNewSessionVisit({})).toBe(false);
    expect(recordVisit({})).toBe(true);
  });
});

describe('VersionManagement update triggers', () => {
  const pageSource = ts.createSourceFile(
    'VersionManagementPage.tsx',
    readFileSync(new URL('../src/pages/VersionManagementPage.tsx', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  const findCalls = (name: string) => {
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(pageSource) === name) {
        calls.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(pageSource);
    return calls;
  };

  for (const name of ['checkAppUpdate', 'checkLatest']) {
    it(`calls ${name} only from the visit effect and its manual check button`, () => {
      const calls = findCalls(name);
      expect(calls).toHaveLength(2);
      const triggers = calls.map((call) => {
        let ancestor: ts.Node | undefined = call.parent;
        while (ancestor) {
          if (ts.isJsxAttribute(ancestor)) return ancestor.name.getText(pageSource);
          if (ts.isCallExpression(ancestor)
            && ancestor.expression.getText(pageSource) === 'useEffect') return 'useEffect';
          ancestor = ancestor.parent;
        }
        return undefined;
      });
      expect(triggers.sort()).toEqual(['onClick', 'useEffect']);
    });
  }

  it('only changes the saved download source from the source selector handler', () => {
    const sourceWrites = findCalls('invoke').filter((call) => {
      const command = call.arguments[0];
      return command && ts.isStringLiteral(command) && command.text === 'set_download_source';
    });
    expect(sourceWrites).toHaveLength(1);
    let ancestor: ts.Node | undefined = sourceWrites[0];
    while (ancestor && !(ts.isVariableDeclaration(ancestor)
      && ancestor.initializer && ts.isArrowFunction(ancestor.initializer))) {
      ancestor = ancestor.parent;
    }
    expect(ancestor && ts.isVariableDeclaration(ancestor)
      ? ancestor.name.getText(pageSource)
      : undefined).toBe('updateVersionSource');
  });
});

describe('VersionManagement helper functions', () => {
  it('uses GitHub as the fallback before saved download source settings load', () => {
    expect(DEFAULT_VERSION_DOWNLOAD_SOURCE).toBe('github');
  });

  it('formats app versions with v prefix properly', () => {
    expect(displayAppVersion('1.0.0')).toBe('v1.0.0');
    expect(displayAppVersion('v1.2.3')).toBe('v1.2.3');
    expect(displayAppVersion('  2.3.4  ')).toBe('v2.3.4');
    expect(displayAppVersion('  v3.4.5  ')).toBe('v3.4.5');
  });

  it('resolves update indicators based on availability and processing state', () => {
    expect(appUpdateIndicatorState(true, false, false)).toBe('available');
    expect(appUpdateIndicatorState(false, true, false)).toBe('available');
    expect(appUpdateIndicatorState(true, true, true)).toBe('processing');
    expect(appUpdateIndicatorState(false, false, false)).toBeNull();
  });

  it('compares installed and latest core versions consistently', () => {
    expect(coreUpdateAvailable('v6.6.0', '6.6.0')).toBe(false);
    expect(coreUpdateAvailable('6.5.0', 'v6.6.0')).toBe(true);
    expect(coreUpdateAvailable('v7.2.151', 'v7.2.150')).toBe(false);
    expect(coreUpdateAvailable('6.9.0', '6.10.0')).toBe(true);
    expect(coreUpdateAvailable('6.10.0', '6.9.0')).toBe(false);
    expect(coreUpdateAvailable('6.6.0-rc.2', '6.6.0-rc.10')).toBe(true);
    expect(coreUpdateAvailable('6.6.0-rc.1', '6.6.0')).toBe(true);
    expect(coreUpdateAvailable('6.6.0', '6.6.0-rc.1')).toBe(false);
    expect(coreUpdateAvailable('6.6.0+local', '6.6.0+remote')).toBe(false);
    expect(coreUpdateAvailable(null, '6.6.0')).toBe(false);
    expect(coreUpdateAvailable('6.5.0', '')).toBe(false);
    expect(coreUpdateAvailable('dev', '6.6.0')).toBe(false);
    expect(coreUpdateAvailable('6.5.0', 'unknown')).toBe(false);
  });

  it('does not show an update indicator for an older core release', () => {
    const coreHasUpdate = coreUpdateAvailable('v7.2.151', 'v7.2.150');
    expect(appUpdateIndicatorState(false, coreHasUpdate, false)).toBeNull();
  });

  it('follows the semantic version precedence rules', () => {
    const orderedVersions = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1',
      '1.1.0',
      '2.0.0',
    ];

    for (let index = 1; index < orderedVersions.length; index += 1) {
      const older = orderedVersions[index - 1];
      const newer = orderedVersions[index];
      expect(coreUpdateAvailable(older, newer)).toBe(true);
      expect(coreUpdateAvailable(newer, older)).toBe(false);
      expect(coreUpdateAvailable(newer, newer)).toBe(false);
    }
  });

  it('handles prefixes, whitespace, large identifiers, and invalid versions', () => {
    expect(coreUpdateAvailable('  V7.2.150  ', ' v7.2.151 ')).toBe(true);
    expect(coreUpdateAvailable('999999999999999999.0.0', '1000000000000000000.0.0')).toBe(true);
    expect(coreUpdateAvailable('1.0.0-999999999999999999', '1.0.0-1000000000000000000')).toBe(true);
    expect(coreUpdateAvailable('1.0.0+build.1', '1.0.0+build.2')).toBe(false);
    expect(coreUpdateAvailable('1.0.0', '1.01.0')).toBe(false);
    expect(coreUpdateAvailable('1.0', '1.0.1')).toBe(false);
    expect(coreUpdateAvailable('1.0.0.0', '1.0.1')).toBe(false);
  });
});
