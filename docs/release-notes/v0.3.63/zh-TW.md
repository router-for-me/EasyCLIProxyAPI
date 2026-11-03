- 關於軟體，如果您有任何問題或建議，請透過 [QQ群組](https://qm.qq.com/q/3queDaIG) 或 [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) 回饋，我們會盡快處理。

## 新增

- 本機智慧代理用量統計與多來源工作階段掃描：新增本機智慧代理用量統計頁面（`AgentUsageView`），支援自動掃描並解析 Claude Code、Codex、Gemini CLI、Antigravity、OpenCode、Kimi Code、Pi、OMP、MCode、Copilot、ZCode 等主流程式設計智慧代理的本機工作階段記錄（內建目錄深度限制與大型檔案保護）；支援依時間範圍（當天、近 24 小時、近 7 天、近 30 天、全部）和來源篩選，提供 Token 總量、預估總成本、輸入/輸出 Token、快取命中/寫入概覽卡片，以及每日明細與模型成本統計（[#538](https://github.com/router-for-me/EasyCLIProxyAPI/pull/538)）。
- 路由編排與即時路由監控：新增路由編排頁面與即時路由視覺化監控面板，支援設定路由策略、工作階段親和性、失敗重試、冷卻時間以及多層級（Tier）金鑰與憑據權重編排，並即時顯示請求分發流向與冷卻倒數計時。
- WSL 智慧代理設定目錄支援：在「智慧代理 → 管理」頁面支援為各智慧代理自訂設定目錄路徑（支援本機路徑及 Windows 下的 WSL UNC 路徑，如 `\\wsl$\Ubuntu\home\...` 或 `\\wsl.localhost\...`），底層完整支援 WSL UNC 路徑的原子寫入、範本預覽與備份還原（[#523](https://github.com/router-for-me/EasyCLIProxyAPI/issues/523)）。
- Muse (Meta) 額度查詢支援：在額度查詢頁面新增 Muse (Meta) 供應商支援，支援自動辨識憑據並查詢視窗期額度、每週額度、重設時間及方案資訊（[#496](https://github.com/router-for-me/EasyCLIProxyAPI/issues/496)）。
- 核心指定版本選擇與安裝：版本管理頁面支援取得並選擇指定的 CPA 核心歷史版本（含預發行版本標記）進行安裝，並強化從多個下載來源取得版本清單時的自動回退機制（[#528](https://github.com/router-for-me/EasyCLIProxyAPI/issues/528), [#539](https://github.com/router-for-me/EasyCLIProxyAPI/pull/539)）。
- ZCode 模型能力自動校準與目錄重構：支援根據本機呼叫記錄自動校準 ZCode 模型能力（自動過濾不支援的推理等級），預設提供完整思考等級清單，將模型目錄對話框重構為統一的 Codex 風格雙欄編輯器，並強化 Codex CLI 路徑偵測（[#547](https://github.com/router-for-me/EasyCLIProxyAPI/pull/547)）。

## 修復

- 憑據標籤持久化與批次標記優化：修復重新整理憑據清單後自訂標籤遺失的問題，新增本機持久化標籤合併層；優化帳號卡片標籤顯示與點擊篩選互動，並在批次管理對話框中支援批次新增/移除標籤及按標籤整組選取（[#546](https://github.com/router-for-me/EasyCLIProxyAPI/issues/546)）。
- 更新或重新啟動後自動啟動核心與連接埠偵測重試：修復更新核心或應用程式自動升級重新啟動後未自動啟動核心，導致上游請求出現 502 的問題；在啟動與程序接管階段新增存活檢查與管理連接埠短暫占用重試機制，並優化更新確認對話框提示文案。
