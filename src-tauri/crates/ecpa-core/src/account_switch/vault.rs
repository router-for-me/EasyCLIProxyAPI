use super::crypto::{
    decrypt_envelope, encrypt_envelope, load_or_create_vault_key, write_atomic_secure,
};
use super::types::{
    now_millis, AccountGroup, AccountMetaPatch, AccountRecord, AccountSummary, GroupAction,
    QuotaSnapshot, SwitchPlatformId,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static VAULT_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultIndexFile {
    version: u32,
    accounts: Vec<AccountSummary>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupsFile {
    version: u32,
    groups: Vec<AccountGroup>,
}

pub(crate) struct AccountVault {
    root: PathBuf,
}

impl AccountVault {
    pub(crate) fn open_default() -> Result<Self, String> {
        let root = crate::core_base_dir()?.join("account-switch");
        Self::for_root(root)
    }

    pub(crate) fn for_root(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&root).map_err(|error| {
            format!(
                "Failed to initialize account switch vault {}: {error}",
                root.display()
            )
        })?;
        let vault = Self { root };
        vault.ensure_state_db()?;
        Ok(vault)
    }

    pub(crate) fn root_dir(&self) -> &Path {
        &self.root
    }

    fn key_path(&self) -> PathBuf {
        self.root.join("vault.key")
    }

    fn index_path(&self) -> PathBuf {
        self.root.join("index.json")
    }

    fn groups_path(&self) -> PathBuf {
        self.root.join("groups.json")
    }

    fn state_db_path(&self) -> PathBuf {
        self.root.join("state.sqlite")
    }

    pub(crate) fn snapshots_dir(&self, platform: SwitchPlatformId, account_id: &str) -> PathBuf {
        self.root
            .join("snapshots")
            .join(platform.as_str())
            .join(account_id)
    }

    fn account_dir(&self, platform: SwitchPlatformId) -> PathBuf {
        self.root.join("accounts").join(platform.as_str())
    }

    fn account_file_path(&self, platform: SwitchPlatformId, account_id: &str) -> PathBuf {
        self.account_dir(platform).join(format!("{account_id}.enc"))
    }

    fn load_key(&self) -> Result<[u8; 32], String> {
        load_or_create_vault_key(&self.key_path())
    }

    fn open_state_db(&self) -> Result<Connection, String> {
        let conn = Connection::open(self.state_db_path())
            .map_err(|error| format!("Failed to open account switch state database: {error}"))?;
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        let _ = conn.pragma_update(None, "synchronous", "NORMAL");
        Ok(conn)
    }

    fn ensure_state_db(&self) -> Result<(), String> {
        let conn = self.open_state_db()?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS current_account (
                platform TEXT PRIMARY KEY,
                account_id TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS switch_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                platform TEXT NOT NULL,
                account_id TEXT NOT NULL,
                decoupled_proxy INTEGER NOT NULL DEFAULT 0,
                switched_at INTEGER NOT NULL
            );",
        )
        .map_err(|error| format!("Failed to initialize account switch schema: {error}"))?;
        Ok(())
    }

    pub(crate) fn get_active_account_id(
        &self,
        platform: SwitchPlatformId,
    ) -> Result<Option<String>, String> {
        let conn = self.open_state_db()?;
        conn.query_row(
            "SELECT account_id FROM current_account WHERE platform = ?1",
            params![platform.as_str()],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Failed to query active account: {error}"))
    }

    pub(crate) fn get_all_active_account_ids(&self) -> Result<HashMap<String, String>, String> {
        let conn = self.open_state_db()?;
        let mut stmt = conn
            .prepare("SELECT platform, account_id FROM current_account")
            .map_err(|error| format!("Failed to query active accounts: {error}"))?;
        let mut rows = stmt
            .query([])
            .map_err(|error| format!("Failed to read active accounts: {error}"))?;
        let mut result = HashMap::new();
        while let Some(row) = rows
            .next()
            .map_err(|error| format!("Failed to iterate active accounts: {error}"))?
        {
            let platform: String = row.get(0).map_err(|e| e.to_string())?;
            let account_id: String = row.get(1).map_err(|e| e.to_string())?;
            result.insert(platform, account_id);
        }
        Ok(result)
    }

    pub(crate) fn set_active_account_id(
        &self,
        platform: SwitchPlatformId,
        account_id: &str,
        decoupled_proxy: bool,
    ) -> Result<(), String> {
        let _guard = VAULT_LOCK
            .lock()
            .map_err(|_| "Account vault lock poisoned".to_string())?;
        let conn = self.open_state_db()?;
        let ts = now_millis();
        conn.execute(
            "INSERT INTO current_account (platform, account_id, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(platform) DO UPDATE SET account_id = excluded.account_id, updated_at = excluded.updated_at",
            params![platform.as_str(), account_id, ts],
        )
        .map_err(|error| format!("Failed to persist active account: {error}"))?;
        let _ = conn.execute(
            "INSERT INTO switch_history (platform, account_id, decoupled_proxy, switched_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![platform.as_str(), account_id, if decoupled_proxy { 1 } else { 0 }, ts],
        );
        Ok(())
    }

    pub(crate) fn clear_active_account_if_matches(
        &self,
        platform: SwitchPlatformId,
        account_ids: &[String],
    ) -> Result<(), String> {
        if account_ids.is_empty() {
            return Ok(());
        }
        let current = self.get_active_account_id(platform)?;
        if let Some(current_id) = current {
            if account_ids.iter().any(|id| id == &current_id) {
                let conn = self.open_state_db()?;
                conn.execute(
                    "DELETE FROM current_account WHERE platform = ?1",
                    params![platform.as_str()],
                )
                .map_err(|error| format!("Failed to clear active account: {error}"))?;
            }
        }
        Ok(())
    }

    fn write_record_unlocked(&self, record: &AccountRecord) -> Result<(), String> {
        let key = self.load_key()?;
        let json = serde_json::to_vec_pretty(record)
            .map_err(|error| format!("Failed to serialize account record: {error}"))?;
        let aad = format!("{}:{}", record.platform.as_str(), record.id);
        let envelope = encrypt_envelope(&key, &json, Some(aad.as_bytes()))?;
        let path = self.account_file_path(record.platform, &record.id);
        write_atomic_secure(&path, envelope.as_bytes())
    }

    fn read_record_file(
        &self,
        key: &[u8; 32],
        platform: SwitchPlatformId,
        path: &Path,
    ) -> Result<AccountRecord, String> {
        let raw = fs::read_to_string(path)
            .map_err(|error| format!("Failed to read account file {}: {error}", path.display()))?;
        let stem = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        let aad = format!("{}:{stem}", platform.as_str());
        let (bytes, was_encrypted) = decrypt_envelope(key, &raw, Some(aad.as_bytes()))?;
        let record: AccountRecord = serde_json::from_slice(&bytes)
            .map_err(|error| format!("Invalid account JSON {}: {error}", path.display()))?;
        if !was_encrypted {
            let _ = self.write_record_unlocked(&record);
        }
        Ok(record)
    }

    pub(crate) fn load_record(
        &self,
        platform: SwitchPlatformId,
        account_id: &str,
    ) -> Result<Option<AccountRecord>, String> {
        let path = self.account_file_path(platform, account_id);
        if !path.is_file() {
            return Ok(None);
        }
        let key = self.load_key()?;
        self.read_record_file(&key, platform, &path).map(Some)
    }

    pub(crate) fn list_records(
        &self,
        platform: SwitchPlatformId,
    ) -> Result<Vec<AccountRecord>, String> {
        let dir = self.account_dir(platform);
        if !dir.is_dir() {
            return Ok(Vec::new());
        }
        let key = self.load_key()?;
        let mut records = Vec::new();
        let entries = fs::read_dir(&dir).map_err(|error| {
            format!(
                "Failed to list platform accounts {}: {error}",
                dir.display()
            )
        })?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("enc") {
                continue;
            }
            if let Ok(record) = self.read_record_file(&key, platform, &path) {
                records.push(record);
            }
        }
        records.sort_by(|a, b| {
            b.last_used_at
                .unwrap_or(0)
                .cmp(&a.last_used_at.unwrap_or(0))
                .then_with(|| b.updated_at.cmp(&a.updated_at))
                .then_with(|| a.label.to_lowercase().cmp(&b.label.to_lowercase()))
        });
        Ok(records)
    }

    #[allow(dead_code)]
    pub(crate) fn list_summaries(
        &self,
        platform: SwitchPlatformId,
    ) -> Result<Vec<AccountSummary>, String> {
        let active_id = self.get_active_account_id(platform)?;
        let records = self.list_records(platform)?;
        Ok(records
            .iter()
            .map(|record| record.to_summary(active_id.as_deref()))
            .collect())
    }

    fn rebuild_index_unlocked(&self) -> Result<(), String> {
        let actives = self.get_all_active_account_ids().unwrap_or_default();
        let mut summaries = Vec::new();
        for platform in SwitchPlatformId::ALL {
            let active_id = actives.get(platform.as_str()).map(String::as_str);
            if let Ok(records) = self.list_records(platform) {
                for record in records {
                    summaries.push(record.to_summary(active_id));
                }
            }
        }
        let payload = VaultIndexFile {
            version: 1,
            accounts: summaries,
        };
        let bytes = serde_json::to_vec_pretty(&payload)
            .map_err(|error| format!("Failed to serialize vault index: {error}"))?;
        write_atomic_secure(&self.index_path(), &bytes)
    }

    /// Upsert by exact ID or matching fingerprint on the same platform.
    /// Returns `(saved_record, is_new)`.
    pub(crate) fn upsert_record(
        &self,
        mut incoming: AccountRecord,
    ) -> Result<(AccountRecord, bool), String> {
        let _guard = VAULT_LOCK
            .lock()
            .map_err(|_| "Account vault lock poisoned".to_string())?;
        let existing_list = self.list_records(incoming.platform)?;
        let matched = existing_list.into_iter().find(|existing| {
            existing.id == incoming.id
                || (!incoming.fingerprint.is_empty() && existing.fingerprint == incoming.fingerprint)
        });

        let now = now_millis();
        let (record, is_new) = if let Some(mut existing) = matched {
            existing.updated_at = now;
            if !incoming.label.trim().is_empty() && existing.label.trim().is_empty() {
                existing.label = incoming.label;
            } else if !incoming.label.trim().is_empty()
                && existing.label == existing.account_id.clone().unwrap_or_default()
            {
                existing.label = incoming.label;
            }
            if incoming.email.is_some() {
                existing.email = incoming.email;
            }
            if incoming.account_id.is_some() {
                existing.account_id = incoming.account_id;
            }
            if incoming.plan_type.is_some() {
                existing.plan_type = incoming.plan_type;
            }
            if incoming.last_quota.is_some() {
                existing.last_quota = incoming.last_quota;
            }
            // Merge non-empty credentials while keeping existing refresh token & plan expiry if omitted.
            let old_refresh = existing.credentials.refresh_token.clone();
            let old_plan_exp = existing.credentials.plan_expires_at;
            let old_extra = existing.credentials.extra.clone();
            existing.credentials = incoming.credentials;
            if existing
                .credentials
                .refresh_token
                .as_deref()
                .is_none_or(|value| value.trim().is_empty())
            {
                existing.credentials.refresh_token = old_refresh;
            }
            if existing.credentials.plan_expires_at.is_none() {
                existing.credentials.plan_expires_at = old_plan_exp;
            }
            for (k, v) in old_extra {
                existing.credentials.extra.entry(k).or_insert(v);
            }
            for tag in incoming.tags {
                if !existing.tags.contains(&tag) {
                    existing.tags.push(tag);
                }
            }
            (existing, false)
        } else {
            if incoming.id.trim().is_empty() {
                incoming.id = uuid::Uuid::new_v4().to_string();
            }
            if incoming.created_at == 0 {
                incoming.created_at = now;
            }
            incoming.updated_at = now;
            (incoming, true)
        };

        self.write_record_unlocked(&record)?;
        let _ = self.rebuild_index_unlocked();
        Ok((record, is_new))
    }

    pub(crate) fn save_record(&self, mut record: AccountRecord) -> Result<AccountRecord, String> {
        let _guard = VAULT_LOCK
            .lock()
            .map_err(|_| "Account vault lock poisoned".to_string())?;
        record.updated_at = now_millis();
        self.write_record_unlocked(&record)?;
        let _ = self.rebuild_index_unlocked();
        Ok(record)
    }

    pub(crate) fn update_quota(
        &self,
        platform: SwitchPlatformId,
        account_id: &str,
        quota: QuotaSnapshot,
    ) -> Result<AccountRecord, String> {
        let _guard = VAULT_LOCK
            .lock()
            .map_err(|_| "Account vault lock poisoned".to_string())?;
        let mut record = self
            .load_record(platform, account_id)?
            .ok_or_else(|| format!("Account not found: {account_id}"))?;
        if let Some(plan) = quota.plan.clone().filter(|value| !value.trim().is_empty()) {
            record.plan_type = Some(plan);
        }
        if let Some(plan_exp) = quota.plan_expires_at {
            record.credentials.plan_expires_at = Some(plan_exp);
        }
        record.last_quota = Some(quota);
        record.updated_at = now_millis();
        self.write_record_unlocked(&record)?;
        let _ = self.rebuild_index_unlocked();
        Ok(record)
    }

    pub(crate) fn update_meta(
        &self,
        platform: SwitchPlatformId,
        account_id: &str,
        patch: AccountMetaPatch,
    ) -> Result<AccountSummary, String> {
        let _guard = VAULT_LOCK
            .lock()
            .map_err(|_| "Account vault lock poisoned".to_string())?;
        let mut record = self
            .load_record(platform, account_id)?
            .ok_or_else(|| format!("Account not found: {account_id}"))?;
        if let Some(label) = patch.label {
            let trimmed = label.trim();
            if !trimmed.is_empty() {
                record.label = trimmed.to_string();
            }
        }
        if let Some(notes) = patch.notes {
            record.notes = notes.and_then(|value| {
                let trimmed = value.trim().to_string();
                (!trimmed.is_empty()).then_some(trimmed)
            });
        }
        if let Some(group_id) = patch.group_id {
            record.group_id = group_id.and_then(|value| {
                let trimmed = value.trim().to_string();
                (!trimmed.is_empty()).then_some(trimmed)
            });
        }
        if let Some(tags) = patch.tags {
            let mut normalized = Vec::new();
            for tag in tags {
                let trimmed = tag.trim().to_string();
                if !trimmed.is_empty() && !normalized.contains(&trimmed) {
                    normalized.push(trimmed);
                }
            }
            record.tags = normalized;
        }
        record.updated_at = now_millis();
        self.write_record_unlocked(&record)?;
        let _ = self.rebuild_index_unlocked();
        let active_id = self.get_active_account_id(platform)?;
        Ok(record.to_summary(active_id.as_deref()))
    }

    pub(crate) fn delete_accounts(
        &self,
        platform: SwitchPlatformId,
        account_ids: &[String],
    ) -> Result<usize, String> {
        let _guard = VAULT_LOCK
            .lock()
            .map_err(|_| "Account vault lock poisoned".to_string())?;
        let mut deleted = 0usize;
        for account_id in account_ids {
            let path = self.account_file_path(platform, account_id);
            if path.is_file() {
                fs::remove_file(&path).map_err(|error| {
                    format!("Failed to delete account file {}: {error}", path.display())
                })?;
                deleted += 1;
            }
            let snap_dir = self.snapshots_dir(platform, account_id);
            if snap_dir.is_dir() {
                let _ = fs::remove_dir_all(&snap_dir);
            }
        }
        let _ = self.clear_active_account_if_matches(platform, account_ids);
        let _ = self.rebuild_index_unlocked();
        Ok(deleted)
    }

    pub(crate) fn list_groups(&self) -> Result<Vec<AccountGroup>, String> {
        let path = self.groups_path();
        if !path.is_file() {
            return Ok(Vec::new());
        }
        let raw = fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read groups file: {error}"))?;
        let mut file: GroupsFile = serde_json::from_str(&raw)
            .map_err(|error| format!("Invalid groups JSON: {error}"))?;
        file.groups.sort_by_key(|group| group.order);
        Ok(file.groups)
    }

    pub(crate) fn manage_groups(&self, action: GroupAction) -> Result<Vec<AccountGroup>, String> {
        let _guard = VAULT_LOCK
            .lock()
            .map_err(|_| "Account vault lock poisoned".to_string())?;
        let mut groups = self.list_groups().unwrap_or_default();
        match action.action.as_str() {
            "create" => {
                let name = action
                    .name
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or("Group name cannot be empty")?
                    .to_string();
                let next_order = groups.iter().map(|g| g.order).max().unwrap_or(-1) + 1;
                groups.push(AccountGroup {
                    id: uuid::Uuid::new_v4().to_string(),
                    name,
                    color: action.color.flatten(),
                    order: next_order,
                });
            }
            "rename" | "update" => {
                let id = action.id.as_deref().ok_or("Group id is required")?;
                let group = groups
                    .iter_mut()
                    .find(|g| g.id == id)
                    .ok_or("Group not found")?;
                if let Some(name) = action
                    .name
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    group.name = name.to_string();
                }
                if let Some(color) = action.color {
                    group.color = color;
                }
            }
            "delete" => {
                let id = action.id.as_deref().ok_or("Group id is required")?;
                groups.retain(|g| g.id != id);
                // Detach deleted group from existing accounts cleanly.
                for platform in SwitchPlatformId::ALL {
                    if let Ok(records) = self.list_records(platform) {
                        for mut record in records {
                            if record.group_id.as_deref() == Some(id) {
                                record.group_id = None;
                                record.updated_at = now_millis();
                                let _ = self.write_record_unlocked(&record);
                            }
                        }
                    }
                }
                let _ = self.rebuild_index_unlocked();
            }
            "reorder" => {
                if let Some(order) = action.order {
                    for (idx, id) in order.iter().enumerate() {
                        if let Some(group) = groups.iter_mut().find(|g| g.id == *id) {
                            group.order = idx as i32;
                        }
                    }
                    groups.sort_by_key(|g| g.order);
                }
            }
            other => return Err(format!("Unknown group action: {other}")),
        }
        let payload = GroupsFile {
            version: 1,
            groups: groups.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&payload)
            .map_err(|error| format!("Failed to serialize groups: {error}"))?;
        write_atomic_secure(&self.groups_path(), &bytes)?;
        Ok(groups)
    }
}
