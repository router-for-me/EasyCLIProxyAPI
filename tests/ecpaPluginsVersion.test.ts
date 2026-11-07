import { describe, expect, test } from 'bun:test';
import { isStoreUpdateAvailable } from '../src/services/ecpaStoreVersion';

describe('ecpa store version comparison', () => {
  test('reports a newer registry release as an update', () => {
    expect(isStoreUpdateAvailable('1.1.5', '1.1.6')).toBe(true);
    expect(isStoreUpdateAvailable('1.1.5', '1.2.0')).toBe(true);
  });

  test('treats equal versions as up to date', () => {
    expect(isStoreUpdateAvailable('1.2.0', '1.2.0')).toBe(false);
    expect(isStoreUpdateAvailable('v1.2.0', '1.2.0')).toBe(false);
    expect(isStoreUpdateAvailable('1.2', '1.2.0')).toBe(false);
  });

  test('separates a prerelease from the matching release', () => {
    expect(isStoreUpdateAvailable('1.0.0', '1.0.0-preview.3')).toBe(true);
    expect(isStoreUpdateAvailable('1.0.0-preview.3', '1.0.0')).toBe(true);
  });

  test('ignores unparsable versions', () => {
    expect(isStoreUpdateAvailable('abc', '1.0.0')).toBe(false);
    expect(isStoreUpdateAvailable('1.0.0', 'abc')).toBe(false);
    expect(isStoreUpdateAvailable(undefined, '1.0.0')).toBe(false);
    expect(isStoreUpdateAvailable('1.0.0', undefined)).toBe(false);
  });
});