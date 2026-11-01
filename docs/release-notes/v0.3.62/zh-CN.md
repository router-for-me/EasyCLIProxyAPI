- 关于软件，如果您有任何问题或建议，请通过 [QQ群](https://qm.qq.com/q/3queDaIG) 或 [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) 反馈，我们会尽快处理。

## 新增

- 账号自定义标签与批量成组管理：支持为 OAuth / 凭据账号设置自定义标签（`tags`），账号卡片展示标签徽标，并支持在账号列表通过标签筛选；批量管理弹窗支持按标签一键全选整组账号，支持批量启用、停用、刷新与删除（[#546](https://github.com/router-for-me/EasyCLIProxyAPI/issues/546)）。

## 修复

- 二次元主题模型选择下拉错位与页面跳动修复：修复在二次元浅色/图片背景主题下，由于 `backdrop-filter` 产生包含块导致智能体模型选择下拉框（`AgentModelPicker`）偏离至屏幕右下方的问题；增加 `offsetParent` 包含块坐标补偿，并清理二级 Tab 与页面标题上的异常边距（[#543](https://github.com/router-for-me/EasyCLIProxyAPI/pull/543)）。
