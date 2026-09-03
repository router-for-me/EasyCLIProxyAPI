import { describe, expect, it } from 'bun:test';
import { displayAppVersion } from '../src/pages/VersionManagementPage';
import { coreUpdateAvailable } from '../src/coreUpdate';
import { appUpdateIndicatorState } from '../src/appUpdateModel';

describe('VersionManagement helper functions', () => {
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
    expect(coreUpdateAvailable(null, '6.6.0')).toBe(false);
    expect(coreUpdateAvailable('6.5.0', '')).toBe(false);
  });
});
