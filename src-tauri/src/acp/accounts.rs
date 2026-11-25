use super::*;
use std::io::Write;

pub(super) const MAX_ACCOUNTS: usize = 64;
pub(super) const MIN_WEIGHT: u32 = 1;
pub(super) const MAX_WEIGHT: u32 = 100;
pub(super) const MIN_ACCOUNT_CONCURRENCY: u32 = 1;
pub(super) const MAX_ACCOUNT_CONCURRENCY: u32 = 16;

fn default_enabled() -> bool {
    true
}

fn default_weight() -> u32 {
    1
}

fn default_max_concurrency() -> u32 {
    1
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Account {
    pub(super) id: String,
    pub(super) label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) email: Option<String>,
    // Historical local record only, never a claim that a login is still valid.
    #[serde(default)]
    pub(super) saved: bool,
    #[serde(default)]
    pub(super) isolated: bool,
    #[serde(default = "default_enabled")]
    pub(super) enabled: bool,
    #[serde(default)]
    pub(super) priority: u32,
    #[serde(default = "default_weight")]
    pub(super) weight: u32,
    #[serde(
        default = "default_max_concurrency",
        rename = "maxConcurrency",
        alias = "max_concurrency"
    )]
    pub(super) max_concurrency: u32,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "proxyUrl",
        alias = "proxy_url"
    )]
    pub(super) proxy_url: Option<String>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountSettingsPatch {
    pub(super) label: Option<String>,
    pub(super) enabled: Option<bool>,
    pub(super) priority: Option<u32>,
    pub(super) weight: Option<u32>,
    pub(super) max_concurrency: Option<u32>,
    pub(super) proxy_url: Option<String>,
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
                isolated: false,
                enabled: true,
                priority: 0,
                weight: 1,
                max_concurrency: 1,
                proxy_url: None,
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

pub(super) fn validate_weight(weight: u32) -> Result<u32, String> {
    if !(MIN_WEIGHT..=MAX_WEIGHT).contains(&weight) {
        return Err(format!(
            "ACP account weight must be between {MIN_WEIGHT} and {MAX_WEIGHT}"
        ));
    }
    Ok(weight)
}

pub(super) fn validate_max_concurrency(limit: u32) -> Result<u32, String> {
    if !(MIN_ACCOUNT_CONCURRENCY..=MAX_ACCOUNT_CONCURRENCY).contains(&limit) {
        return Err(format!(
            "ACP account max concurrency must be between {MIN_ACCOUNT_CONCURRENCY} and {MAX_ACCOUNT_CONCURRENCY}"
        ));
    }
    Ok(limit)
}

pub(super) fn validate_proxy_url(proxy: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = proxy else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() > 512
        || trimmed
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace())
    {
        return Err(
            "Enter a valid proxy URL (http://, https://, socks5://, socks5h://) or 'direct'"
                .into(),
        );
    }
    if trimmed.eq_ignore_ascii_case("direct") {
        return Ok(Some("direct".into()));
    }
    let lower = trimmed.to_ascii_lowercase();
    let valid_scheme = ["http://", "https://", "socks5://", "socks5h://", "socks4://"]
        .iter()
        .any(|prefix| lower.starts_with(prefix) && trimmed.len() > prefix.len());
    if !valid_scheme {
        return Err(
            "Enter a valid proxy URL (http://, https://, socks5://, socks5h://) or 'direct'"
                .into(),
        );
    }
    Ok(Some(trimmed.to_string()))
}

pub(super) fn resolve_proxy(account_proxy: Option<&str>, global_proxy: &str) -> String {
    match account_proxy.map(str::trim).filter(|p| !p.is_empty()) {
        None => global_proxy.to_string(),
        Some(proxy) if proxy.eq_ignore_ascii_case("direct") => String::new(),
        Some(proxy) => proxy.to_string(),
    }
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
        // A Windows drive/UNC prefix on its own is not a complete filesystem
        // path. Inspect the root only after its RootDir component is present.
        if matches!(component, std::path::Component::Prefix(_)) {
            continue;
        }
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if unsafe_path_metadata(&metadata) => {
                return Err("ACP account paths must not contain symbolic links".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Cannot inspect ACP account path: {error}")),
        }
    }
    Ok(())
}

fn unsafe_path_metadata(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const REPARSE_POINT: u32 = 0x400;
        return metadata.file_attributes() & REPARSE_POINT != 0;
    }
    #[cfg(not(windows))]
    metadata.file_type().is_symlink()
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
        || registry.accounts.len() > MAX_ACCOUNTS
        || registry.accounts.iter().any(|account| {
            !valid_id(&account.id)
                || !ids.insert(account.id.clone())
                || validate_label(&account.label).is_err()
                || validate_weight(account.weight).is_err()
                || validate_max_concurrency(account.max_concurrency).is_err()
                || validate_proxy_url(account.proxy_url.as_deref()).is_err()
        })
        || !ids.contains(&registry.active)
    {
        return Err("Invalid ACP account registry".into());
    }
    // Keep all labels and optional proxy overrides normalized after legacy migration.
    for account in &mut registry.accounts {
        account.label = account.label.trim().into();
        account.proxy_url = validate_proxy_url(account.proxy_url.as_deref())?;
    }
    Ok(registry)
}

pub(super) fn random_id() -> Result<String, String> {
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

pub(super) fn get(root: &Path, id: &str) -> Result<Account, String> {
    read(root)?
        .accounts
        .into_iter()
        .find(|account| account.id == id)
        .ok_or_else(|| "Unknown ACP account".into())
}

pub(super) fn set_active_email(root: &Path, email: Option<String>) -> Result<(), String> {
    let active = read(root)?.active;
    set_email(root, &active, email)
}

pub(super) fn set_email(root: &Path, id: &str, email: Option<String>) -> Result<(), String> {
    let mut registry = read(root)?;
    let account = registry
        .accounts
        .iter_mut()
        .find(|account| account.id == id)
        .ok_or("Unknown ACP account")?;
    account.email = email;
    write(root, &registry)
}

pub(super) fn recoveries_path(root: &Path) -> PathBuf {
    root.join("removed-accounts")
}

pub(super) fn mark_saved(root: &Path) -> Result<(), String> {
    let active = read(root)?.active;
    mark_saved_by_id(root, &active)
}

pub(super) fn mark_saved_by_id(root: &Path, id: &str) -> Result<(), String> {
    let mut registry = read(root)?;
    registry
        .accounts
        .iter_mut()
        .find(|account| account.id == id)
        .ok_or("Unknown ACP account")?
        .saved = true;
    write(root, &registry)
}

fn account_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
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

pub(super) const ISOLATED_HOME: &str = "isolated-home";

pub(super) fn directory(root: &Path, id: &str) -> Result<PathBuf, String> {
    let mut path = account_dir(root, id)?;
    if read(root)?
        .accounts
        .iter()
        .any(|account| account.id == id && account.isolated)
    {
        if id == "default" {
            return Err("Invalid isolated ACP account".into());
        }
        path.push(ISOLATED_HOME);
        safe_path(&path)?;
    }
    Ok(path)
}

pub(super) fn is_isolated_home(path: &Path) -> bool {
    path.file_name().is_some_and(|name| name == ISOLATED_HOME)
        && path
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            .is_some_and(|id| id != "default" && valid_id(id))
        && path
            .parent()
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .is_some_and(|name| name == "accounts")
}

pub(super) fn isolated_token(home: &Path) -> PathBuf {
    home.join(".gemini/antigravity-cli/antigravity-oauth-token")
}

pub(super) fn require_isolated_token(home: &Path) -> Result<(), String> {
    let home = checked_isolated_home(home)?;
    if !std::fs::metadata(isolated_token(&home)).is_ok_and(|file| file.is_file() && file.len() > 0)
    {
        return Err(
            "Antigravity CLI did not save authorization in the isolated ACP profile".into(),
        );
    }
    Ok(())
}

// An isolated, saved account can be considered for another concurrent API
// slot only while its own credential file is present. This is a read-only
// eligibility check; rpc::command revalidates the profile when spawning.
pub(super) fn pool_profile(root: &Path, account: &Account) -> Option<PathBuf> {
    if !account.saved || !account.isolated || account.id == "default" {
        return None;
    }
    let home = account_dir(root, &account.id).ok()?.join(ISOLATED_HOME);
    let token = isolated_token(&home);
    safe_path(&token).ok()?;
    let metadata = std::fs::symlink_metadata(token).ok()?;
    if !metadata.is_file() || metadata.len() == 0 {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return None;
        }
    }
    Some(home)
}

// Resolve a read-only pool profile path for any account eligible for pool routing.
// Isolated accounts require their own credential file; `default` may participate as
// the sole shared-CLI slot when saved and enabled. Non-isolated legacy secondary
// records are strictly excluded so two slots never alias the same OS HOME.
pub(super) fn route_profile(root: &Path, account: &Account) -> Option<PathBuf> {
    if !account.enabled || !account.saved {
        return None;
    }
    if account.id == "default" {
        return safe_path(root).ok().map(|_| root.to_path_buf());
    }
    pool_profile(root, account)
}

pub(super) fn checked_isolated_home(path: &Path) -> Result<PathBuf, String> {
    safe_path(path)?;
    let home = path
        .canonicalize()
        .map_err(|_| "Isolated ACP profile is unavailable")?;
    #[cfg(windows)]
    let home = {
        // canonicalize supplies Win32 verbatim syntax even for ordinary drive
        // paths. Keep the validated absolute spelling for CLI/Node shims.
        if !path.is_absolute() {
            return Err("Isolated ACP profile must be absolute".into());
        }
        safe_path(&home)?;
        path.to_path_buf()
    };
    let token = isolated_token(&home);
    safe_path(&token)?;
    match std::fs::symlink_metadata(&token) {
        Ok(metadata) if metadata.is_file() => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::{MetadataExt, PermissionsExt};
                if metadata.nlink() != 1 {
                    return Err("Unsafe isolated ACP credential file".into());
                }
                std::fs::set_permissions(&token, std::fs::Permissions::from_mode(0o600))
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(_) => return Err("Unsafe isolated ACP credential file".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    Ok(home)
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
    let patch = AccountSettingsPatch {
        label: Some(label.to_string()),
        ..Default::default()
    };
    update_settings(root, id, &patch).map(|_| ())
}

pub(super) fn update_settings(
    root: &Path,
    id: &str,
    patch: &AccountSettingsPatch,
) -> Result<Account, String> {
    let next_label = patch
        .label
        .as_deref()
        .map(validate_label)
        .transpose()?
        .map(str::to_owned);
    let next_weight = patch.weight.map(validate_weight).transpose()?;
    let next_concurrency = patch
        .max_concurrency
        .map(validate_max_concurrency)
        .transpose()?;
    let next_proxy = match patch.proxy_url.as_deref() {
        Some(raw) => Some(validate_proxy_url(Some(raw))?),
        None => None,
    };
    let mut registry = read(root)?;
    let updated = {
        let account = registry
            .accounts
            .iter_mut()
            .find(|account| account.id == id)
            .ok_or("Unknown ACP account")?;
        if let Some(label) = next_label {
            account.label = label;
        }
        if let Some(enabled) = patch.enabled {
            account.enabled = enabled;
        }
        if let Some(priority) = patch.priority {
            account.priority = priority;
        }
        if let Some(weight) = next_weight {
            account.weight = weight;
        }
        if let Some(limit) = next_concurrency {
            account.max_concurrency = limit;
        }
        if let Some(proxy) = next_proxy {
            account.proxy_url = proxy;
        }
        account.clone()
    };
    write(root, &registry)?;
    Ok(updated)
}

pub(super) const DUPLICATE_EMAIL: &str = "This Google account is already saved. Add a different Google account, or select the existing account";
pub(super) const IDENTITY_UNKNOWN: &str =
    "Google identity could not be verified against saved accounts. The account was not added";

// Do not publish a provisional record before official authentication and the
// duplicate check. Cancelled/failed attempts are isolated, never destroyed.
pub(super) struct PendingAccount {
    root: PathBuf,
    pub(super) id: String,
    label: String,
    finished: bool,
    isolated: bool,
}

impl PendingAccount {
    #[cfg(test)]
    pub(super) fn new(root: &Path, label: &str) -> Result<Self, String> {
        Self::create(root, label, false, false)
    }

    pub(super) fn new_isolated(
        root: &Path,
        label: &str,
        replacement: bool,
    ) -> Result<Self, String> {
        Self::create(root, label, true, replacement)
    }

    fn create(root: &Path, label: &str, isolated: bool, replacement: bool) -> Result<Self, String> {
        let label = validate_label(label)?.to_string();
        let registry = read(root)?;
        if !replacement
            && registry
                .accounts
                .iter()
                .filter(|a| a.saved || a.id != "default")
                .count()
                >= MAX_ACCOUNTS
        {
            return Err(format!("Up to {MAX_ACCOUNTS} ACP accounts can be saved"));
        }
        let id = random_id()?;
        let path = account_dir(root, &id)?;
        if path.exists() {
            return Err("ACP account directory already exists".into());
        }
        prepare_profile(&path)?;
        if isolated {
            prepare_profile(&path.join(ISOLATED_HOME))?;
        }
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
            isolated,
        })
    }

    pub(super) fn directory(&self) -> Result<PathBuf, String> {
        let mut path = account_dir(&self.root, &self.id)?;
        if self.isolated {
            path.push(ISOLATED_HOME);
        }
        safe_path(&path)?;
        Ok(path)
    }

    // A known duplicate is rejected before the registry, active selection or
    // runtime changes. Preserve official success for recovery when persistence
    // fails. If identity cannot be compared, leave the registry untouched;
    // rollback moves the authorized profile to private recovery storage.
    pub(super) fn commit(&mut self, email: Option<String>) -> Result<(), String> {
        self.commit_replacing(email, None, true)
    }

    pub(super) fn commit_replacing(
        &mut self,
        email: Option<String>,
        replace: Option<&str>,
        activate: bool,
    ) -> Result<(), String> {
        let recovery_error = |error| {
            format!("Google authorization completed, but the account registry could not be saved. Login data is preserved at {}: {error}", self.root.join("accounts").join(&self.id).display())
        };
        let mut registry = match read(&self.root) {
            Ok(registry) => registry,
            Err(error) => {
                self.finished = true;
                return Err(recovery_error(error));
            }
        };
        let email = email.as_deref().and_then(rpc::valid_account_email);
        let mut comparable = !self.isolated || email.is_some();
        for account in &registry.accounts {
            if replace == Some(account.id.as_str()) {
                if account
                    .email
                    .as_deref()
                    .zip(email)
                    .is_some_and(|(expected, actual)| !expected.eq_ignore_ascii_case(actual))
                {
                    return Err(IDENTITY_UNKNOWN.into());
                }
                continue;
            }
            let existing = account
                .email
                .as_deref()
                .map(str::trim)
                .and_then(rpc::valid_account_email);
            match (existing, email) {
                (Some(existing), Some(new)) if existing.eq_ignore_ascii_case(new) => {
                    return Err(DUPLICATE_EMAIL.into());
                }
                (Some(_), Some(_)) => {}
                _ if (account.saved || account.id != "default")
                    && (!self.isolated || account.isolated) =>
                {
                    comparable = false
                }
                _ => {}
            }
        }
        if !comparable {
            return Err(IDENTITY_UNKNOWN.into());
        }
        self.finished = true;
        let previous = registry.active.clone();
        let preserved = replace.and_then(|target| {
            registry
                .accounts
                .iter()
                .find(|a| a.id == target)
                .map(|a| (a.enabled, a.priority, a.weight, a.max_concurrency, a.proxy_url.clone()))
        });
        registry.accounts.retain(|a| {
            (!activate && a.id == previous)
                || (replace != Some(a.id.as_str())
                    && (a.id != "default" || a.saved || a.email.is_some()))
        });
        let (enabled, priority, weight, max_concurrency, proxy_url) =
            preserved.unwrap_or((true, 0, 1, 1, None));
        registry.accounts.push(Account {
            id: self.id.clone(),
            label: self.label.clone(),
            email: email.map(str::to_owned),
            saved: true,
            isolated: self.isolated,
            enabled,
            priority,
            weight,
            max_concurrency,
            proxy_url,
        });
        if activate {
            registry.active = self.id.clone();
        }
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
    let source = account_dir(root, id)?;
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

pub(super) fn archive_replaced(root: &Path, id: &str) -> Result<(), String> {
    quarantine(root, id, None).map(|_| ())
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
