import { getCurrentLocale, type AppLocale } from './index';
import { createTraditionalMessages } from './traditional';

const messages = {
  title: ['插件登录', 'Plugin sign-in', 'プラグインのログイン'],
  providerTitle: ['{name} OAuth', '{name} OAuth', '{name} OAuth'],
  providerHint: ['通过插件登录并保存账号凭据。', 'Sign in through this plugin and save account credentials.', 'プラグインでログインし、アカウントの認証情報を保存します。'],
  loadFailed: ['无法加载插件登录入口，请刷新重试。', 'Could not load plugin sign-in options. Refresh to retry.', 'プラグインのログイン項目を読み込めませんでした。更新して再試行してください。'],
  starting: ['正在获取登录链接…', 'Requesting a sign-in link…', 'ログインリンクを取得中…'],
  waiting: ['等待完成授权…', 'Waiting for authorization…', '認証の完了を待っています…'],
  success: ['授权完成，凭据已保存。', 'Authorization completed and credentials saved.', '認証が完了し、認証情報が保存されました。'],
  failed: ['授权失败，请重试。', 'Authorization failed. Please retry.', '認証に失敗しました。再試行してください。'],
  expired: ['登录已过期，请重新获取链接。', 'Sign-in expired. Request a new link.', 'ログインの有効期限が切れました。新しいリンクを取得してください。'],
  unavailable: ['此插件当前无法登录，请确认插件已启用。', 'Sign-in is unavailable. Check that the plugin is enabled.', '現在ログインできません。プラグインが有効か確認してください。'],
  missingState: ['内核未返回登录会话，无法检查授权状态。', 'The kernel returned no sign-in session to check.', 'カーネルからログインセッションが返されなかったため、状態を確認できません。'],
  invalidUrl: ['登录链接无效。', 'Invalid sign-in URL.', 'ログイン URL が無効です。'],
  link: ['登录链接', 'Sign-in URL', 'ログイン URL'],
  open: ['在浏览器中打开', 'Open in browser', 'ブラウザーで開く'],
  copy: ['复制链接', 'Copy link', 'リンクをコピー'],
  copied: ['已复制。', 'Copied.', 'コピーしました。'],
  code: ['设备验证码', 'Device code', 'デバイスコード'],
  copyCode: ['复制验证码', 'Copy code', 'コードをコピー'],
  deviceHint: ['打开登录链接，并输入此验证码完成授权。', 'Open the sign-in URL and enter this code to authorize.', 'ログイン URL を開き、このコードを入力して認証してください。'],
  callback: ['回调地址', 'Callback URL', 'コールバック URL'],
  callbackHint: ['若浏览器完成授权后未自动返回，请粘贴地址栏中的完整回调地址。', 'If authorization does not finish automatically, paste the complete callback URL from your browser.', '認証が自動で完了しない場合、ブラウザーのアドレス欄にある完全なコールバック URL を貼り付けてください。'],
  callbackInvalid: ['请输入包含当前 state 以及 code 或 error 的完整回调地址。', 'Enter a complete callback URL containing the current state and a code or error.', '現在の state と code または error を含む完全なコールバック URL を入力してください。'],
  submit: ['提交回调', 'Submit callback', 'コールバックを送信'],
  submitting: ['正在提交…', 'Submitting…', '送信中…'],
  submitted: ['回调已提交，正在等待授权结果。', 'Callback submitted. Waiting for authorization.', 'コールバックを送信しました。認証結果を待っています。'],
  retry: ['重新登录', 'Retry sign-in', 'ログインを再試行'],
  expires: ['链接有效期至', 'Link expires at', 'リンクの有効期限'],
} as const;

export type PluginOAuthMessage = keyof typeof messages;
export function pluginOAuthText(key: PluginOAuthMessage, locale: AppLocale = getCurrentLocale()): string {
  const value = messages[key][locale === 'en' ? 1 : locale === 'ja' ? 2 : 0];
  return locale === 'zh-TW' ? createTraditionalMessages({ text: value }).text : value;
}
