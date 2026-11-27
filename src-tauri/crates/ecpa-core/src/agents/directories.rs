use super::*;
use std::collections::HashMap;

pub(crate) type AgentConfigDirectories = HashMap<String, String>;

tokio::task_local! {
    pub(crate) static AGENT_CONFIG_DIRECTORIES: AgentConfigDirectories;
}

pub(crate) fn validate_agent_config_directories(
    directories: Option<AgentConfigDirectories>,
) -> Result<AgentConfigDirectories, String> {
    let mut directories = directories.unwrap_or_default();
    directories.retain(|_, value| !value.trim().is_empty());
    for (client, value) in &mut directories {
        if client != PI_AGENT_ID {
            AgentClient::parse(client)?;
        }
        *value = value.trim().to_string();
        let path = Path::new(value);
        if !path.is_absolute()
            || path
                .components()
                .any(|component| matches!(component, std::path::Component::ParentDir))
            || value.contains('\0')
        {
            return Err(
                "Configuration directory must be an absolute path without parent traversal".into(),
            );
        }
        if path.exists() && !path.is_dir() {
            return Err("Configuration directory must not be a file".into());
        }
    }
    Ok(directories)
}

pub(crate) fn agent_config_directory(client: &str) -> Option<PathBuf> {
    AGENT_CONFIG_DIRECTORIES
        .try_with(|directories| directories.get(client).map(PathBuf::from))
        .ok()
        .flatten()
}
