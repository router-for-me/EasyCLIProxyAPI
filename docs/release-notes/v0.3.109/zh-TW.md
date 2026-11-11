- 關於軟體，如果您有任何問題或建議，請透過 [QQ群](https://qm.qq.com/q/3queDaIG) 或 [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) 回饋，我們會盡快處理。

## 新增

- **ACP 接入（Antigravity）**：OAuth 頁面新增「ACP 接入」分頁，可用 Google 官方授權登入 Antigravity CLI，並儲存多個帳號按需切換，帳號共用同一份 CLI、登入狀態分別保存。連接後可傳送一則測試訊息驗證模型，啟用 API 後帳號下的模型會以 `acp/<模型ID>` 註冊成保留的 OpenAI 相容 provider，用現有的 CPA 位址與金鑰即可呼叫。此分頁也提供 CLI 偵測與安裝入口、目前帳號身分與連線詳情。
- **ACP 的思考等級**：請求中的 `reasoning_effort`、`reasoning.effort` 或 `thinking.effort` 會解析到官方模型對應的等級變體，等級由官方模型 ID 後綴辨識。未宣告等級、等級不存在或取值衝突時會回傳明確錯誤，不會默默忽略。ACP provider 不會自動寫入思考等級宣告，等級仍需依 CPA 的常規方式手動設定。
- **ACP 的多輪對話**：橋接現在接受 `system`、`user`、`assistant` 訊息，歷史會按 `System:` / `User:` / `Assistant:` 合併進單次提示（官方 CLI 每次請求使用獨立工作階段），最後一則必須是使用者訊息。單則使用者訊息保持原樣直傳，不受影響。

## 改進

- **ACP 卡片版面**：接入頁的兩張卡片改為等高排列，未連線時使用圖示加說明的精簡鎖定狀態，移除框內套框的虛線。已連線或 API 已啟用時，卡片標題圖示轉為成功色，滑鼠移入有輕微陰影回饋，窄螢幕下按鈕自動換行。

## 修復

- **健康檢查的探測預算**：探測請求的預算上調，並把「生成額度已用盡」作為獨立原因回報，不再與其他失敗混在一起。
- **Gemini Interactions 的新事件名稱**：健康檢查先前只辨識舊版 `content.delta` / `interaction.complete`，且只從 `interaction.outputs` 取文字，使用 `step.delta` / `interaction.completed` / `steps` 的合法串流會被誤判為缺少首字。現在兩代事件名稱都支援，完成文字從 `steps` 或 `outputs` 讀取，缺少狀態視為成功，失敗與取消狀態明確拒絕。
- **模型別名同步遇到多詞鍵**：別名與代理的 YAML 更新先前經由 `yaml_serde_edit`，其傳遞相依的解析器會在未加引號的多詞鍵處截斷映射，導致一鍵連線時合法修改被判定為相容性檢查失敗。現在所有相關路徑改用 `serde_norway` 解析與 `yaml-edit` 渲染，多詞鍵的別名同步恢復正常。
