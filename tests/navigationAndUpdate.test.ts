import { describe, expect, test } from 'bun:test';
import { appUpdateIndicatorState } from '../src/appUpdateModel';
import { canOpenAppPage, isAlwaysAvailablePage } from '../src/navigation';
import { oauthSubpages } from '../src/oauthNavigation';

describe('简易模式、首页、配置与版本管理导航', () => {
  test('内核停止时简易模式、首页、配置和版本管理始终可进入', () => {
    expect(isAlwaysAvailablePage('easy')).toBe(true);
    expect(isAlwaysAvailablePage('home')).toBe(true);
    expect(isAlwaysAvailablePage('versions')).toBe(true);
    expect(isAlwaysAvailablePage('config')).toBe(true);
    expect(isAlwaysAvailablePage('usage-records')).toBe(true);
    expect(canOpenAppPage('easy', false)).toBe(true);
    expect(canOpenAppPage('home', false)).toBe(true);
    expect(canOpenAppPage('versions', false)).toBe(true);
    expect(canOpenAppPage('config', false)).toBe(true);
    expect(canOpenAppPage('usage-records', false)).toBe(true);
    expect(canOpenAppPage('quota', false)).toBe(false);
  });

  test('内核运行后解锁其他功能页', () => {
    expect(canOpenAppPage('config', true)).toBe(true);
    expect(canOpenAppPage('agents', true)).toBe(true);
  });
});

describe('OAuth 子页面导航', () => {
  test('认证文件和额度查询收纳在 OAuth 页面内', () => {
    expect(oauthSubpages.map((page) => page.id)).toEqual(['login', 'authFiles', 'quota']);
    expect(oauthSubpages.map((page) => page.labelKey)).toEqual([
      'oauth.title',
      'authFiles.title',
      'quota.title',
    ]);
  });
});

describe('软件与内核更新导航提示点', () => {
  test('任一组件有新版都显示橙点，处理中的蓝点优先', () => {
    expect(appUpdateIndicatorState(true, false, false)).toBe('available');
    expect(appUpdateIndicatorState(false, true, false)).toBe('available');
    expect(appUpdateIndicatorState(true, true, false)).toBe('available');
    expect(appUpdateIndicatorState(true, false, true)).toBe('processing');
    expect(appUpdateIndicatorState(false, true, true)).toBe('processing');
  });

  test('最新版或检查失败都不显示提示点', () => {
    expect(appUpdateIndicatorState(false, false, false)).toBeNull();
  });
});
