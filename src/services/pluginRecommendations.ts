import type { AppLocale } from '../i18n';
import { createTraditionalMessages } from '../i18n/traditional';
import { isDefaultPluginStoreSource } from './pluginResources';
import type { PluginStoreEntry } from './plugins';

type Pick = {
  id: string;
  // Empty means useful regardless of which accounts are connected.
  providers: string[];
  summary: [zh: string, en: string, ja: string];
};

// Hand-picked, plain-language summaries for store plugins that match common
// account setups. Order is display order; entries missing from the store are skipped.
const picks: Pick[] = [
  { id: 'quota-router', providers: ['claude'], summary: ['在 Claude 账号达到 7 天限额前自动切走请求，避免被锁定。', 'Moves Claude requests off an account before it hits its 7-day limit, so you don\'t get locked out.', 'Claude アカウントが 7 日間の上限に達する前にリクエストを移し、ロックアウトを防ぎます。'] },
  { id: 'quota-reset-router', providers: ['claude', 'codex'], summary: ['优先使用每周额度最快重置的账号。', 'Uses the account whose weekly quota resets soonest first.', '週間クォータが最も早くリセットされるアカウントを優先して使います。'] },
  { id: 'claude-seat-pacer', providers: ['claude'], summary: ['在多个 Claude 账号间分摊用量，避免某个账号在周初就用完。', 'Spreads use across your Claude accounts so none runs out early in the week.', '複数の Claude アカウントに使用量を分散し、週の途中で使い切るのを防ぎます。'] },
  { id: 'quota-pacer', providers: ['claude', 'codex', 'xai', 'antigravity'], summary: ['根据各账号剩余额度自动调整使用顺序。', 'Reorders accounts automatically based on how much quota each has left.', '残りクォータに応じてアカウントの使用順を自動で並べ替えます。'] },
  { id: 'model-fallback-router', providers: [], summary: ['某个模型失败或达到限额时，自动改用备用模型重试。', 'Retries on a backup model when one fails or hits a limit.', 'モデルが失敗または上限に達したとき、予備のモデルで再試行します。'] },
  { id: 'privacyfilter', providers: [], summary: ['在请求离开电脑前移除邮箱、电话号码、密钥和令牌。', 'Removes emails, phone numbers, keys and tokens from requests before they leave your computer.', 'リクエストがコンピューターを離れる前に、メール・電話番号・キー・トークンを除去します。'] },
  { id: 'grok-inspection', providers: ['xai'], summary: ['在后台检查 Grok 账号，并提示登录或额度问题。', 'Checks your Grok accounts in the background and flags login or quota problems.', 'Grok アカウントをバックグラウンドで確認し、ログインやクォータの問題を知らせます。'] },
];

export type PluginRecommendation = { entry: PluginStoreEntry; summary: string };

const localized = (summary: Pick['summary'], locale: AppLocale) => {
  const text = summary[locale === 'en' ? 1 : locale === 'ja' ? 2 : 0];
  return locale === 'zh-TW' ? createTraditionalMessages({ text }).text : text;
};

export function recommendPlugins(entries: PluginStoreEntry[], connectedProviders: string[], locale: AppLocale): PluginRecommendation[] {
  const connected = new Set(connectedProviders.map(provider => provider.toLowerCase()));
  return picks.flatMap(pick => {
    if (pick.providers.length && !pick.providers.some(provider => connected.has(provider))) return [];
    // Only the official store listing counts; an extra source could reuse the same id.
    const entry = entries.find(candidate => candidate.id === pick.id && isDefaultPluginStoreSource(candidate));
    return entry ? [{ entry, summary: localized(pick.summary, locale) }] : [];
  });
}
