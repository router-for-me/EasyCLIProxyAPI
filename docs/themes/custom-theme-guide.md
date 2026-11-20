# 自定义主题：从改颜色开始

自定义主题就是一个 `theme.json` 文件。保存后在应用里重新加载，就能使用新配色，无需重启。

- **第一次制作**：按下面的「快速上手」操作。
- **想细调所有颜色、圆角和阴影**：复制 [完整示例](./custom-theme.example.json)，再按「改哪里」查找字段。
- **需要编辑器补全或完整格式约束**：查看 [JSON Schema](../../theme.schema.json)。本文适用于 `schemaVersion: 1`。

## 快速上手

1. 打开应用的主题选择器，点击 **打开主题目录**。
2. 新建文件夹 `my-dark`，在里面新建 `theme.json`，粘贴下面的内容。
3. 保存为 UTF-8，回到主题选择器点 **重新加载**，选择深色模式下的 **我的深色主题**。若列表有筛选条件，先清空搜索、切换到「全部」或「自定义」。

```text
themes/
└── my-dark/
    └── theme.json
```

```json
{
  "schemaVersion": 1,
  "id": "my-dark",
  "name": "我的深色主题",
  "appearance": "dark",
  "windowBackground": "#0B1220",
  "tokens": {
    "workspaceBackground": "#0B1220",
    "surface": "#141E30",
    "textPrimary": "#E8EEF7",
    "accent": "#2DD4BF",
    "primaryButtonBackground": "#2DD4BF",
    "primaryButtonText": "#04201C"
  }
}
```

先试着把两个 `#2DD4BF` 改成 `#60A5FA`，保存并重新加载，观察强调色和主按钮的变化。

**每次修改都要保存并重新加载。** `name` 是显示名称，`id` 是唯一标识；复制出第二套主题时必须换一个 `id`。文件夹名不必与 `id` 一致，但建议保持一致，便于查找。

> 目录位置：Windows / Linux 在应用可执行文件旁的 `themes/`；macOS 正式 `.app` 在 `~/Library/Application Support/com.cpa.gui/themes/`（开发运行时可能不同）。以应用里的「打开主题目录」为准。不要把 JSON 直接放在 `themes/` 下，也不要多套一层文件夹。

## 想改哪里，就找这些字段

`tokens` 可以理解为“界面各部位的样式”。不必全部填写，省略的项使用当前浅色或深色的默认样式。

| 想改的地方 | `tokens` 中的字段 |
| --- | --- |
| 页面底色 / 卡片底色 | `workspaceBackground` / `surface` |
| 次级区域 / 悬停底色 | `softSurface` / `hoverBackground` |
| 正文 / 次要文字 / 辅助文字 / 弱化文字 | `textPrimary` / `textSecondary` / `textTertiary` / `textMuted` |
| 普通 / 淡 / 强 / 悬停边框 | `border` / `borderSubtle` / `borderStrong` / `borderHover` |
| 强调色 / 强调悬停色 / 淡强调底色 | `accent` / `accentStrong` / `accentSoft` |
| 强调色上的文字 / 焦点框 | `accentContrast` / `focusRing` |
| 主按钮底色 / 悬停底色 / 文字 | `primaryButtonBackground` / `primaryButtonHoverBackground` / `primaryButtonText` |
| 主按钮边框 / 悬停边框 | `primaryButtonBorder` / `primaryButtonHoverBorder` |
| 开关开启底色 / 开启滑块 / 默认滑块 | `controlActiveBackground` / `controlActiveThumb` / `controlThumb` |
| 侧栏底色 / 悬停 / 选中底色 | `sidebarBackground` / `sidebarHover` / `sidebarSelected` |
| 侧栏文字 / 强调文字 / 弱化文字 | `sidebarText` / `sidebarTextStrong` / `sidebarTextMuted` |
| 侧栏边框 / 选中边框 | `sidebarBorder` / `sidebarSelectedBorder` |
| 弹窗底色 / 次级底色 / 悬停底色 | `popoverBackground` / `overlaySoftSurface` / `overlayHoverBackground` |
| 用量仪表的低 / 中 / 高颜色 | `meterLow` / `meterMedium` / `meterHigh` |
| 遮罩 / 面板阴影色 / 强调阴影色 / 侧栏选中阴影色 | `scrim` / `panelShadow` / `accentShadow` / `sidebarSelectedShadow` |

**改主色时要成组改。** `accent` 不会自动替换所有控件的颜色；完整示例已分别配置按钮、开关和侧栏选中态，需要一起调整。

| 其他样式 | 格式与范围 |
| --- | --- |
| `radiusSmall` / `radiusMedium` / `radiusLarge` | 圆角，如 `"8px"`，范围 0–24px |
| `radiusFull` | 胶囊圆角，0–9999px |
| `controlBorderWidth` / `cardBorderWidth` | 控件 / 卡片边框，如 `"1px"`，范围 0–4px |
| `fontFamilySans` / `fontFamilyMono` | 正文 / 代码字体族，逗号分隔，如 `"'Noto Sans SC', system-ui, sans-serif"`；只能使用系统中已安装的字体，不能包含 `url()`、`@font-face` 或文件路径，最长 200 字符。省略时使用应用默认字体 |
| `shadowExtraSmall` / `shadowSmall` / `shadowMedium` / `shadowLarge` / `shadowPopover` / `shadowDialog` / `shadowSpotlight` | 阴影，如 `"0 4px 16px #00000028"`；`"none"` 表示无阴影 |

颜色用 `"#RRGGBB"` 或 `"#RRGGBBAA"`。最后两位 `AA` 是不透明度：`00` 全透明、`80` 约 50%、`FF` 完全不透明。例如 `"#141E3080"` 是半透明深蓝。

尺寸、间距和布局不能通过主题修改。字体只能指定字体族（见下表 `fontFamilySans` / `fontFamilyMono`），不能修改字号、字重或行高。

## 加渐变或背景图

### 渐变背景

在 `theme.json` 顶层增加 `backdrop`，与 `tokens` 同级：

```json
"backdrop": {
  "layers": [
    {
      "kind": "linear",
      "angle": 135,
      "stops": [
        { "color": "#0B1220", "at": 0 },
        { "color": "#0E2A38", "at": 100 }
      ]
    }
  ],
  "sidebar": "#08101CCC",
  "panel": "#16283DCC"
}
```

这是需要合并到现有 JSON 的片段，记得在相邻字段之间加逗号。

- `layers` 是背景渐变；`angle` 是方向，`at` 是色标位置（0–100）。可放 1–4 层，**第一层在最上面**。
- `sidebar` 是侧栏底色，`panel` 是卡片等表面底色。使用半透明颜色，才能透出背后的渐变。
- 可选的 `inset` 控制内嵌区域底色，`hover` 控制悬停底色。
- **有 `backdrop` 时，优先改这里的表面颜色**：`panel` 接管 `tokens.surface`，`inset` 接管 `softSurface` 和工作区内表面（省略时用 `panel`）；`hover` 优先于 `tokens.hoverBackground`。画布的最底色仍取 `tokens.workspaceBackground` 或 `windowBackground`。

完整示例还演示了椭圆光晕：`kind: "radial"`，`center` 为中心位置（两个 0–100 的数），`size` 为两个方向的半径百分比（各 1–200）。每层支持 2–8 个色标，`at` 必须从小到大排列，可相等。

### 图片背景

把图片放入主题文件夹，再在 JSON 顶层加入：

```json
"assets": { "backdropImage": "assets/backdrop.webp" }
```

```text
my-dark/
├── theme.json
└── assets/
    └── backdrop.webp
```

图片支持 PNG、JPEG、WebP、AVIF，最大 **8 MiB**。路径相对于当前主题文件夹，使用 `/`，不能用绝对路径、`..` 或符号链接。

图片会铺满并裁剪。已有 `backdrop` 时，可在其中加 `"imagePosition": [50, 25]` 调整定位：第一个数控制水平位置，第二个数控制垂直位置，均为 0–100，默认居中。

**渐变在图片上方。** 如果复制了完整示例，请先删除 `backdrop` 来查看原图；需要叠加渐变时再加回来，并把渐变色改成半透明，否则不透明渐变会遮住图片。

### 系统透明材质

在顶层设置 `"windowMaterial": "translucent"`，再按需在 `tokens` 中加入：

```json
"windowMaterialWorkspaceOpacity": "78%",
"windowMaterialSidebarOpacity": "64%"
```

数值越低，底层材质越明显；范围为 `"0%"`–`"100%"`。效果取决于系统支持，成功加载背景图后会停用原生透明材质。普通浏览器预览不能展示真实系统材质。

## 完整示例怎么用

[custom-theme.example.json](./custom-theme.example.json) 是一套青绿色暗色渐变主题，包含全部 60 个样式字段，不依赖额外图片。复制后重命名为 `theme.json` 即可使用。

- 改配色：先改页面、文字、主色，再调整按钮和侧栏。
- 改浅色主题：把 `appearance` 改为 `"light"`，同时改为浅底深字；仅改这个字段不会自动转换已写好的深色配色。也可以从快速上手例子开始，删去不需要覆盖的 token。
- 不需要渐变：删除整个 `backdrop`，再通过 `tokens` 调整纯色表面。
- 不需要的样式：直接删除对应 token，让它回到默认值。

## 必须遵守的规则

| 项目 | 要求 |
| --- | --- |
| 必填字段 | `schemaVersion`、`id`、`name`、`appearance`、`windowBackground`、`tokens`；`tokens` 可为 `{}` |
| `schemaVersion` | 写数字 `1`。Schema 要求填写；当前加载器兼容缺省值，制作主题时仍应显式写出 |
| `id` | 小写字母开头，只用小写字母、数字、连字符，最长 64 字符；不能是 `system`，不能与内置或其他主题重复 |
| `name` / 可选的 `description` | 非空文字，最多 80 字符；也可写多语言对象，如 `{"zh-CN":"极光","en":"Aurora"}` |
| `appearance` | `"light"` 或 `"dark"`，决定所属分组和默认样式；自动模式中可分别选择浅色和深色主题 |
| `windowBackground` | 必须是六位颜色，如 `"#0B1220"`，不能带透明度 |
| JSON 格式 | 不允许注释、尾逗号；数值以外的颜色、像素、百分比都要加双引号 |
| 大小与数量 | `theme.json` 最大 64 KiB；最多加载 64 个有 `theme.json` 的主题文件夹，按文件夹名排序取前 64 个 |

顶层只接受 `$schema`、`schemaVersion`、`id`、`name`、`description`、`appearance`、`windowBackground`、`windowMaterial`、`icon`、`assets`、`backdrop`、`tokens`。不要添加 `order`、`nameKey` 等内部字段。

`icon` 目前只校验并保留路径，主题卡片仍使用自动生成的配色缩略图，不会显示这个图标。`assets` 中当前只有 `backdropImage` 用于显示，其余名称作为保留资源。

## 出问题时查这里

| 现象 | 先检查 |
| --- | --- |
| 列表里没有主题 | 文件是否位于 `themes/文件夹/theme.json`；清空筛选并切到对应浅 / 深色组；查看跳过提示 |
| 提示无法读取（`unreadable`） | 文件编码、读取权限，或大小是否超过 64 KiB |
| 提示 JSON 无效（`invalid-json`） | 是否用了注释、尾逗号，或漏了引号 / 逗号 |
| 提示版本不支持（`unsupported-version`） | `schemaVersion` 必须是数字 `1`，不是字符串 `"1"` |
| 提示元数据无效（`invalid-metadata`） | 必填项、字段类型、未知顶层字段，以及 `backdrop` 格式 |
| 提示标识重复（`duplicate-id`） | 给复制的主题换一个 `id`，只改文件夹名没有用 |
| 部分颜色没变 | 查看字段诊断：未知 token 或格式错误会单独忽略；有渐变时检查 `backdrop` 的表面颜色 |
| 背景图没显示 | 路径、文件格式、8 MiB 限制，以及上层是否有不透明渐变；图片读取失败不会导致整个主题消失 |
| 改完没有变化 | 保存文件后点「重新加载」，确认当前选中的就是这套主题；自动模式只显示当前系统外观对应的主题 |

字段诊断中的 `unknown-token` 表示名称不支持，`invalid-token` 表示值格式错误，`invalid-icon` / `invalid-asset` 表示资源路径无效。这些问题只忽略对应字段，不会跳过整个主题。
