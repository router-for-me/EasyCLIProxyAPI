use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CursorClient {
    Cli,
}

impl CursorClient {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "cursor-cli" => Some(Self::Cli),
            _ => None,
        }
    }

    pub(crate) fn id(self) -> &'static str {
        "cursor-cli"
    }

    pub(crate) fn name(self) -> &'static str {
        "Cursor CLI"
    }

    pub(crate) fn target(self) -> &'static str {
        "cli"
    }

    pub(crate) fn executable(self, home: &Path) -> Option<PathBuf> {
        find_cursor_cli(home)
    }
}

pub(crate) fn find_cursor_cli(home: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let directory = agent_configuration_environment("LOCALAPPDATA")
            .unwrap_or_else(|| home.join("AppData/Local"))
            .join("cursor-agent");
        for name in ["cursor-agent.exe", "cursor-agent.cmd", "agent.exe", "agent.cmd"] {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    find_named_agent_executable(home, &["cursor-agent"])
}

pub(crate) fn inspect_cursor_client(client: CursorClient, home: &Path) -> AgentConfigStatus {
    let executable = client.executable(home);
    let version = executable.as_deref().and_then(|path| read_agent_version(path, home));
    cursor_status(client, executable.as_deref(), version)
}

fn cursor_status(client: CursorClient, executable: Option<&Path>, version: Option<String>) -> AgentConfigStatus {
    AgentConfigStatus {
        id: client.id().into(),
        name: client.name().into(),
        supported_platform: true,
        installed: executable.is_some(),
        plugin_installed: true,
        launch_targets: executable.map(|path| AgentLaunchTarget {
            id: client.target().into(),
            label: client.name().into(),
            detail: path_to_string(path),
        }).into_iter().collect(),
        cli_version: version.clone(),
        app_version: None,
        version,
        plugin_version: None,
        config_paths: Vec::new(),
        config_exists: false,
        config_valid: true,
        configured: false,
        configuration_synchronized: false,
        connection_state: "unsupported".into(),
        current_model: None,
        oauth_configuration: false,
        codex_native_oauth: false,
        modification_enabled: false,
        modification_state: "unconfigured".into(),
        backup_available: false,
        applied_model: None,
        claude_code_model_mappings: None,
        claude_desktop_model_mappings: None,
        warnings: Vec::new(),
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_cli_has_a_native_launch_target_and_no_cpa_state() {
        assert_eq!(CursorClient::parse("cursor-cli"), Some(CursorClient::Cli));
        assert_eq!(CursorClient::parse("cursor-ide"), None);
        let status = cursor_status(CursorClient::Cli, Some(Path::new("/installed/client")), Some("1.2.3".into()));
        assert_eq!(status.id, "cursor-cli");
        assert!(status.installed);
        assert_eq!(status.launch_targets.len(), 1);
        assert_eq!(status.launch_targets[0].id, "cli");
        assert_eq!(status.connection_state, "unsupported");
        assert!(!status.configured);
        assert!(!status.modification_enabled);
        assert!(!status.configuration_synchronized);
        assert!(status.config_paths.is_empty());
        assert_eq!(status.cli_version.as_deref(), Some("1.2.3"));
        assert!(status.app_version.is_none());
        let missing = cursor_status(CursorClient::Cli, None, None);
        assert!(!missing.installed);
        assert!(missing.launch_targets.is_empty());
    }

    #[test]
    fn cursor_clients_cannot_enter_managed_configuration_operations() {
        for id in ["cursor-ide", "cursor-cli", " CURSOR-CLI "] {
            assert!(AgentClient::parse(id).unwrap_err().contains("CPA"));
        }
        assert_eq!(CursorClient::parse("codex"), None);
    }
}
