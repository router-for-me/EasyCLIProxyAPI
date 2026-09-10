import { describe, expect, test } from 'bun:test';
import { parseLaunchTarget } from '../src/launchNavigation';

const pageIds = ['easy', 'home', 'versions', 'config', 'oauth', 'api', 'usage-records', 'agents'] as const;

describe('--page 启动参数解析', () => {
  test('顶层页面直接解析', () => {
    expect(parseLaunchTarget('home', pageIds)).toEqual({ page: 'home' });
    expect(parseLaunchTarget('usage-records', pageIds)).toEqual({ page: 'usage-records' });
  });

  test('OAuth 子页面可用 oauth/<子页面> 或子页面别名', () => {
    expect(parseLaunchTarget('oauth/quota', pageIds)).toEqual({ page: 'oauth', oauthSubpage: 'quota' });
    expect(parseLaunchTarget('quota', pageIds)).toEqual({ page: 'oauth', oauthSubpage: 'quota' });
    expect(parseLaunchTarget('authFiles', pageIds)).toEqual({ page: 'oauth', oauthSubpage: 'authFiles' });
  });

  test('未知或畸形的值被忽略', () => {
    expect(parseLaunchTarget('', pageIds)).toBeNull();
    expect(parseLaunchTarget('  ', pageIds)).toBeNull();
    expect(parseLaunchTarget('nope', pageIds)).toBeNull();
    expect(parseLaunchTarget('home/quota', pageIds)).toBeNull();
    expect(parseLaunchTarget('oauth/nope', pageIds)).toBeNull();
    expect(parseLaunchTarget('oauth/quota/extra', pageIds)).toBeNull();
    expect(parseLaunchTarget(undefined, pageIds)).toBeNull();
  });
});
