import { describe, expect, it } from 'bun:test';
import { apiCallErrorMessage } from '../src/services/managementApi';

describe('apiCallErrorMessage', () => {
  it('从对象和 JSON 字符串错误体中提取可读消息', () => {
    expect(apiCallErrorMessage({
      status_code: 401,
      body: { error: { message: 'token expired' } },
    })).toBe('token expired');

    expect(apiCallErrorMessage({
      statusCode: 403,
      bodyText: JSON.stringify({ detail: 'permission denied' }),
    })).toBe('permission denied');
  });

  it('没有错误体时回退到 HTTP 状态', () => {
    expect(apiCallErrorMessage({ status_code: 429 })).toBe('Upstream returned HTTP 429');
  });
});
