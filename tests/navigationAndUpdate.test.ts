import { describe, expect, test } from 'bun:test';
import { appUpdateIndicatorState } from '../src/appUpdateModel';
import { canOpenAppPage, isAlwaysAvailablePage } from '../src/navigation';

describe('首页与版本管理导航', () => {
  test('内核停止时仅首页和版本管理始终可进入', () => {
    expect(isAlwaysAvailablePage('home')).toBe(true);
    expect(isAlwaysAvailablePage('versions')).toBe(true);
    expect(canOpenAppPage('home', false)).toBe(true);
    expect(canOpenAppPage('versions', false)).toBe(true);
    expect(canOpenAppPage('config', false)).toBe(false);
    expect(canOpenAppPage('quota', false)).toBe(false);
  });

  test('内核运行后解锁其他功能页', () => {
    expect(canOpenAppPage('config', true)).toBe(true);
    expect(canOpenAppPage('agents', true)).toBe(true);
  });
});

describe('软件更新导航提示点', () => {
  test('有新版显示橙点，处理中的蓝点优先', () => {
    expect(appUpdateIndicatorState(true, false)).toBe('available');
    expect(appUpdateIndicatorState(true, true)).toBe('processing');
    expect(appUpdateIndicatorState(false, true)).toBe('processing');
  });

  test('最新版或检查失败都不显示提示点', () => {
    expect(appUpdateIndicatorState(false, false)).toBeNull();
  });
});
