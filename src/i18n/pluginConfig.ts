import { getCurrentLocale, type AppLocale } from './index';
import { createTraditionalMessages } from './traditional';

const messages = {
  title: ['插件配置', 'Plugin configuration', 'プラグイン設定'],
  enabled: ['启用此插件', 'Enable this plugin', 'このプラグインを有効化'],
  enabledHint: ['还需要开启插件总开关，插件才能运行。', 'The global plugin switch must also be enabled for this plugin to run.', '実行するにはプラグイン全体のスイッチも有効にしてください。'],
  priority: ['优先级', 'Priority', '優先度'],
  priorityHint: ['整数，默认值为 0。', 'An integer; the default is 0.', '整数。既定値は 0 です。'],
  fields: ['插件参数', 'Plugin parameters', 'プラグインのパラメーター'],
  fieldsHint: ['仅保存修改过的参数；清空文本框会移除此项配置并恢复插件默认值。', 'Only edited parameters are saved. Clearing a text field removes its configuration and restores the plugin default.', '変更した項目だけを保存します。入力欄を空にすると設定を削除し、プラグインの既定値に戻します。'],
  inherit: ['未设置 / 默认', 'Unset / default', '未設定 / 既定'],
  raw: ['自定义配置（JSON）', 'Custom configuration (JSON)', 'カスタム設定（JSON）'],
  rawHint: ['此插件未声明配置字段。可在这里编辑 JSON 对象；启用状态和优先级请使用上方控件。删除键会移除此项配置，null 会作为 JSON 值保存。', 'This plugin declares no configuration fields. Edit a JSON object here; use the controls above for enabled and priority. Removing a key deletes its configuration; null is saved as a JSON value.', '設定項目が宣言されていないため、JSON オブジェクトを編集できます。有効状態と優先度は上の欄で設定してください。キーを削除すると設定を削除し、null は JSON 値として保存します。'],
  invalid_priority: ['请输入有效的安全整数。', 'Enter a valid safe integer.', '有効な安全整数を入力してください。'],
  invalid_integer: ['请输入有效的安全整数。', 'Enter a valid safe integer.', '有効な安全整数を入力してください。'],
  invalid_number: ['请输入有限数值。', 'Enter a finite number.', '有限の数値を入力してください。'],
  invalid_enum: ['请选择插件声明的选项。', 'Choose one of the options declared by the plugin.', 'プラグインが宣言した選択肢を選んでください。'],
  invalid_json: ['JSON 格式无效。', 'Invalid JSON.', 'JSON の形式が無効です。'],
  expected_array: ['请输入 JSON 数组。', 'Enter a JSON array.', 'JSON 配列を入力してください。'],
  expected_object: ['请输入 JSON 对象。', 'Enter a JSON object.', 'JSON オブジェクトを入力してください。'],
  reserved: ['请使用上方控件修改 enabled 和 priority。', 'Use the controls above to edit enabled and priority.', 'enabled と priority は上の欄で変更してください。'],
  invalid: ['请修正标注的配置项。', 'Correct the highlighted configuration fields.', '表示された設定項目を修正してください。'],
  unsaved: ['有尚未保存的修改。', 'There are unsaved changes.', '未保存の変更があります。'],
  keepEditing: ['继续编辑', 'Keep editing', '編集を続ける'],
  discard: ['放弃修改', 'Discard changes', '変更を破棄'],
  loadFailed: ['加载插件配置失败', 'Could not load plugin configuration', 'プラグイン設定を読み込めませんでした'],
  saveFailed: ['保存插件配置失败', 'Could not save plugin configuration', 'プラグイン設定を保存できませんでした'],
  retry: ['重试', 'Retry', '再試行'],
} as const;

export type PluginConfigMessage = keyof typeof messages;

export function pluginConfigText(key: PluginConfigMessage, locale: AppLocale = getCurrentLocale()): string {
  const value = messages[key][locale === 'en' ? 1 : locale === 'ja' ? 2 : 0];
  return locale === 'zh-TW' ? createTraditionalMessages({ text: value }).text : value;
}
