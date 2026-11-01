- 關於軟體，如果您有任何問題或建議，請透過 [QQ群組](https://qm.qq.com/q/3queDaIG) 或 [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) 回饋，我們會盡快處理。

## 新增

- 帳號自訂標籤與批次分組管理：支援為 OAuth / 憑據帳號設定自訂標籤（`tags`），帳號卡片展示標籤徽章，並支援在帳號列表透過標籤篩選；批次管理對話框支援按標籤一鍵全選整組帳號，支援批次啟用、停用、重新整理與刪除（[#546](https://github.com/router-for-me/EasyCLIProxyAPI/issues/546)）。

## 修復

- 二次元主題模型選擇下拉錯位與頁面跳動修復：修復在二次元淺色/圖片背景主題下，由於 `backdrop-filter` 產生包含塊導致智慧代理模型選擇下拉選單（`AgentModelPicker`）偏移至螢幕右下方的問題；增加 `offsetParent` 包含塊座標補償，並清理二級 Tab 與頁面標題上的異常邊距（[#543](https://github.com/router-for-me/EasyCLIProxyAPI/pull/543)）。
