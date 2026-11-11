- 關於軟體，如果您有任何問題或建議，請透過 [QQ群](https://qm.qq.com/q/3queDaIG) 或 [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) 回饋，我們會盡快處理。

## 新增

- **ACP 工具呼叫往返**：函式工具現在透過內建的帶驗證 MCP 轉接器交給官方 CLI，Chat Completions 與 Responses 用戶端可以收到 `tool_calls`、執行後把結果送回同一次執行。支援串流回應；等待中的呼叫會保留其 CLI 程序並在十分鐘後過期，已完成的呼叫 ID 不會被重複投遞。使用者無需安裝任何 MCP 服務。

## 改進

- **ACP 用戶端相容性**：空或 null 的 `tools`、無工具時的 `tool_choice` auto，以及明確指定的 `tool_choice: none` 都能正常接受。常見用戶端欄位 `n: 1`、`store: false`、`response_format` 文字、`parallel_tool_calls`、`user`、`metadata`、`prompt_cache_key` 與 `safety_identifier` 會被驗證並接受。`max_tokens`、`max_completion_tokens`、`temperature` 與 `top_p` 作為相容參數接收，CLI 無法套用的非空取值會寫入回應標頭 `x-ecpa-ignored-parameters`，不再直接拒絕請求。
- **ACP 系統指令傳遞**：system 與 developer 指令改為透過 CLI 宣告的系統提示附加能力或官方 Antigravity 擴充單獨傳遞，保留 Agent 自身的預設提示，不再被合併進使用者訊息。CLI 若不具備這兩種能力，在存在指令時會回傳明確的「需要更新」錯誤。
- **ACP API 的啟動與關閉**：API 卡片改為明確的啟動/關閉開關，狀態區分已關閉、啟動中、已啟動等待連線和已啟動。接入已開啟時關閉隨時可用，帳號中斷或模型為空也不影響關閉；啟動需要帳號已連線，並在卡片內直接說明缺少的前提。出錯時在卡片內提示，開關回到可操作狀態。

## 修正

- **ACP API 接入先前無法可靠關閉**：現在預設關閉，登入、重新整理、切換帳號或重啟應用程式都不會再表現為自動開啟。關閉會原子寫入關閉意圖、清理等待中的工具工作階段與監聽器，並從舊版和 v8 兩種設定布局中移除託管的 provider。關閉是幂等的並且失敗即關閉，清理出錯也不會留下殘留接入在下次啟動時重新生效。
