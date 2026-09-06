import { describe, expect, it } from 'bun:test';
import { antigravityProjectFor, codexMetadataFor, isPaidXaiFile } from '../src/services/quotaMetadata';
import { providerForFile } from '../src/services/quotaService';

const jwt = (payload: unknown) => `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;

describe('quota credential metadata', () => {
  it('识别 xAI 别名，保留原有供应商别名', () => {
    for (const provider of ['x_ai', 'x-ai', 'grok', 'xai', 'XAI']) {
      expect(providerForFile({ provider })).toBe('xai');
    }
    expect(providerForFile({ type: 'anthropic' })).toBe('claude');
    expect(providerForFile({ type: 'anti_gravity' })).toBe('antigravity');
  });

  it('Codex 支持各层的 JWT、JSON 和对象令牌以及命名空间字段', () => {
    const info = {
      chatgpt_account_id: 'account-中文', chatgpt_plan_type: 'PRO',
      chatgpt_subscription_active_until: '2030-01-01T00:00:00Z',
    };
    for (const token of [info, JSON.stringify(info), jwt({ 'https://api.openai.com/auth': info })]) {
      for (const file of [{ id_token: token }, { metadata: { idToken: token } }, { attributes: { id_token: token } }]) {
        expect(codexMetadataFor(file)).toEqual({
          accountId: 'account-中文', plan: 'pro', subscriptionActiveUntil: '2030-01-01T00:00:00Z',
        });
      }
    }
  });

  it('保留 Codex 直接 account_id 和订阅对象，安全忽略坏令牌', () => {
    expect(codexMetadataFor({ id_token: 'bad.jwt', account_id: 'direct', metadata: { subscription: { active_until: 1900000000 } } }))
      .toEqual({ accountId: 'direct', plan: undefined, subscriptionActiveUntil: '1900000000' });
    expect(codexMetadataFor({ id_token: [], subscription_active_until: 0 }).subscriptionActiveUntil).toBeUndefined();
  });

  it('Antigravity 支持 metadata、attributes 和下载文件的项目字段', () => {
    for (const file of [
      { project_id: 'p' }, { metadata: { projectId: 'p' } },
      { attributes: { gemini_virtual_project: 'p' } },
      { installed: { project_id: 'p' } }, { web: { projectId: 'p' } },
    ]) expect(antigravityProjectFor(file)).toBe('p');
    expect(antigravityProjectFor({})).toBe('');
  });

  it('单独 using_api 或 paid 前缀不能证明 xAI 是付费账户', () => {
    expect(isPaidXaiFile({ using_api: true })).toBe(false);
    expect(isPaidXaiFile({ prefix: 'paid' })).toBe(false);
    expect(isPaidXaiFile({ usingApi: 'YES', metadata: { prefix: 'PAID' } })).toBe(true);
    expect(isPaidXaiFile({ metadata: { oauth: { access_token: jwt({ 'https://x.ai/tier': 1 }) } } })).toBe(true);
    expect(isPaidXaiFile({ token: jwt({ tier: 0 }) })).toBe(false);
    expect(isPaidXaiFile({ token: 'bad.jwt' })).toBe(false);
  });
});
