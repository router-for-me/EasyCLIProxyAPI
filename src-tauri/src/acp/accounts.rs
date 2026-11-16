use super::*;

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Account {
    pub(super) id: String,
    pub(super) label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) email: Option<String>,
}

#[derive(Serialize, Deserialize)]
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
            }],
        }
    }
}

fn valid_id(id: &str) -> bool {
    id == "default" || (id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

pub(super) fn read(root: &Path) -> Result<Accounts, String> {
    let registry: Accounts = match std::fs::read(root.join("accounts.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| format!("Invalid ACP account registry: {e}"))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Accounts::default(),
        Err(e) => return Err(format!("Failed to read ACP accounts: {e}")),
    };
    let mut ids = std::collections::HashSet::new();
    if registry.accounts.is_empty()
        || registry.accounts.len() > 32
        || registry.accounts.iter().any(|account| {
            !valid_id(&account.id)
                || !ids.insert(account.id.clone())
                || account.label.trim().is_empty()
                || account.label.chars().count() > 80
        })
        || !ids.contains(&registry.active)
    {
        return Err("Invalid ACP account registry".into());
    }
    Ok(registry)
}

fn write(root: &Path, registry: &Accounts) -> Result<(), String> {
    prepare_profile(root)?;
    crate::write_codex_private_file(
        &root.join("accounts.json"),
        &serde_json::to_vec(registry).map_err(|e| e.to_string())?,
    )
}

pub(super) fn set_active_email(root: &Path, email: Option<String>) -> Result<(), String> {
    let mut registry = read(root)?;
    if let Some(account) = registry
        .accounts
        .iter_mut()
        .find(|account| account.id == registry.active)
    {
        if account.email != email {
            account.email = email;
            write(root, &registry)?;
        }
    }
    Ok(())
}

pub(super) fn directory(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("Invalid ACP account ID".into());
    }
    // Preserve the existing single-account login in place. New accounts contain
    // only CLI runtime data; every account uses the same installed executable.
    Ok(if id == "default" {
        root.to_path_buf()
    } else {
        root.join("accounts").join(id)
    })
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

pub(super) fn add(root: &Path, label: &str) -> Result<String, String> {
    let label = label.trim();
    if label.is_empty() || label.chars().count() > 80 || label.chars().any(char::is_control) {
        return Err("Enter an ACP account label of 1–80 characters".into());
    }
    let mut registry = read(root)?;
    if registry.accounts.len() >= 32 {
        return Err("Up to 32 ACP accounts can be saved".into());
    }
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    let id = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    prepare_profile(&directory(root, &id)?)?;
    registry.accounts.push(Account {
        id: id.clone(),
        label: label.into(),
        email: None,
    });
    registry.active = id.clone();
    write(root, &registry)?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_metadata_is_optional_isolated_and_clearable() {
        let root = crate::unique_test_temp_path("acp-account-email");
        prepare_profile(&root).unwrap();
        std::fs::write(
            root.join("accounts.json"),
            br#"{"active":"default","accounts":[{"id":"default","label":"Default"}]}"#,
        )
        .unwrap();
        assert!(read(&root).unwrap().accounts[0].email.is_none());
        set_active_email(&root, Some("personal@example.test".into())).unwrap();
        let id = add(&root, "Work").unwrap();
        set_active_email(&root, Some("work@example.test".into())).unwrap();
        let registry = read(&root).unwrap();
        assert_eq!(
            registry.accounts[0].email.as_deref(),
            Some("personal@example.test")
        );
        assert_eq!(
            registry.accounts[1].email.as_deref(),
            Some("work@example.test")
        );
        assert_eq!(registry.accounts[1].id, id);
        set_active_email(&root, None).unwrap();
        assert!(read(&root).unwrap().accounts[1].email.is_none());
        assert_eq!(
            read(&root).unwrap().accounts[0].email.as_deref(),
            Some("personal@example.test")
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn saved_accounts_share_executable_but_keep_separate_login_and_model_files() {
        let root = crate::unique_test_temp_path("acp-accounts");
        prepare_profile(&root).unwrap();
        std::fs::write(root.join("existing-login-marker"), "original").unwrap();
        assert_eq!(active(&root).unwrap(), root);
        let id = add(&root, "Work").unwrap();
        let second = active(&root).unwrap();
        assert_ne!(second, root);
        assert!(!second.join("existing-login-marker").exists());
        std::fs::write(selected_path(&second), br#""work-model""#).unwrap();
        select(&root, "default").unwrap();
        assert_eq!(active(&root).unwrap(), root);
        assert_eq!(read_selected(&root).unwrap(), "");
        select(&root, &id).unwrap();
        assert_eq!(
            read_selected(&active(&root).unwrap()).unwrap(),
            "work-model"
        );
        assert_eq!(read(&root).unwrap().accounts.len(), 2);
        assert!(select(&root, "../outside").is_err());
        assert!(directory(&root, "../outside").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
