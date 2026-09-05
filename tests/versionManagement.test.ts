import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_VERSION_DOWNLOAD_SOURCE,
  displayAppVersion,
} from '../src/pages/VersionManagementPage';
import { coreUpdateAvailable } from '../src/coreUpdate';
import { appUpdateIndicatorState } from '../src/appUpdateModel';

describe('VersionManagement helper functions', () => {
  it('defaults every version management session to GitHub', () => {
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
