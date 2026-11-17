- 關於軟體，如果您有任何問題或建議，請透過 [QQ群](https://qm.qq.com/q/3queDaIG) 或 [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) 回饋，我們會盡快處理。

## 新增

- **內建 Codex 模型目錄新增 `gpt-oss-120b-medium`**：此模型已加入隨應用程式發佈的模型目錄（revision 9），在 Codex 模型選擇器中直接可見，無需額外下載。

## 改進

- **ACP 模型改為直接發佈原始模型名**：先前 ACP 服務在已改名的模型上再加一層別名，而 Claude Desktop 的別名表無法表達「改名的改名」。現在直接以 `acp/` 前綴的模型名發佈，不再寫入別名欄位。
- **Claude Desktop 不再將託管設定標記為需要留意**：不再向託管模型項目寫入 `behavesAs`，因為無法辨識此欄位的 Desktop 版本會把整個設定判定為異常。改為直接發佈 Desktop 已認識的系列路由（`claude-opus-5`、`claude-sonnet-5`、`claude-haiku-4-5`），上游模型名保留在 `labelOverride` 中。舊版本寫入的欄位也不會再被還原。
- **ACP API 串流輸出修正**：Chat Completions 與 Responses 用戶端現在能收到完整的 OpenAI 相容串流——首個 assistant 角色增量、文字或帶索引的工具呼叫、唯一的結束原因與 `[DONE]`，各分片共用同一個 completion ID、模型名與建立時間。輸出佇列在壅塞時施加背壓同時保持可取消，不再掉幀；CLI 未提供 token 計數時不會編造用量。

## 修復

- **Antigravity 用量被重複計算且存在遺失**：用量掃描先前會把同一個工作階段的每份鏡像（`transcript.jsonl`、`transcript_full.jsonl`、`chunks/**`、IDE 與備份副本）都統計一遍，總量達到真實用量的數倍，同時部分請求的模型顯示為「unknown model」。現在每個工作階段只從一份標準 transcript 計入一次，模型依請求步驟從工作階段資料庫讀取並以設定標籤作為回退，完全相同的樣本會被去重，而重試與壓縮檢查點仍然保留。升級後首次同步會重建一次 Antigravity 資料，總量回落到真實值。
- **檔案讀不出來時 Antigravity 用量會消失**：先前只要工作階段裡有任意一個檔案讀取成功，其餘檔案的快取列就會被刪除，即使它們讀不出來。現在讀取失敗一律保留快取列；對照的 transcript 依實際覆蓋的請求比較而不是依檔名判斷；舊鍵會被遷移，不再與新鍵並存重複計數。
- **ACP API 寫入失敗時遺失了根因**：儲存 Claude Desktop 別名對應會以 `invalid_config` 失敗，原因是 ACP 服務把 `proxy-url` 寫在 provider 層，而核心不接受 `openai-compatibility` 項目的這種寫法。現在寫入 key 項目內部，已存在的 provider 層取值會被歸一到 key 項目，並在寫入失敗的提示中附上核心的原始錯誤。
- **ACP API 可能在補全中途失敗卻顯示成功**：首個分片之後的上游故障先前會被當作截斷的成功結果。現在輸出前的故障傳回 HTTP 錯誤，輸出後的故障發出終止性 SSE 錯誤且不帶成功結束原因與 `[DONE]`，失敗的回合不會再看起來像已完成。
