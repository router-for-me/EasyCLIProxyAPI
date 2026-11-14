# 敏感词云端规则

编辑 `src-tauri/resources/sensitive-words/rules.json`，推送到 GitHub `main` 分支后，
客户端点击“添加云端最新规则”即可导入，最后点击保存生效。

文件按供应商分组，不用填写版本号、规则编号或处理类型。

```json
{
  "antigravity": {
    "wordReplacements": {
      "You are Codex": "You are an assistant",
      "private phrase": ""
    },
    "wordsToObfuscate": [
      "Claude",
      "Anthropic"
    ]
  },
  "devin": {
    "wordReplacements": {
      "Claude Code": "Assistant"
    },
    "systemPromptLineFilters": [
      "Claude Agent SDK",
      "You are a Claude agent"
    ]
  }
}
```

| 字段 | 填写方式 | 实际作用 |
| --- | --- | --- |
| `antigravity` | Antigravity 的规则 | 只作用于该供应商的系统提示词 |
| `devin` | Devin 的规则 | 只作用于该供应商的系统提示词 |
| `wordReplacements` | `"原文": "替换内容"` | 两个供应商都支持；空字符串表示删除匹配文本 |
| `wordsToObfuscate` | `["词句一", "词句二"]` | 仅 Antigravity：在匹配词中插入零宽字符进行混淆 |
| `systemPromptLineFilters` | `["词句一", "词句二"]` | 仅 Devin：过滤掉包含这些词句的整行 |

维护时：

- 添加替换规则，在 `wordReplacements` 中增加一组原文和替换内容。
- 添加混淆词或行过滤词，在对应列表中增加一个字符串。
- 修改或删除时，直接编辑对应项，不用维护任何编号。
- 没有规则的字段可以省略，也可保留 `{}` 或 `[]`。至少提供一个供应商分组。
- 同一供应商内的原文不能重复，不区分大小写，也不能跨字段重复。
- 混淆词、行过滤词至少两个字符；替换原文允许单个字符。
- 替换内容的空格和换行会保留，换行在 JSON 中写作 `\n`。
- 不要在 JSON 中写注释。文件最大 1 MiB，最多 2000 条规则。

客户端只添加缺少的词条，不覆盖当前配置或未保存的修改；反复点击不会重复添加。
导入后的词条和手动添加的一样，可以修改和删除。没有后台自动同步。
下载失败或文件无效时，当前配置保持原样。

下载地址：
`https://raw.githubusercontent.com/router-for-me/EasyCLIProxyAPI/main/src-tauri/resources/sensitive-words/rules.json`
