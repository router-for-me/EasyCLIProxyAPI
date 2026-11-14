import type { TemplateText } from '../services/templateConfig';
const text = (zh: string, en: string, ja: string): TemplateText => ({ zh, en, ja });
export const sensitiveWordsMessages = {
  title: text('敏感词设置', 'Sensitive word settings', '機密語の設定'),
  replace: text('敏感词替换', 'Sensitive word replacements', '機密語の置換'),
  systemWords: text('系统提示词敏感词', 'System prompt sensitive words', 'システムプロンプトの機密語'),
  obfuscate: text('敏感词混淆', 'Sensitive word obfuscation', '機密語の難読化'),
  replacementHelp: text(
    '仅在系统提示词中，将原文改为指定内容；替换内容留空则移除匹配文本。',
    'Replaces matching text in system prompts with the specified content. An empty replacement removes the matched text.',
    'システムプロンプト内の一致するテキストを指定した内容に置換します。置換内容が空の場合は一致したテキストを削除します。',
  ),
  systemWordsHelp: text(
    '仅处理 Devin 系统提示词：包含这些词的整行会被移除，其余内容继续混淆。',
    'In Devin system prompts, lines containing these words are removed; the remaining content is obfuscated.',
    'Devin のシステムプロンプトのみを対象に、指定語句を含む行を削除し、残りの内容を難読化します。',
  ),
  obfuscationHelp: text(
    '在 Antigravity 系统提示词的匹配词中插入零宽字符，不区分大小写。',
    'Inserts zero-width characters into matching words in Antigravity system prompts. Matching is case-insensitive.',
    'Antigravity のシステムプロンプト内の一致する語句にゼロ幅文字を挿入します。大文字・小文字は区別しません。',
  ),
  emptyDeletes: text('留空则删除', 'Leave empty to delete', '空欄で削除'),
  removed: text('已删除', 'Deleted', '削除しました'),
  undo: text('撤销', 'Undo', '元に戻す'),
  mergeDuplicates: text('合并重复项', 'Merge duplicates', '重複をまとめる'),
  duplicateWord: text('重复词条', 'Duplicate entry', '重複する語句'),
  caseInsensitive: text('不区分大小写', 'Case-insensitive', '大文字・小文字を区別しません'),
  differentReplacements: text(
    '替换内容不同，请修改或删除多余项',
    'Replacements differ; edit or remove extra entries',
    '置換内容が異なります。余分な項目を編集または削除してください',
  ),
  merged: text(
    '已合并重复项，保存后生效',
    'Duplicates merged; save to apply',
    '重複をまとめました。保存後に適用されます',
  ),
  addLatest: text('添加云端最新规则', 'Add latest cloud rules', '最新クラウドルールを追加'),
  syncing: text('正在获取…', 'Fetching…', '取得中…'),
  addedLatest: text('已添加，保存后生效：', 'Added; save to apply:', '追加しました。保存後に適用：'),
  nothingToAdd: text(
    '没有新规则，已有词条保持不变。',
    'No new rules. Existing entries are unchanged.',
    '新しいルールはありません。既存の項目は保持されます。',
  ),
  invalidTarget: text(
    '原文不能为空，混淆词至少需要两个字符。',
    'Original text is required; obfuscation needs at least two characters.',
    '原文は必須です。難読化には2文字以上が必要です。',
  ),
  invalidDuplicate: text(
    '同一供应商、同一处理方式的原文不能重复。',
    'Targets must be unique per provider and action.',
    '同じプロバイダーと処理方法の原文は重複できません。',
  ),
} satisfies Record<string, TemplateText>;
