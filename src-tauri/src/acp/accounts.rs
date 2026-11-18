use super::*;
use std::io::Write;

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Account {
    pub(super) id: String,
    pub(super) label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) email: Option<String>,
    // Historical local record only, never a claim that a login is still valid.
    #[serde(default)]
    pub(super) saved: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Accounts {
    pub(super) active: String,
    pub(super) accounts: Vec<Account>,
}

impl Default for Accounts {
    fn default() -> Self {
        Self {
            active: "default".into(),
            accounts: vec![Account {
                id: "default".into(),
                label: "Default".into(),
                email: None,
                saved: false,
            }],
        }
    }
}

fn valid_id(id: &str) -> bool {
    id == "default" || (id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

pub(super) fn validate_label(label: &str) -> Result<&str, String> {
    let trimmed = label.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 80 || label.chars().any(char::is_control) {
        return Err(
            "Enter an ACP account label of 1–80 characters without control characters".into(),
        );
    }
    Ok(trimmed)
}

// Refuse links at every existing component, including the root itself. Never
// traverse an account-selected path outside this app's private ACP directory.
pub(super) fn safe_path(path: &Path) -> Result<(), String> {
    let mut current = PathBuf::new();
    for component in path.components() {
        if matches!(component, std::path::Component::ParentDir) {
            return Err("Invalid ACP profile path".into());
        }
        current.push(component);
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("ACP account paths must not contain symbolic links".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Cannot inspect ACP account path: {error}")),
        }
    }
    Ok(())
}

// Old single-account builds could finish authorization without creating a
// registry when no email was exposed. Preserve local history, not an assertion
// of authentication. Inspect only entry types/existence, never file contents.
// prepare_profile and bridge settings create an empty workspace; pending new
// accounts and bridge/recovery infrastructure must not count as default history.
fn has_legacy_default_history(root: &Path) -> Result<bool, String> {
    let selected = selected_path(root);
    safe_path(&selected)?;
    match std::fs::symlink_metadata(&selected) {
        Ok(metadata) if metadata.is_file() => return Ok(true),
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Cannot inspect historical ACP model settings: {error}"
            ))
        }
    }
    for name in [".gemini", "workspace"] {
        let directory = root.join(name);
        safe_path(&directory)?;
        let mut directories = vec![directory];
        while let Some(directory) = directories.pop() {
            let entries = match std::fs::read_dir(directory) {
                Ok(entries) => entries,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(format!("Cannot inspect historical ACP profile: {error}"))
                }
            };
            for entry in entries {
                let entry = entry
                    .map_err(|error| format!("Cannot inspect historical ACP profile: {error}"))?;
                let kind = entry
                    .file_type()
                    .map_err(|error| format!("Cannot inspect historical ACP profile: {error}"))?;
                if kind.is_dir() {
                    directories.push(entry.path());
                } else {
                    return Ok(true);
                } // Includes links, but never follows them.
            }
        }
    }
    Ok(false)
}

pub(super) fn read(root: &Path) -> Result<Accounts, String> {
    safe_path(&root.join("accounts.json"))?;
    let mut registry: Accounts = match std::fs::read(root.join("accounts.json")) {
        Ok(bytes) => {
            let value: Value = serde_json::from_slice(&bytes)
                .map_err(|e| format!("Invalid ACP account registry: {e}"))?;
            let mut registry: Accounts = serde_json::from_value(value.clone())
                .map_err(|e| format!("Invalid ACP account registry: {e}"))?;
            // An existing legacy registry record is saved local history even
            // without an email (older CLI versions did not expose identity).
            // Do not read credentials or infer health. Explicit saved:false
            // remains authoritative for the new empty compatibility slot.
            for (account, value) in registry
                .accounts
                .iter_mut()
                .zip(value["accounts"].as_array().into_iter().flatten())
            {
                if value.get("saved").is_none() {
                    account.saved = true;
                }
            }
            registry
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let mut registry = Accounts::default();
            registry.accounts[0].saved = has_legacy_default_history(root)?;
            registry
        }
        Err(e) => return Err(format!("Failed to read ACP accounts: {e}")),
    };
    let mut ids = std::collections::HashSet::new();
    if registry.accounts.is_empty()
        || registry.accounts.len() > 32
        || registry.accounts.iter().any(|account| {
            !valid_id(&account.id)
                || !ids.insert(account.id.clone())
                || validate_label(&account.label).is_err()
        })
        || !ids.contains(&registry.active)
    {
        return Err("Invalid ACP account registry".into());
    }
    // Keep all labels normalized after legacy migration.
    for account in &mut registry.accounts {
        account.label = account.label.trim().into();
    }
    Ok(registry)
}

fn random_id() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn write(root: &Path, registry: &Accounts) -> Result<(), String> {
    safe_path(root)?;
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let destination = root.join("accounts.json");
    safe_path(&destination)?;
    let temporary = root.join(format!(".accounts-{}.tmp", random_id()?));
    let bytes = serde_json::to_vec(registry).map_err(|e| e.to_string())?;
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        crate::replace_file_atomically(&temporary, &destination).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

pub(super) fn set_active_email(root: &Path, email: Option<String>) -> Result<(), String> {
    let mut registry = read(root)?;
    let account = registry
        .accounts
        .iter_mut()
        .find(|account| account.id == registry.active)
        .ok_or("Unknown ACP account")?;
    account.email = email;
    write(root, &registry)
}

pub(super) fn recoveries_path(root: &Path) -> PathBuf {
    root.join("removed-accounts")
}

pub(super) fn mark_saved(root: &Path) -> Result<(), String> {
    let mut registry = read(root)?;
    registry
        .accounts
        .iter_mut()
        .find(|account| account.id == registry.active)
        .ok_or("Unknown ACP account")?
        .saved = true;
    write(root, &registry)
}

pub(super) fn directory(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("Invalid ACP account ID".into());
    }
    let path = if id == "default" {
        root.to_path_buf()
    } else {
        root.join("accounts").join(id)
    };
    safe_path(&path)?;
    Ok(path)
}

pub(super) fn active(root: &Path) -> Result<PathBuf, String> {
    directory(root, &read(root)?.active)
}

pub(super) fn select(root: &Path, id: &str) -> Result<(), String> {
    let mut registry = read(root)?;
    if !registry.accounts.iter().any(|account| account.id == id) {
        return Err("Unknown ACP account".into());
    }
    prepare_profile(&directory(root, id)?)?;
    registry.active = id.into();
    write(root, &registry)
}

pub(super) fn rename(root: &Path, id: &str, label: &str) -> Result<(), String> {
    let label = validate_label(label)?;
    let mut registry = read(root)?;
    registry
        .accounts
        .iter_mut()
        .find(|account| account.id == id)
        .ok_or("Unknown ACP account")?
        .label = label.into();
    write(root, &registry)
}

// A provisional profile never enters accounts.json. The receipt of a successful
// authenticate response is the commit point, BEFORE session/new can fail or be
// cancelled. Before that point cancellation restores the old selection because
// it was never changed; login data is quarantined, never destroyed.
pub(super) struct PendingAccount {
    root: PathBuf,
    pub(super) id: String,
    label: String,
    finished: bool,
}

impl PendingAccount {
    pub(super) fn new(root: &Path, label: &str) -> Result<Self, String> {
        let label = validate_label(label)?.to_string();
        let registry = read(root)?;
        if registry
            .accounts
            .iter()
            .filter(|a| a.saved || a.id != "default")
            .count()
            >= 32
        {
            return Err("Up to 32 ACP accounts can be saved".into());
        }
        let id = random_id()?;
        let path = directory(root, &id)?;
        if path.exists() {
            return Err("ACP account directory already exists".into());
        }
        prepare_profile(&path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                root.join("accounts"),
                std::fs::Permissions::from_mode(0o700),
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(Self {
            root: root.into(),
            id,
            label,
            finished: false,
        })
    }

    pub(super) fn directory(&self) -> Result<PathBuf, String> {
        directory(&self.root, &self.id)
    }

    pub(super) fn commit(&mut self, email: Option<String>) -> Result<(), String> {
        // Receipt of official success owns this profile even if persistence
        // fails; Drop must never quarantine an acknowledged successful login.
        self.finished = true;
        let recovery_error = |error| {
            format!("Google authorization completed, but the account registry could not be saved. Login data is preserved at {}: {error}", self.root.join("accounts").join(&self.id).display())
        };
        let mut registry = read(&self.root).map_err(&recovery_error)?;
        registry
            .accounts
            .retain(|a| a.id != "default" || a.saved || a.email.is_some());
        registry.accounts.push(Account {
            id: self.id.clone(),
            label: self.label.clone(),
            email,
            saved: true,
        });
        registry.active = self.id.clone();
        write(&self.root, &registry).map_err(recovery_error)
    }

    pub(super) fn rollback(&mut self) -> Result<(), String> {
        if self.finished {
            return Ok(());
        }
        quarantine(&self.root, &self.id, None)?;
        self.finished = true;
        Ok(())
    }
}

impl Drop for PendingAccount {
    fn drop(&mut self) {
        let _ = self.rollback();
    }
}

// Move, not recursively delete. In particular the legacy default profile shares
// its root with other accounts and the global bridge configuration.
fn quarantine(root: &Path, id: &str, registry: Option<&Accounts>) -> Result<PathBuf, String> {
    let source = directory(root, id)?;
    let recycle = root
        .join("removed-accounts")
        .join(format!("{id}-{}", random_id()?));
    safe_path(&recycle)?;
    let sources = if id == "default" {
        [".gemini", "workspace", "selected-model.json"]
            .iter()
            .map(|name| source.join(name))
            .collect::<Vec<_>>()
    } else {
        vec![source]
    };
    for path in &sources {
        safe_path(path)?;
    }
    std::fs::create_dir_all(&recycle).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for directory in [recoveries_path(root), recycle.clone()] {
            std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
    }
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    let result = (|| {
        for path in sources {
            if path.exists() {
                let target = recycle.join(path.file_name().ok_or("Invalid ACP account path")?);
                std::fs::rename(&path, &target)
                    .map_err(|e| format!("Failed to isolate ACP login data: {e}"))?;
                moved.push((path, target));
            }
        }
        if let Some(registry) = registry {
            write(root, registry)?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        let mut errors = vec![error];
        for (source, target) in moved.iter().rev() {
            if let Err(error) = std::fs::rename(target, source) {
                errors.push(format!(
                    "Recovery data remains at {}: {error}",
                    target.display()
                ));
            }
        }
        return Err(errors.join("; "));
    }
    Ok(recycle)
}

pub(super) fn remove(root: &Path, id: &str) -> Result<PathBuf, String> {
    let mut registry = read(root)?;
    if !registry.accounts.iter().any(|a| a.id == id) {
        return Err("Unknown ACP account".into());
    }
    registry.accounts.retain(|a| a.id != id);
    if registry.accounts.is_empty() {
        registry = Accounts::default();
    } else if registry.active == id {
        registry.active = registry.accounts[0].id.clone();
    }
    quarantine(root, id, Some(&registry))
}

#[cfg(test)]
mod tests;
