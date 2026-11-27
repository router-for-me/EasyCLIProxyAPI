use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SwitchPlatformId {
    Codex,
    ClaudeCode,
    Antigravity,
    Grok,
    Kimi,
    GithubCopilot,
    WindsurfDevin,
    Workbuddy,
    WorkbuddyAi,
    Zcode,
    ClaudeDesktop,
}

impl SwitchPlatformId {
    pub(crate) const ALL: [SwitchPlatformId; 11] = [
        Self::Codex,
        Self::ClaudeCode,
        Self::Antigravity,
        Self::Grok,
        Self::Kimi,
        Self::GithubCopilot,
        Self::WindsurfDevin,
        Self::Workbuddy,
        Self::WorkbuddyAi,
        Self::Zcode,
        Self::ClaudeDesktop,
    ];

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::ClaudeCode => "claude_code",
            Self::Antigravity => "antigravity",
            Self::Grok => "grok",
            Self::Kimi => "kimi",
            Self::GithubCopilot => "github_copilot",
            Self::WindsurfDevin => "windsurf_devin",
            Self::Workbuddy => "workbuddy",
            Self::WorkbuddyAi => "workbuddy_ai",
            Self::Zcode => "zcode",
            Self::ClaudeDesktop => "claude_desktop",
        }
    }

    pub(crate) fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().replace('-', "_").as_str() {
            "codex" | "openai" => Ok(Self::Codex),
            "claude_code" | "claudecode" | "claude" => Ok(Self::ClaudeCode),
            "antigravity" | "antigravity_cli" | "agy" => Ok(Self::Antigravity),
            "grok" | "xai" | "grok_build" => Ok(Self::Grok),
            "kimi" | "kimi_code" | "kimi_ai" => Ok(Self::Kimi),
            "github_copilot" | "copilot" | "vscode_copilot" | "copilot_cli" => {
                Ok(Self::GithubCopilot)
            }
            "windsurf_devin" | "windsurf" | "devin" => Ok(Self::WindsurfDevin),
            "workbuddy" => Ok(Self::Workbuddy),
            "workbuddy_ai" | "workbuddyai" => Ok(Self::WorkbuddyAi),
            "zcode" | "zai" => Ok(Self::Zcode),
            "claude_desktop" | "claudedesktop" => Ok(Self::ClaudeDesktop),
            other => Err(format!("Unsupported switch platform: {other}")),
        }
    }

    pub(crate) fn category(self) -> PlatformCategory {
        match self {
            Self::Codex
            | Self::ClaudeCode
            | Self::Antigravity
            | Self::Grok
            | Self::Kimi => PlatformCategory::OfficialCli,
            Self::GithubCopilot
            | Self::WindsurfDevin
            | Self::Workbuddy
            | Self::WorkbuddyAi
            | Self::Zcode
            | Self::ClaudeDesktop => PlatformCategory::AiIde,
        }
    }

    pub(crate) fn display_name(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::ClaudeCode => "Claude Code",
            Self::Antigravity => "Antigravity",
            Self::Grok => "Grok / xAI",
            Self::Kimi => "Kimi Code",
            Self::GithubCopilot => "GitHub Copilot",
            Self::WindsurfDevin => "Devin / Windsurf",
            Self::Workbuddy => "WorkBuddy",
            Self::WorkbuddyAi => "WorkBuddy AI",
            Self::Zcode => "ZCode",
            Self::ClaudeDesktop => "Claude Desktop",
        }
    }

    pub(crate) fn supports_oauth(self) -> bool {
        matches!(
            self,
            Self::Codex
                | Self::ClaudeCode
                | Self::Grok
                | Self::GithubCopilot
                | Self::Kimi
        )
    }

    pub(crate) fn supports_cpa_import(self) -> bool {
        matches!(
            self,
            Self::Codex
                | Self::ClaudeCode
                | Self::Antigravity
                | Self::Grok
                | Self::Kimi
                | Self::WindsurfDevin
        )
    }

    pub(crate) fn supports_client_restart(self) -> bool {
        matches!(
            self,
            Self::Codex
                | Self::Antigravity
                | Self::GithubCopilot
                | Self::WindsurfDevin
                | Self::Workbuddy
                | Self::WorkbuddyAi
                | Self::Zcode
                | Self::ClaudeDesktop
        )
    }

    pub(crate) fn supported_sync_targets(self) -> &'static [&'static str] {
        match self {
            Self::Codex => {
                if cfg!(target_os = "windows") {
                    &["opencode", "openclaw", "hermes", "wsl"]
                } else {
                    &["opencode", "openclaw", "hermes"]
                }
            }
            Self::Grok => &["opencode"],
            Self::GithubCopilot => &["opencode"],
            _ => &[],
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum PlatformCategory {
    OfficialCli,
    AiIde,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProxyMode {
    Direct,
    CpaProxy,
    CustomProxy,
    Unknown,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProxyInspection {
    pub(crate) mode: ProxyMode,
    pub(crate) detail: Option<String>,
    pub(crate) can_decouple: bool,
    pub(crate) config_paths: Vec<String>,
}

impl Default for ProxyInspection {
    fn default() -> Self {
        Self {
            mode: ProxyMode::Direct,
            detail: None,
            can_decouple: false,
            config_paths: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncTargetInfo {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) installed: bool,
    pub(crate) target_path: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QuotaMetric {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) remaining_percent: Option<f64>,
    pub(crate) used_percent: Option<f64>,
    pub(crate) reset_at: Option<i64>,
    pub(crate) detail: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QuotaSnapshot {
    pub(crate) fetched_at: i64,
    pub(crate) plan: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) plan_expires_at: Option<i64>,
    pub(crate) metrics: Vec<QuotaMetric>,
    pub(crate) error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AccountSource {
    Local,
    Oauth,
    CpaImport,
    JsonImport,
}

impl Default for AccountSource {
    fn default() -> Self {
        Self::Local
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlatformCredentials {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) access_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) refresh_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) id_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) session_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) token_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) expires_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) plan_expires_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) organization_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) domain: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) api_server_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) provider_region: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) snapshot_id: Option<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub(crate) extra: HashMap<String, Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountRecord {
    pub(crate) id: String,
    pub(crate) platform: SwitchPlatformId,
    pub(crate) label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) plan_type: Option<String>,
    #[serde(default)]
    pub(crate) fingerprint: String,
    #[serde(default)]
    pub(crate) tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) group_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) notes: Option<String>,
    #[serde(default)]
    pub(crate) source: AccountSource,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) last_used_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) last_quota: Option<QuotaSnapshot>,
    #[serde(default)]
    pub(crate) credentials: PlatformCredentials,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountSummary {
    pub(crate) id: String,
    pub(crate) platform: SwitchPlatformId,
    pub(crate) label: String,
    pub(crate) email: Option<String>,
    pub(crate) account_id: Option<String>,
    pub(crate) plan_type: Option<String>,
    pub(crate) fingerprint: String,
    pub(crate) tags: Vec<String>,
    pub(crate) group_id: Option<String>,
    pub(crate) notes: Option<String>,
    pub(crate) source: AccountSource,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
    pub(crate) last_used_at: Option<i64>,
    pub(crate) token_expires_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) plan_expires_at: Option<i64>,
    pub(crate) has_refresh_token: bool,
    pub(crate) last_quota: Option<QuotaSnapshot>,
    pub(crate) is_active: bool,
}

impl AccountRecord {
    pub(crate) fn to_summary(&self, active_id: Option<&str>) -> AccountSummary {
        AccountSummary {
            id: self.id.clone(),
            platform: self.platform,
            label: self.label.clone(),
            email: self.email.clone(),
            account_id: self.account_id.clone(),
            plan_type: self.plan_type.clone(),
            fingerprint: self.fingerprint.clone(),
            tags: self.tags.clone(),
            group_id: self.group_id.clone(),
            notes: self.notes.clone(),
            source: self.source.clone(),
            created_at: self.created_at,
            updated_at: self.updated_at,
            last_used_at: self.last_used_at,
            token_expires_at: self.credentials.expires_at,
            plan_expires_at: self
                .credentials
                .plan_expires_at
                .or_else(|| self.last_quota.as_ref().and_then(|q| q.plan_expires_at)),
            has_refresh_token: self
                .credentials
                .refresh_token
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty()),
            last_quota: self.last_quota.clone(),
            is_active: active_id.is_some_and(|id| id == self.id),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountGroup {
    pub(crate) id: String,
    pub(crate) name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) color: Option<String>,
    #[serde(default)]
    pub(crate) order: i32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalCredentialPreview {
    pub(crate) detected: bool,
    pub(crate) label: Option<String>,
    pub(crate) email: Option<String>,
    pub(crate) account_id: Option<String>,
    pub(crate) fingerprint: Option<String>,
    pub(crate) matched_account_id: Option<String>,
}

impl Default for LocalCredentialPreview {
    fn default() -> Self {
        Self {
            detected: false,
            label: None,
            email: None,
            account_id: None,
            fingerprint: None,
            matched_account_id: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlatformRuntimeStatus {
    pub(crate) platform: SwitchPlatformId,
    pub(crate) category: PlatformCategory,
    pub(crate) display_name: String,
    pub(crate) installed: bool,
    pub(crate) running: bool,
    pub(crate) running_pids: Vec<u32>,
    pub(crate) proxy: ProxyInspection,
    pub(crate) active_account_id: Option<String>,
    pub(crate) local_credential: LocalCredentialPreview,
    pub(crate) account_count: usize,
    pub(crate) supports_oauth: bool,
    pub(crate) supports_cpa_import: bool,
    pub(crate) supports_client_restart: bool,
    pub(crate) sync_targets: Vec<SyncTargetInfo>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountSwitchCatalog {
    pub(crate) vault_dir: String,
    pub(crate) platforms: Vec<PlatformRuntimeStatus>,
    pub(crate) groups: Vec<AccountGroup>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlatformAccountsPayload {
    pub(crate) platform: SwitchPlatformId,
    pub(crate) status: PlatformRuntimeStatus,
    pub(crate) accounts: Vec<AccountSummary>,
    pub(crate) groups: Vec<AccountGroup>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SwitchAccountOptions {
    #[serde(default = "default_true")]
    pub(crate) refresh_before_switch: bool,
    #[serde(default = "default_true")]
    pub(crate) decouple_cpa_proxy: bool,
    #[serde(default)]
    pub(crate) sync_targets: Vec<String>,
    #[serde(default)]
    pub(crate) restart_client: bool,
    #[serde(default)]
    pub(crate) config_directories: Option<crate::agents::AgentConfigDirectories>,
}

fn default_true() -> bool {
    true
}

impl Default for SwitchAccountOptions {
    fn default() -> Self {
        Self {
            refresh_before_switch: true,
            decouple_cpa_proxy: true,
            sync_targets: Vec::new(),
            restart_client: false,
            config_directories: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncTargetResult {
    pub(crate) target: String,
    pub(crate) status: String,
    pub(crate) message: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SwitchAccountResult {
    pub(crate) platform: SwitchPlatformId,
    pub(crate) account_id: String,
    pub(crate) decoupled_proxy: bool,
    pub(crate) refreshed_token: bool,
    pub(crate) client_restarted: bool,
    pub(crate) warnings: Vec<String>,
    pub(crate) sync_results: Vec<SyncTargetResult>,
    pub(crate) status: PlatformRuntimeStatus,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CpaImportCandidate {
    pub(crate) file_name: String,
    pub(crate) file_path: String,
    pub(crate) platform: SwitchPlatformId,
    pub(crate) label: String,
    pub(crate) email: Option<String>,
    pub(crate) account_id: Option<String>,
    pub(crate) fingerprint: String,
    pub(crate) action: String,
    pub(crate) existing_account_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CpaImportSelection {
    pub(crate) file_path: Option<String>,
    pub(crate) file_name: Option<String>,
    pub(crate) raw_json: Option<Value>,
    pub(crate) platform: Option<SwitchPlatformId>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportBatchResult {
    pub(crate) imported: usize,
    pub(crate) updated: usize,
    pub(crate) skipped: usize,
    pub(crate) errors: Vec<String>,
    pub(crate) accounts: Vec<AccountSummary>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountMetaPatch {
    pub(crate) label: Option<String>,
    pub(crate) notes: Option<Option<String>>,
    pub(crate) group_id: Option<Option<String>>,
    pub(crate) tags: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GroupAction {
    pub(crate) action: String,
    pub(crate) id: Option<String>,
    pub(crate) name: Option<String>,
    pub(crate) color: Option<Option<String>>,
    pub(crate) order: Option<Vec<String>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OAuthSessionView {
    pub(crate) session_id: String,
    pub(crate) platform: SwitchPlatformId,
    pub(crate) flow: String,
    pub(crate) status: String,
    pub(crate) auth_url: Option<String>,
    pub(crate) user_code: Option<String>,
    pub(crate) verification_uri: Option<String>,
    pub(crate) expires_in_seconds: Option<u64>,
    pub(crate) error: Option<String>,
    pub(crate) account: Option<AccountSummary>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DecoupleProxyResult {
    pub(crate) platform: SwitchPlatformId,
    pub(crate) changed: bool,
    pub(crate) message: String,
    pub(crate) status: PlatformRuntimeStatus,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RefreshQuotaResult {
    pub(crate) platform: SwitchPlatformId,
    pub(crate) updated: Vec<AccountSummary>,
    pub(crate) errors: Vec<String>,
}

pub(crate) fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub(crate) fn now_secs() -> i64 {
    chrono::Utc::now().timestamp()
}

pub(crate) fn compute_fingerprint(platform: SwitchPlatformId, parts: &[Option<&str>]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(platform.as_str().as_bytes());
    hasher.update(b":");
    for part in parts {
        if let Some(value) = part.map(str::trim).filter(|value| !value.is_empty()) {
            hasher.update(value.to_ascii_lowercase().as_bytes());
            hasher.update(b"|");
        }
    }
    let digest = hasher.finalize();
    digest.iter().take(12).map(|b| format!("{b:02x}")).collect()
}
