pub(crate) mod hermes;
pub(crate) mod openclaw;
pub(crate) mod opencode;
pub(crate) mod wsl;

use super::types::{AccountRecord, SwitchPlatformId, SyncTargetInfo, SyncTargetResult};
use std::path::Path;

pub(crate) fn inspect_sync_targets(platform: SwitchPlatformId, home: &Path) -> Vec<SyncTargetInfo> {
    platform
        .supported_sync_targets()
        .iter()
        .map(|&target| match target {
            "opencode" => opencode::inspect(home),
            "openclaw" => openclaw::inspect(home),
            "hermes" => hermes::inspect(home),
            "wsl" => wsl::inspect(),
            other => SyncTargetInfo {
                id: other.to_string(),
                label: other.to_string(),
                installed: false,
                target_path: None,
            },
        })
        .collect()
}

pub(crate) fn run_sync_targets(
    record: &AccountRecord,
    targets: &[String],
    home: &Path,
) -> Vec<SyncTargetResult> {
    let allowed = record.platform.supported_sync_targets();
    let mut results = Vec::new();
    for target in targets {
        let normalized = target.trim().to_ascii_lowercase();
        if !allowed.contains(&normalized.as_str()) {
            results.push(SyncTargetResult {
                target: normalized,
                status: "skipped".to_string(),
                message: Some("Unsupported sync target for this platform".to_string()),
            });
            continue;
        }
        let outcome = match normalized.as_str() {
            "opencode" => opencode::sync_account(record, home),
            "openclaw" => openclaw::sync_account(record, home),
            "hermes" => hermes::sync_account(record, home),
            "wsl" => wsl::sync_codex_account(record),
            _ => Err("Unknown sync target".to_string()),
        };
        match outcome {
            Ok(msg) => results.push(SyncTargetResult {
                target: normalized,
                status: "synced".to_string(),
                message: Some(msg),
            }),
            Err(err) => results.push(SyncTargetResult {
                target: normalized,
                status: "error".to_string(),
                message: Some(err),
            }),
        }
    }
    results
}
