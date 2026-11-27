pub(crate) mod antigravity;
pub(crate) mod claude_code;
pub(crate) mod claude_desktop;
pub(crate) mod codex;
pub(crate) mod common;
pub(crate) mod github_copilot;
pub(crate) mod grok;
pub(crate) mod kimi;
pub(crate) mod windsurf_devin;
pub(crate) mod workbuddy;
pub(crate) mod zcode;

use super::types::{AccountRecord, OAuthSessionView, QuotaSnapshot, SwitchPlatformId};
use super::vault::AccountVault;
use std::path::{Path, PathBuf};

pub(crate) fn is_installed(platform: SwitchPlatformId, home: &Path) -> bool {
    match platform {
        SwitchPlatformId::Codex => codex::is_installed(home),
        SwitchPlatformId::ClaudeCode => claude_code::is_installed(home),
        SwitchPlatformId::Antigravity => antigravity::is_installed(home),
        SwitchPlatformId::Grok => grok::is_installed(home),
        SwitchPlatformId::Kimi => kimi::is_installed(home),
        SwitchPlatformId::GithubCopilot => github_copilot::is_installed(home),
        SwitchPlatformId::WindsurfDevin => windsurf_devin::is_installed(home),
        SwitchPlatformId::Workbuddy | SwitchPlatformId::WorkbuddyAi => {
            workbuddy::is_installed(platform, home)
        }
        SwitchPlatformId::Zcode => zcode::is_installed(home),
        SwitchPlatformId::ClaudeDesktop => claude_desktop::is_installed(home),
    }
}

pub(crate) fn read_local_preview(
    platform: SwitchPlatformId,
    home: &Path,
) -> Result<Option<AccountRecord>, String> {
    match platform {
        SwitchPlatformId::Codex => codex::read_local_account(home),
        SwitchPlatformId::ClaudeCode => claude_code::read_local_account(home),
        SwitchPlatformId::Antigravity => antigravity::read_local_account(home),
        SwitchPlatformId::Grok => grok::read_local_account(home),
        SwitchPlatformId::Kimi => kimi::read_local_account(home),
        SwitchPlatformId::GithubCopilot => github_copilot::read_local_account(home),
        SwitchPlatformId::WindsurfDevin => windsurf_devin::read_local_account(home),
        SwitchPlatformId::Workbuddy | SwitchPlatformId::WorkbuddyAi => {
            workbuddy::read_local_account(platform, home)
        }
        SwitchPlatformId::Zcode => zcode::read_local_account(home),
        SwitchPlatformId::ClaudeDesktop => claude_desktop::read_local_preview(home),
    }
}

pub(crate) fn import_local_account(
    platform: SwitchPlatformId,
    home: &Path,
    vault: &AccountVault,
) -> Result<(AccountRecord, bool), String> {
    let record = if platform == SwitchPlatformId::ClaudeDesktop {
        claude_desktop::capture_local_snapshot(home, vault)?
    } else {
        read_local_preview(platform, home)?.ok_or_else(|| {
            format!(
                "No local logged-in account detected for {}",
                platform.display_name()
            )
        })?
    };
    vault.upsert_record(record)
}

pub(crate) fn apply_account(
    platform: SwitchPlatformId,
    home: &Path,
    vault: &AccountVault,
    record: &AccountRecord,
) -> Result<(), String> {
    match platform {
        SwitchPlatformId::Codex => codex::apply_account(home, record),
        SwitchPlatformId::ClaudeCode => claude_code::apply_account(home, record),
        SwitchPlatformId::Antigravity => antigravity::apply_account(home, record),
        SwitchPlatformId::Grok => grok::apply_account(home, record),
        SwitchPlatformId::Kimi => kimi::apply_account(home, record),
        SwitchPlatformId::GithubCopilot => github_copilot::apply_account(home, record),
        SwitchPlatformId::WindsurfDevin => windsurf_devin::apply_account(home, record),
        SwitchPlatformId::Workbuddy | SwitchPlatformId::WorkbuddyAi => {
            workbuddy::apply_account(platform, home, record)
        }
        SwitchPlatformId::Zcode => zcode::apply_account(home, record),
        SwitchPlatformId::ClaudeDesktop => claude_desktop::apply_account(home, vault, record),
    }
}

pub(crate) async fn refresh_if_needed(
    record: &mut AccountRecord,
    force: bool,
    proxy_url: Option<&str>,
) -> Result<bool, String> {
    match record.platform {
        SwitchPlatformId::Codex => codex::refresh_if_needed(record, force, proxy_url).await,
        SwitchPlatformId::ClaudeCode => {
            claude_code::refresh_if_needed(record, force, proxy_url).await
        }
        SwitchPlatformId::Antigravity => {
            antigravity::refresh_if_needed(record, force, proxy_url).await
        }
        SwitchPlatformId::Grok => grok::refresh_if_needed(record, force, proxy_url).await,
        SwitchPlatformId::Kimi => kimi::refresh_if_needed(record, force, proxy_url).await,
        _ => Ok(false),
    }
}

pub(crate) async fn fetch_quota(
    record: &AccountRecord,
    proxy_url: Option<&str>,
) -> Result<QuotaSnapshot, String> {
    match record.platform {
        SwitchPlatformId::Codex => codex::fetch_quota(record, proxy_url).await,
        SwitchPlatformId::ClaudeCode => claude_code::fetch_quota(record, proxy_url).await,
        SwitchPlatformId::Antigravity => antigravity::fetch_quota(record, proxy_url).await,
        SwitchPlatformId::Grok => grok::fetch_quota(record, proxy_url).await,
        SwitchPlatformId::Kimi => kimi::fetch_quota(record, proxy_url).await,
        SwitchPlatformId::GithubCopilot => github_copilot::fetch_quota(record, proxy_url).await,
        SwitchPlatformId::WindsurfDevin => windsurf_devin::fetch_quota(record, proxy_url).await,
        SwitchPlatformId::Workbuddy | SwitchPlatformId::WorkbuddyAi => {
            workbuddy::fetch_quota(record).await
        }
        SwitchPlatformId::Zcode => zcode::fetch_quota(record).await,
        SwitchPlatformId::ClaudeDesktop => claude_desktop::fetch_quota(record).await,
    }
}

pub(crate) async fn start_oauth_login(
    platform: SwitchPlatformId,
    vault_root: PathBuf,
    proxy_url: Option<String>,
) -> Result<OAuthSessionView, String> {
    match platform {
        SwitchPlatformId::Codex => codex::start_oauth_login(vault_root, proxy_url).await,
        SwitchPlatformId::ClaudeCode => claude_code::start_oauth_login(vault_root, proxy_url).await,
        SwitchPlatformId::Grok => grok::start_oauth_login(vault_root, proxy_url).await,
        SwitchPlatformId::Kimi => kimi::start_oauth_login(vault_root, proxy_url).await,
        SwitchPlatformId::GithubCopilot => {
            github_copilot::start_oauth_login(vault_root, proxy_url).await
        }
        other => Err(format!(
            "Interactive OAuth login is not required for {}; capture your local logged-in client session or import JSON instead.",
            other.display_name()
        )),
    }
}
