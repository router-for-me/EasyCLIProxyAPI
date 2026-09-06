import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { InlineNotice } from '../src/appNotice';
import { I18nProvider, supportedLocales, translate } from '../src/i18n';
import {
  appNoticeReducer,
  initialAppNoticeState,
  type AppNotice,
  type AppNoticeState,
} from '../src/services/appNotice';

const notice: AppNotice = {
  owner: 'api-page',
  source: 'app.nav.api',
  message: '接入已启用',
  tone: 'success',
};

const renderNotice = (state: AppNoticeState) => renderToStaticMarkup(
  <I18nProvider><InlineNotice notice={state.notice} onDismiss={() => {}} /></I18nProvider>,
);

describe('统一操作提示', () => {
  it('关闭操作反馈的文案覆盖所有支持的语言', () => {
    for (const locale of supportedLocales) {
      expect(translate(locale, 'app.notice.dismiss').length).toBeGreaterThan(0);
    }
  });

  it('新结果替换旧结果，不叠加悬浮提示', () => {
    const first = appNoticeReducer(initialAppNoticeState, { type: 'show', notice });
    const next = appNoticeReducer(first, {
      type: 'show',
      notice: { ...notice, message: '接入已停用' },
    });
    expect(next.notice?.message).toBe('接入已停用');
    expect(next.revision).toBe(2);
    expect(first.notice?.message).toBe('接入已启用');
  });

  it('重复的操作结果也产生新的可播报版本', () => {
    const first = appNoticeReducer(initialAppNoticeState, { type: 'show', notice });
    const next = appNoticeReducer(first, { type: 'show', notice });
    expect(next.revision).toBe(first.revision + 1);
    expect(next.notice).toEqual(notice);
  });

  it('错误和成功都保留结果，用户关闭后才清空', () => {
    for (const tone of ['success', 'error', 'info'] as const) {
      const shown = appNoticeReducer(initialAppNoticeState, { type: 'show', notice: { ...notice, tone } });
      expect(shown.notice?.tone).toBe(tone);
      expect(appNoticeReducer(shown, { type: 'dismiss' }).notice).toBeNull();
    }
  });

  it('一个页面清理自己的状态时不会关闭其他页面的结果', () => {
    const shown = appNoticeReducer(initialAppNoticeState, { type: 'show', notice });
    expect(appNoticeReducer(shown, { type: 'dismiss', owner: 'oauth-page' })).toBe(shown);
    expect(appNoticeReducer(shown, { type: 'dismiss', owner: 'api-page' }).notice).toBeNull();
  });

  it('空消息只清除当前来源，不显示空白成功提示', () => {
    const shown = appNoticeReducer(initialAppNoticeState, { type: 'show', notice });
    expect(appNoticeReducer(shown, { type: 'show', notice: { ...notice, message: '  ' } }).notice).toBeNull();
    expect(appNoticeReducer(shown, {
      type: 'show',
      notice: { ...notice, owner: 'another-page', message: '' },
    })).toBe(shown);
  });

  it('无消息时不渲染任何空白栏或占位文字', () => {
    expect(renderNotice(initialAppNoticeState)).toBe('');
    expect(renderNotice({ notice: { ...notice, message: '  ' }, revision: 1 })).toBe('');
  });

  it('操作结果包含来源、完整消息和可访问的关闭按钮', () => {
    const html = renderNotice(appNoticeReducer(initialAppNoticeState, { type: 'show', notice }));
    expect(html).toContain('action-feedback inline-notice success');
    expect(html).toContain('API 接入');
    expect(html).toContain('接入已启用');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).toContain('aria-label="关闭操作提示"');
    expect(html).not.toContain('config-toast');
    expect(html).not.toContain('<footer');
    expect(html).not.toContain('app-notice-bar');
  });

  it('局部操作可省略重复的模块标题', () => {
    const html = renderNotice({ notice: { ...notice, source: undefined }, revision: 1 });
    expect(html).toContain('接入已启用');
    expect(html).not.toContain('action-feedback-source');
  });

  it('长错误保留全文、换行且转义外部内容', () => {
    const message = `失败：${'详细错误'.repeat(160)}\n<script>alert(1)</script>`;
    const html = renderNotice(appNoticeReducer(initialAppNoticeState, {
      type: 'show', notice: { ...notice, message, tone: 'error' },
    }));
    expect(html).toContain('action-feedback inline-notice error');
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain('详细错误'.repeat(160));
    expect(html).toContain('\n&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('保存翻译键和参数，在渲染时才生成操作结果文案', () => {
    const message = { key: 'oauth.loginSuccess', variables: { provider: '<QA>' } } as const;
    const shown = appNoticeReducer(initialAppNoticeState, {
      type: 'show', notice: { ...notice, message },
    });
    expect(shown.notice?.message).toBe(message);
    expect(renderNotice(shown)).toContain('&lt;QA&gt; 登录成功');
    for (const locale of supportedLocales) {
      expect(translate(locale, message.key, message.variables)).toContain('<QA>');
    }
  });
});
