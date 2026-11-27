use super::crypto::write_atomic_secure;
use super::types::{ProxyInspection, ProxyMode, SwitchPlatformId};
use crate::agents::{
    agent_config_paths, clear_agent_managed_configuration, close_codex_configuration,
    codex_configuration_directory, codex_uses_openai_proxy, inspect_agent_managed_config,
};
use crate::AgentClient;
use serde_json::Value;
use std::fs;
use std::path::Path;

fn is_loopback_proxy_url(url: &str, cpa_port: u16) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    let port_str = format!(":{cpa_port}");
    (lower.contains("127.0.0.1") || lower.contains("localhost") || lower.contains("host.docker.internal"))
        && (lower.contains(&port_str) || lower.contains("/v1"))
}

fn mapped_agent_clients(platform: SwitchPlatformId) -> &'static [AgentClient] {
    match platform {
        SwitchPlatformId::Codex => &[AgentClient::Codex],
        SwitchPlatformId::ClaudeCode => &[AgentClient::ClaudeCode],
        SwitchPlatformId::Antigravity => &[AgentClient::AntigravityCli],
        SwitchPlatformId::Grok => &[AgentClient::GrokBuild],
        SwitchPlatformId::Kimi => &[AgentClient::KimiCode],
        SwitchPlatformId::GithubCopilot => &[AgentClient::VscodeCopilot, AgentClient::CopilotCli],
        SwitchPlatformId::Workbuddy | SwitchPlatformId::WorkbuddyAi => &[AgentClient::WorkBuddy],
        SwitchPlatformId::Zcode => &[AgentClient::ZCode],
        SwitchPlatformId::ClaudeDesktop => &[AgentClient::ClaudeDesktop],
        SwitchPlatformId::WindsurfDevin => &[],
    }
}

pub(crate) fn inspect_platform_proxy(
    platform: SwitchPlatformId,
    home: &Path,
    cpa_port: u16,
    cpa_api_key: &str,
) -> ProxyInspection {
    let mut config_paths = Vec::new();
    for &client in mapped_agent_clients(platform) {
        for path in agent_config_paths(client, home) {
            let s = path.to_string_lossy().into_owned();
            if !config_paths.contains(&s) {
                config_paths.push(s);
            }
        }
    }

    // 1. Platform-specific deep config checks (works even when API key changed or CPA stopped).
    match platform {
        SwitchPlatformId::Codex => {
            let config_path = codex_configuration_directory(home).join("config.toml");
            if let Ok(raw) = fs::read_to_string(&config_path) {
                if let Ok(doc) = raw.parse::<toml_edit::Document>() {
                    let provider = doc
                        .get("model_provider")
                        .and_then(toml_edit::Item::as_str)
                        .unwrap_or_default();
                    let openai_base = doc
                        .get("openai_base_url")
                        .and_then(toml_edit::Item::as_str)
                        .unwrap_or_default();
                    if provider == crate::MANAGED_AGENT_PROVIDER_ID
                        || codex_uses_openai_proxy(&doc)
                        || is_loopback_proxy_url(openai_base, cpa_port)
                    {
                        return ProxyInspection {
                            mode: ProxyMode::CpaProxy,
                            detail: Some(format!(
                                "Codex config.toml routes through CPA reverse proxy ({})",
                                if !openai_base.is_empty() {
                                    openai_base
                                } else {
                                    provider
                                }
                            )),
                            can_decouple: true,
                            config_paths,
                        };
                    }
                    if !openai_base.is_empty()
                        && !openai_base.contains("api.openai.com")
                        && !openai_base.contains("chatgpt.com")
                    {
                        return ProxyInspection {
                            mode: ProxyMode::CustomProxy,
                            detail: Some(format!("Custom openai_base_url: {openai_base}")),
                            can_decouple: true,
                            config_paths,
                        };
                    }
                }
            }
        }
        SwitchPlatformId::ClaudeCode => {
            let settings_path = agent_config_paths(AgentClient::ClaudeCode, home)
                .into_iter()
                .next()
                .unwrap_or_else(|| home.join(".claude").join("settings.json"));
            if let Ok(raw) = fs::read_to_string(&settings_path) {
                if let Ok(json) = serde_json::from_str::<Value>(&raw) {
                    if let Some(base_url) = json
                        .get("env")
                        .and_then(|env| env.get("ANTHROPIC_BASE_URL"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|v| !v.is_empty())
                    {
                        if is_loopback_proxy_url(base_url, cpa_port) {
                            return ProxyInspection {
                                mode: ProxyMode::CpaProxy,
                                detail: Some(format!(
                                    "Claude Code ANTHROPIC_BASE_URL points to CPA ({base_url})"
                                )),
                                can_decouple: true,
                                config_paths,
                            };
                        }
                        if !base_url.contains("api.anthropic.com") {
                            return ProxyInspection {
                                mode: ProxyMode::CustomProxy,
                                detail: Some(format!("Custom ANTHROPIC_BASE_URL: {base_url}")),
                                can_decouple: true,
                                config_paths,
                            };
                        }
                    }
                }
            }
        }
        SwitchPlatformId::Grok => {
            let config_path = home.join(".grok").join("config.toml");
            if let Ok(raw) = fs::read_to_string(&config_path) {
                if let Ok(root) = toml::from_str::<toml::Value>(&raw) {
                    let default_model = root
                        .get("models")
                        .and_then(toml::Value::as_table)
                        .and_then(|m| m.get("default"))
                        .and_then(toml::Value::as_str)
                        .unwrap_or_default();
                    let prefix = format!("{}/", crate::MANAGED_AGENT_PROVIDER_ID);
                    if default_model.starts_with(&prefix) {
                        return ProxyInspection {
                            mode: ProxyMode::CpaProxy,
                            detail: Some(format!(
                                "Grok config.toml default model points to CPA ({default_model})"
                            )),
                            can_decouple: true,
                            config_paths,
                        };
                    }
                }
            }
        }
        SwitchPlatformId::Kimi => {
            let config_path = std::env::var_os("KIMI_CODE_HOME")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| home.join(".kimi-code"))
                .join("config.toml");
            if let Ok(raw) = fs::read_to_string(&config_path) {
                if let Ok(root) = toml::from_str::<toml::Value>(&raw) {
                    let default_model = root
                        .get("default_model")
                        .and_then(toml::Value::as_str)
                        .unwrap_or_default();
                    let prefix = format!("{}/", crate::MANAGED_AGENT_PROVIDER_ID);
                    if default_model.starts_with(&prefix) {
                        return ProxyInspection {
                            mode: ProxyMode::CpaProxy,
                            detail: Some(format!(
                                "Kimi Code config.toml default_model points to CPA ({default_model})"
                            )),
                            can_decouple: true,
                            config_paths,
                        };
                    }
                }
            }
        }
        _ => {}
    }

    // 2. Fallback to existing ECPA managed-agent inspection.
    for &client in mapped_agent_clients(platform) {
        let paths = agent_config_paths(client, home);
        if let Ok((configured, _, _)) =
            inspect_agent_managed_config(client, &paths, cpa_port, cpa_api_key)
        {
            if configured {
                return ProxyInspection {
                    mode: ProxyMode::CpaProxy,
                    detail: Some(format!(
                        "{} is currently configured to route through CPA reverse proxy",
                        client.name()
                    )),
                    can_decouple: true,
                    config_paths,
                };
            }
        }
    }

    ProxyInspection {
        mode: ProxyMode::Direct,
        detail: None,
        can_decouple: false,
        config_paths,
    }
}

/// Removes CPA reverse-proxy routing for the target platform so official direct OAuth credentials
/// take effect immediately.
pub(crate) fn decouple_platform_proxy(
    platform: SwitchPlatformId,
    home: &Path,
    cpa_port: u16,
) -> Result<(bool, String), String> {
    let _guard = crate::AGENT_CONFIG_FILE_LOCK
        .lock()
        .map_err(|_| "Agent configuration lock poisoned".to_string())?;

    let mut changed = false;

    match platform {
        SwitchPlatformId::Codex => {
            if let Ok(result) = close_codex_configuration(home) {
                if !result.changed_files.is_empty() {
                    changed = true;
                }
            }
            // Ensure no leftover CPA proxy routing remains in ~/.codex/config.toml.
            let config_path = codex_configuration_directory(home).join("config.toml");
            if let Ok(raw) = fs::read_to_string(&config_path) {
                if let Ok(mut doc) = raw.parse::<toml_edit::Document>() {
                    let mut dirty = false;
                    let provider = doc
                        .get("model_provider")
                        .and_then(toml_edit::Item::as_str)
                        .map(str::to_string);
                    let openai_base = doc
                        .get("openai_base_url")
                        .and_then(toml_edit::Item::as_str)
                        .map(str::to_string);
                    if provider.as_deref() == Some(crate::MANAGED_AGENT_PROVIDER_ID) {
                        doc.remove("model_provider");
                        dirty = true;
                    }
                    if openai_base
                        .as_deref()
                        .is_some_and(|u| is_loopback_proxy_url(u, cpa_port))
                    {
                        doc.remove("openai_base_url");
                        dirty = true;
                    }
                    if let Some(table) = doc
                        .get_mut("model_providers")
                        .and_then(toml_edit::Item::as_table_like_mut)
                    {
                        if table.remove(crate::MANAGED_AGENT_PROVIDER_ID).is_some() {
                            dirty = true;
                        }
                        if table.is_empty() {
                            doc.remove("model_providers");
                        }
                    }
                    if dirty {
                        write_atomic_secure(&config_path, doc.to_string().as_bytes())?;
                        changed = true;
                    }
                }
            }
        }
        SwitchPlatformId::ClaudeCode => {
            if let Ok(result) =
                clear_agent_managed_configuration(AgentClient::ClaudeCode, home, cpa_port)
            {
                if !result.changed_files.is_empty() {
                    changed = true;
                }
            }
            // Also clean residual loopback proxy env overrides from ~/.claude/settings.json.
            let settings_path = agent_config_paths(AgentClient::ClaudeCode, home)
                .into_iter()
                .next()
                .unwrap_or_else(|| home.join(".claude").join("settings.json"));
            if let Ok(raw) = fs::read_to_string(&settings_path) {
                if let Ok(mut root) = serde_json::from_str::<Value>(&raw) {
                    let mut dirty = false;
                    if let Some(env_obj) = root.get_mut("env").and_then(Value::as_object_mut) {
                        let base_is_proxy = env_obj
                            .get("ANTHROPIC_BASE_URL")
                            .and_then(Value::as_str)
                            .is_some_and(|u| !u.contains("api.anthropic.com"));
                        if base_is_proxy {
                            env_obj.remove("ANTHROPIC_BASE_URL");
                            env_obj.remove("ANTHROPIC_AUTH_TOKEN");
                            env_obj.remove("ANTHROPIC_API_KEY");
                            dirty = true;
                        }
                    }
                    if dirty {
                        let rendered = serde_json::to_vec_pretty(&root)
                            .map_err(|e| format!("Failed to serialize Claude settings.json: {e}"))?;
                        write_atomic_secure(&settings_path, &rendered)?;
                        changed = true;
                    }
                }
            }
        }
        SwitchPlatformId::Grok => {
            if let Ok(result) =
                clear_agent_managed_configuration(AgentClient::GrokBuild, home, cpa_port)
            {
                if !result.changed_files.is_empty() {
                    changed = true;
                }
            }
            let config_path = home.join(".grok").join("config.toml");
            if let Ok(raw) = fs::read_to_string(&config_path) {
                if let Ok(mut doc) = raw.parse::<toml_edit::Document>() {
                    let prefix = format!("{}/", crate::MANAGED_AGENT_PROVIDER_ID);
                    let mut dirty = false;
                    if let Some(models) = doc
                        .get_mut("models")
                        .and_then(toml_edit::Item::as_table_like_mut)
                    {
                        if models
                            .get("default")
                            .and_then(toml_edit::Item::as_str)
                            .is_some_and(|v| v.starts_with(&prefix))
                        {
                            models.remove("default");
                            dirty = true;
                        }
                    }
                    if dirty {
                        write_atomic_secure(&config_path, doc.to_string().as_bytes())?;
                        changed = true;
                    }
                }
            }
        }
        SwitchPlatformId::Kimi => {
            if let Ok(result) =
                clear_agent_managed_configuration(AgentClient::KimiCode, home, cpa_port)
            {
                if !result.changed_files.is_empty() {
                    changed = true;
                }
            }
            let config_path = std::env::var_os("KIMI_CODE_HOME")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| home.join(".kimi-code"))
                .join("config.toml");
            if let Ok(raw) = fs::read_to_string(&config_path) {
                if let Ok(mut doc) = raw.parse::<toml_edit::Document>() {
                    let prefix = format!("{}/", crate::MANAGED_AGENT_PROVIDER_ID);
                    let mut dirty = false;
                    if doc
                        .get("default_model")
                        .and_then(toml_edit::Item::as_str)
                        .is_some_and(|v| v.starts_with(&prefix))
                    {
                        doc.remove("default_model");
                        dirty = true;
                    }
                    if let Some(providers) = doc
                        .get_mut("providers")
                        .and_then(toml_edit::Item::as_table_like_mut)
                    {
                        if providers.remove(crate::MANAGED_AGENT_PROVIDER_ID).is_some() {
                            dirty = true;
                        }
                    }
                    if dirty {
                        write_atomic_secure(&config_path, doc.to_string().as_bytes())?;
                        changed = true;
                    }
                }
            }
        }
        _ => {
            for &client in mapped_agent_clients(platform) {
                if let Ok(result) = clear_agent_managed_configuration(client, home, cpa_port) {
                    if !result.changed_files.is_empty() {
                        changed = true;
                    }
                }
            }
        }
    }

    let message = if changed {
        format!(
            "{} has been switched back to official direct mode",
            platform.display_name()
        )
    } else {
        format!(
            "{} is already in official direct mode",
            platform.display_name()
        )
    };
    Ok((changed, message))
}
