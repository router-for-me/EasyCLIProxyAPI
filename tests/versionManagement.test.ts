import { describe, expect, it } from 'bun:test';
import { translate } from '../src/i18n';
import { createBrowserMockRuntime } from '../src/mocks/browserMockRuntime';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {
  APP_PREVIEW_RELEASES_URL,
  APP_RELEASE_TAG_BASE_URL,
  APP_RELEASE_URL,
  DEFAULT_VERSION_DOWNLOAD_SOURCE,
  displayAppVersion,
  getAppReleaseUrl,
  resolveAppDownloadUrl,
  selectAppVersionComparison,
} from '../src/pages/VersionManagementPage';
import type { AppUpdateInfo } from '../src/services/appUpdates';
import { coreUpdateAvailable } from '../src/coreUpdate';
import { appUpdateIndicatorState } from '../src/appUpdateModel';
import { createVersionManagementVisitTracker } from '../src/services/versionManagementVisits';

describe('VersionManagement visit checks', () => {
  it('checks on every new page visit', () => {
    const recordVisit = createVersionManagementVisitTracker();
    const checkedVisits: number[] = [];
    for (let visitNumber = 1; visitNumber <= 15; visitNumber += 1) {
      if (recordVisit({})) checkedVisits.push(visitNumber);
    }
    expect(checkedVisits).toEqual(Array.from({ length: 15 }, (_, index) => index + 1));
  });

  it('checks each mounted page once despite repeated effects or re-renders', () => {
    const recordVisit = createVersionManagementVisitTracker();
    for (let visitNumber = 1; visitNumber <= 10; visitNumber += 1) {
      const visit = {};
      expect(recordVisit(visit)).toBe(true);
      expect(recordVisit(visit)).toBe(false);
      expect(recordVisit(visit)).toBe(false);
    }
  });

  it('starts with no recorded visits for a new application session', () => {
    const recordVisit = createVersionManagementVisitTracker();
    const visit = {};
    expect(recordVisit(visit)).toBe(true);
    expect(recordVisit(visit)).toBe(false);
    const recordNewSessionVisit = createVersionManagementVisitTracker();
    expect(recordNewSessionVisit(visit)).toBe(true);
    expect(recordNewSessionVisit(visit)).toBe(false);
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
    it(`calls ${name} only from its effect and its manual check button`, () => {
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
    const sourceWrites = findCalls('setDownloadSource');
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

  it('does not subscribe to automatic source switching', () => {
    expect(findCalls('onVersionDownloadSourceChanged')).toHaveLength(0);
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

  it('prefers direct package download URL over release page and channel fallback', () => {
    expect(resolveAppDownloadUrl({
      downloadUrl: 'https://github.com/router-for-me/EasyCLIProxyAPI/releases/download/v0.3.0/EasyCLIProxyAPI-v0.3.0-Windows-amd64.zip',
      releaseUrl: 'https://github.com/router-for-me/EasyCLIProxyAPI/releases/tag/v0.3.0',
      updateChannel: 'stable',
    }, 'stable')).toBe('https://github.com/router-for-me/EasyCLIProxyAPI/releases/download/v0.3.0/EasyCLIProxyAPI-v0.3.0-Windows-amd64.zip');

    expect(resolveAppDownloadUrl({
      downloadUrl: null,
      releaseUrl: 'https://github.com/router-for-me/EasyCLIProxyAPI/releases/tag/preview-20261104-1623',
      updateChannel: 'preview',
    }, 'preview')).toBe('https://github.com/router-for-me/EasyCLIProxyAPI/releases/tag/preview-20261104-1623');

    expect(resolveAppDownloadUrl(null, 'stable')).toBe(APP_RELEASE_URL);
    expect(resolveAppDownloadUrl(null, 'preview')).toBe(APP_PREVIEW_RELEASES_URL);
    expect(resolveAppDownloadUrl(null, 'preview-20261104-1623')).toBe(`${APP_RELEASE_TAG_BASE_URL}/preview-20261104-1623`);
    expect(getAppReleaseUrl('stable')).toBe(APP_RELEASE_URL);
    expect(getAppReleaseUrl('preview')).toBe(APP_PREVIEW_RELEASES_URL);
    expect(getAppReleaseUrl('preview-20261104-1623')).toBe(`${APP_RELEASE_TAG_BASE_URL}/preview-20261104-1623`);
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


describe('VersionManagement app version series', () => {
  it('switches stable → preview → stable without reusing another series or pinned result', () => {
    const baselines = { stable: '1.2.10', preview: '20261103-1929', installedSeries: 'stable' as const };
    const stable = { updateChannel: 'stable', currentVersion: baselines.stable, latestVersion: '1.2.11' } as AppUpdateInfo;
    const preview = { updateChannel: 'preview', currentVersion: baselines.preview, latestVersion: '0.3.6-preview.20261104-1120' } as AppUpdateInfo;
    expect(selectAppVersionComparison('stable', baselines, stable)).toEqual({ preview: false, installed: true, current: baselines.stable, comparison: stable });
    expect(selectAppVersionComparison('preview', baselines, stable)).toEqual({ preview: true, installed: false, current: baselines.preview, comparison: null });
    expect(selectAppVersionComparison('preview', baselines, preview)).toEqual({ preview: true, installed: false, current: baselines.preview, comparison: preview });
    expect(selectAppVersionComparison('preview-20261103-1929', baselines, preview)).toEqual({ preview: true, installed: false, current: baselines.preview, comparison: null });
    expect(selectAppVersionComparison('stable', baselines, preview)).toEqual({ preview: false, installed: true, current: baselines.stable, comparison: null });
    expect(selectAppVersionComparison('stable', baselines, stable)).toEqual({ preview: false, installed: true, current: baselines.stable, comparison: stable });
  });

  it('keeps unknown local baselines absent even when the latest version is known', () => {
    const stable = { updateChannel: 'stable', currentVersion: null, latestVersion: '1.2.11' } as AppUpdateInfo;
    expect(selectAppVersionComparison('stable', { stable: null, preview: '20261103-1929', installedSeries: 'preview' }, stable).current).toBeNull();
    expect(selectAppVersionComparison('stable', { stable: '1.2.9', preview: null, installedSeries: null }, stable).current).toBeNull();
  });
});


describe('VersionManagement logo display', () => {
  it('uses the same two version labels and has no in-card mode, channel or preview picker', () => {
    const source = readFileSync(new URL('../src/pages/VersionManagementPage.tsx', import.meta.url), 'utf8');
    const card = source.slice(source.indexOf('app-module-card surface-panel'), source.indexOf('core-module-card surface-panel'));
    expect(card.match(/className="version-metric-label"/g)).toHaveLength(2);
    expect(card).toContain("t('appUpdate.current')");
    expect(card).toContain("t('appUpdate.latest')");
    expect(card).not.toMatch(/SelectMenu|ModeControl|PreviewVersionPicker|channelHint|Switch channel|version-metric-sub|localReference/);
    expect(translate('zh-CN', 'appUpdate.current')).toBe('当前版本');
    expect(translate('zh-CN', 'appUpdate.latest')).toBe('最新版本');
    const shell = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(shell).toMatch(/<button type="button" className="brand-logo-button" aria-label=\{logoLabel\}[\s\S]*?setAppVersionDisplay[\s\S]*?<img src=\{appLogo\}/);
    expect(shell).toContain('<VersionManagementPage displaySeries={appVersionDisplay}');
    expect(shell).not.toMatch(/setUpdateChannel|handleLogoTap/);
  });

  it('reads Stable → Preview → Stable without mutating any saved channel or the manual update task', async () => {
    const runtime = createBrowserMockRuntime('stopped');
    await runtime.invoke('set_update_channel', { channel: 'preview-20261104-1623' });
    const before = await runtime.invoke('get_app_update_task');
    const saved = await runtime.invoke('get_update_channel');
    const baselines = await runtime.invoke('get_app_version_baselines') as Parameters<typeof selectAppVersionComparison>[1];
    let previous = null;
    for (const series of ['stable', 'preview', 'stable'] as const) {
      expect(selectAppVersionComparison(series, baselines, previous).comparison).toBeNull();
      const result = await runtime.invoke('check_app_version_display', { series }) as AppUpdateInfo;
      expect(result.updateChannel).toBe(series);
      expect(result.currentVersion).toBe(baselines![series]);
      expect(selectAppVersionComparison(series, baselines, result).comparison).toBe(result);
      expect(resolveAppDownloadUrl(result, series)).toContain(series === 'preview' ? '/preview-' : '/v0.3.0/');
      expect(await runtime.invoke('get_update_channel')).toBe(saved);
      expect(await runtime.invoke('get_app_update_task')).toEqual(before);
      previous = result;
    }
    await expect(runtime.invoke('check_app_version_display', { series: 'preview-20261104-1623' })).rejects.toThrow();
  });
});
