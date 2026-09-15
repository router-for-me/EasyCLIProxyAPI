use super::*;

#[cfg(test)]
mod tests;

pub(crate) const CODEX_NATIVE_OAUTH_STATE_FILE: &str = "cpa-native-oauth.json";
pub(crate) fn write_codex_private_file(path: &Path, content: &[u8]) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        fs::create_dir_all(path.parent().ok_or("Codex 凭据路径无效")?)
            .map_err(|_| "创建 Codex 凭据目录失败")?;
        let file = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .mode(0o600)
            .open(path)
            .map_err(|_| "无法打开 Codex 凭据文件")?;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| "设置 Codex 凭据文件权限失败")?;
    }
    write_bytes_directly(path, content)
}

const ROUTING_KEYS: &[&str] = &[
    "model_provider",
    "model",
    "model_catalog_json",
    "openai_base_url",
    "chatgpt_base_url",
    "forced_login_method",
    "profile",
];

#[derive(Default, Serialize, Deserialize)]
struct NativeOAuthState {
    version: u32,
    enabled: bool,
    cpa_settings: String,
    cpa_auth: Option<String>,
    native_auth: Option<String>,
    native_model: Option<String>,
    #[serde(default)]
    original_settings: Option<String>,
    #[serde(default)]
    original_auth: Option<String>,
    #[serde(default)]
    restore_full_routing: bool,
}

fn parse_state(bytes: Option<&[u8]>) -> Result<NativeOAuthState, String> {
    let Some(bytes) = bytes else {
        return Ok(NativeOAuthState {
            version: 1,
            ..Default::default()
        });
    };
    let state: NativeOAuthState = serde_json::from_slice(bytes)
        .map_err(|_| "无法读取 Codex 接入方式切换记录，请检查配置文件".to_string())?;
    if state.version != 1 {
        return Err("不支持的 Codex 接入方式切换记录版本".into());
    }
    Ok(state)
}

fn native_selected(document: &toml_edit::Document, state: &NativeOAuthState) -> bool {
    state.enabled
        && document
            .get("model_provider")
            .and_then(toml_edit::Item::as_str)
            == Some("openai")
        && document
            .get("forced_login_method")
            .and_then(toml_edit::Item::as_str)
            == Some("chatgpt")
}

pub(crate) fn codex_native_oauth_enabled(home: &Path) -> Result<bool, String> {
    let directory = codex_configuration_directory(home);
    let state =
        parse_state(read_agent_bytes(&directory.join(CODEX_NATIVE_OAUTH_STATE_FILE))?.as_deref())?;
    if !state.enabled {
        return Ok(false);
    }
    let content = read_optional_text(&directory.join("config.toml"))?;
    let document = parse_codex_document(content.as_deref(), "Codex config.toml")?;
    Ok(native_selected(&document, &state))
}

pub(crate) fn ensure_codex_cpa_mode(home: &Path) -> Result<(), String> {
    if codex_native_oauth_enabled(home)? {
        return Err("请点击“更新配置”或“一键接入”恢复 CPA 配置".into());
    }
    Ok(())
}

// Save only the settings changed by this switch. Other user edits survive both directions.
fn routing_settings(document: &toml_edit::Document) -> toml_edit::Document {
    let mut saved = toml_edit::Document::new();
    for key in ROUTING_KEYS {
        restore_codex_table_item(saved.as_table_mut(), Some(document.as_table()), key);
    }
    if let Some(openai) = document
        .get("model_providers")
        .and_then(toml_edit::Item::as_table_like)
        .and_then(|table| table.get("openai"))
    {
        ensure_toml_child_table(saved.as_table_mut(), "model_providers")
            .insert("openai", openai.clone());
    }
    saved
}

fn remove_openai_override(document: &mut toml_edit::Document) {
    if let Some(providers) = document
        .get_mut("model_providers")
        .and_then(toml_edit::Item::as_table_like_mut)
    {
        providers.remove("openai");
        if providers.is_empty() {
            document.remove("model_providers");
        }
    }
}

fn oauth_auth(content: Option<&str>) -> Result<Option<String>, String> {
    let Some(content) = content else {
        return Ok(None);
    };
    let mut root = parse_agent_json_object(Some(content), "Codex auth.json")?;
    let has_tokens = root
        .get("tokens")
        .and_then(serde_json::Value::as_object)
        .is_some_and(|tokens| {
            ["access_token", "refresh_token"].iter().any(|key| {
                tokens
                    .get(*key)
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|token| !token.trim().is_empty())
            })
        });
    if !has_tokens {
        return Ok(None);
    }
    if root.get("auth_mode").and_then(serde_json::Value::as_str) == Some("chatgpt")
        && root
            .get("OPENAI_API_KEY")
            .is_none_or(serde_json::Value::is_null)
    {
        return Ok(Some(content.to_string()));
    }
    root.remove("OPENAI_API_KEY");
    root.insert("auth_mode".into(), serde_json::json!("chatgpt"));
    Ok(Some(render_agent_json(root, "Codex auth.json")?))
}

fn auth_uses_api_key(content: Option<&str>) -> Result<bool, String> {
    let root = parse_agent_json_object(content, "Codex auth.json")?;
    Ok(
        root.get("auth_mode").and_then(serde_json::Value::as_str) == Some("apikey")
            || root
                .get("OPENAI_API_KEY")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|key| !key.trim().is_empty()),
    )
}

// Restore authentication fields only; user edits to other auth.json fields survive.
fn merge_codex_auth(current: Option<&str>, source: Option<&str>) -> Result<Option<String>, String> {
    let mut root = parse_agent_json_object(current, "Codex auth.json")?;
    let original = root.clone();
    let source_content = source;
    let source = parse_agent_json_object(source, "Codex saved auth.json")?;
    for key in ["auth_mode", "OPENAI_API_KEY", "tokens", "last_refresh"] {
        root.remove(key);
        if let Some(value) = source.get(key) {
            root.insert(key.into(), value.clone());
        }
    }
    if root.is_empty() {
        return Ok(None);
    }
    if root == original {
        return Ok(current.map(str::to_string));
    }
    if root == source {
        return Ok(source_content.map(str::to_string));
    }
    Ok(Some(render_agent_json(root, "Codex auth.json")?))
}

pub(crate) fn available_codex_oauth_auth(home: &Path) -> Result<String, String> {
    let directory = codex_configuration_directory(home);
    let current = read_optional_text(&directory.join("auth.json"))?;
    if let Some(auth) = oauth_auth(current.as_deref())? {
        return Ok(auth);
    }
    // A missing/cleared auth file represents logout, not a request to reuse old tokens.
    if auth_uses_api_key(current.as_deref())? {
        let state = parse_state(
            read_agent_bytes(&directory.join(CODEX_NATIVE_OAUTH_STATE_FILE))?.as_deref(),
        )?;
        if let Some(auth) = oauth_auth(state.native_auth.as_deref())? {
            return merge_codex_auth(current.as_deref(), Some(&auth))?
                .ok_or_else(|| CODEX_OAUTH_LOGIN_REQUIRED_ERROR.to_string());
        }
    }
    Err(CODEX_OAUTH_LOGIN_REQUIRED_ERROR.to_string())
}

pub(crate) fn close_codex_configuration(home: &Path) -> Result<AgentConfigActionResult, String> {
    let directory = codex_configuration_directory(home);
    let paths = vec![
        directory.join(CODEX_NATIVE_OAUTH_STATE_FILE),
        directory.join("auth.json"),
        directory.join("config.toml"),
    ];
    let before = config_images(&paths)?;
    let mut state = parse_state(before[0].1.as_deref())?;
    let current = parse_codex_document(text(before[2].1.as_deref())?, "Codex config.toml")?;
    if current
        .get("model_provider")
        .and_then(toml_edit::Item::as_str)
        != Some(MANAGED_AGENT_PROVIDER_ID)
    {
        return Ok(action_result(
            "unchanged",
            false,
            None,
            Vec::new(),
            Vec::new(),
        ));
    }
    let original = state.original_settings.as_deref();
    let restored = build_restored_codex_agent_config(text(before[2].1.as_deref())?, original)?;
    let mut document = parse_codex_document(restored.as_deref(), "Codex restored config.toml")?;
    if let Some(original) = original {
        let saved = parse_codex_document(Some(original), "Codex saved settings")?;
        for key in ROUTING_KEYS {
            if state.restore_full_routing || *key == "forced_login_method" {
                restore_codex_table_item(document.as_table_mut(), Some(saved.as_table()), key);
            }
        }
        if state.restore_full_routing {
            remove_openai_override(&mut document);
            if let Some(openai) = saved
                .get("model_providers")
                .and_then(toml_edit::Item::as_table_like)
                .and_then(|p| p.get("openai"))
            {
                ensure_toml_child_table(document.as_table_mut(), "model_providers")
                    .insert("openai", openai.clone());
            }
        }
    } else {
        document.remove("forced_login_method");
    }
    let auth = text(before[1].1.as_deref())?;
    let next_auth = if auth_uses_api_key(state.original_auth.as_deref())? {
        merge_codex_auth(auth, state.original_auth.as_deref())?
    } else {
        let oauth = match oauth_auth(auth)? {
            Some(current) => Some(current),
            None if auth_uses_api_key(auth)? => oauth_auth(state.native_auth.as_deref())?,
            None => None,
        };
        merge_codex_auth(auth, oauth.as_deref())?
    };
    state.native_auth = oauth_auth(next_auth.as_deref())?;
    state.enabled = false;
    state.original_settings = None;
    state.original_auth = None;
    state.restore_full_routing = false;
    state.cpa_settings.clear();
    state.cpa_auth = None;
    let rendered = document.to_string();
    let after = vec![
        (
            paths[0].clone(),
            Some(serde_json::to_vec_pretty(&state).map_err(|_| "保存 Codex 切换记录失败")?),
        ),
        (paths[1].clone(), next_auth.map(String::into_bytes)),
        (
            paths[2].clone(),
            if rendered.trim().is_empty() {
                None
            } else {
                Some(rendered.into_bytes())
            },
        ),
    ];
    let mut result = commit_config("codex", &paths, &before, &after, "close", None)?;
    result.enabled = false;
    Ok(result)
}

#[tauri::command]
pub(crate) fn close_codex_config_modification(
    app: tauri::AppHandle,
) -> Result<AgentConfigActionResult, String> {
    let home = app.path().home_dir().map_err(|_| "无法获取用户目录")?;
    let _guard = AGENT_CONFIG_FILE_LOCK
        .lock()
        .map_err(|_| "智能体配置文件锁已损坏")?;
    let result = close_codex_configuration(&home)?;
    app.state::<AgentConfigStatusCache>().clear()?;
    Ok(result)
}

fn prepare_native_oauth_switch(home: &Path, enabled: bool) -> Result<(Images, Images), String> {
    let directory = codex_configuration_directory(home);
    // Persist the recovery record first, then credentials, and activate routing last.
    // The shared transaction restores all three if any write or validation fails.
    let paths = vec![
        directory.join(CODEX_NATIVE_OAUTH_STATE_FILE),
        directory.join("auth.json"),
        directory.join("config.toml"),
    ];
    let before = config_images(&paths)?;
    let mut state = parse_state(before[0].1.as_deref())?;
    let auth = text(before[1].1.as_deref())?;
    if let Some(auth) = auth {
        parse_agent_json_object(Some(auth), "Codex auth.json")?;
    }
    let mut document = parse_codex_document(text(before[2].1.as_deref())?, "Codex config.toml")?;
    let currently_native = native_selected(&document, &state);
    if !enabled && !currently_native {
        return Ok((before.clone(), before));
    }
    let next_auth = if enabled {
        if currently_native {
            state.native_model = document
                .get("model")
                .and_then(toml_edit::Item::as_str)
                .map(str::to_string);
        } else {
            state.cpa_settings = routing_settings(&document).to_string();
            state.cpa_auth = auth.map(str::to_string);
        }
        let next = match oauth_auth(auth)? {
            Some(current) => Some(current),
            None if !currently_native && auth_uses_api_key(auth)? => {
                oauth_auth(state.native_auth.as_deref())?
            }
            None => None,
        };
        for key in ROUTING_KEYS {
            document.remove(key);
        }
        remove_openai_override(&mut document);
        document["model_provider"] = toml_edit::value("openai");
        document["forced_login_method"] = toml_edit::value("chatgpt");
        if let Some(model) = state.native_model.as_deref() {
            document["model"] = toml_edit::value(model);
        }
        next
    } else {
        // Capture refreshed tokens (or a logout) every time, never reuse an older native cache.
        state.native_auth = oauth_auth(auth)?;
        state.native_model = document
            .get("model")
            .and_then(toml_edit::Item::as_str)
            .map(str::to_string);
        let saved = parse_codex_document(Some(&state.cpa_settings), "Codex CPA 接入配置")?;
        for key in ROUTING_KEYS {
            restore_codex_table_item(document.as_table_mut(), Some(saved.as_table()), key);
        }
        remove_openai_override(&mut document);
        if let Some(openai) = saved
            .get("model_providers")
            .and_then(toml_edit::Item::as_table_like)
            .and_then(|providers| providers.get("openai"))
        {
            if !document.contains_key("model_providers") {
                document["model_providers"] = toml_edit::Item::Table(toml_edit::Table::new());
            }
            document["model_providers"]
                .as_table_like_mut()
                .ok_or("Codex model_providers 格式无效")?
                .insert("openai", openai.clone());
        }
        if oauth_auth(state.cpa_auth.as_deref())?.is_some() {
            // CPA's existing OAuth mode shares the current account and its refreshed tokens.
            state.native_auth.clone()
        } else {
            state.cpa_auth.clone()
        }
    };
    state.enabled = enabled;
    let rendered = document.to_string();
    parse_codex_document(Some(&rendered), "Codex config.toml")?;
    let state_bytes =
        serde_json::to_vec_pretty(&state).map_err(|_| "保存 Codex 接入方式切换记录失败")?;
    let after = vec![
        (paths[0].clone(), Some(state_bytes)),
        (paths[1].clone(), next_auth.map(String::into_bytes)),
        (paths[2].clone(), Some(rendered.into_bytes())),
    ];
    Ok((before, after))
}

pub(crate) fn switch_codex_native_oauth(
    home: &Path,
    enabled: bool,
) -> Result<AgentConfigActionResult, String> {
    let (before, after) = prepare_native_oauth_switch(home, enabled)?;
    let paths = before
        .iter()
        .map(|(path, _)| path.clone())
        .collect::<Vec<_>>();
    commit_config("codex", &paths, &before, &after, "native-oauth", None)
}

// Save credentials and the pre-CPA routing in the same transaction as applying CPA.
// Subsequent model/auth updates retain the original routing until Close is used.
pub(crate) fn apply_codex_cpa_configuration(
    home: &Path,
    port: u16,
    api_key: &str,
    model: &str,
    options: AgentConfigurationOptions<'_>,
) -> Result<AgentConfigActionResult, String> {
    let (native_before, mut native_after) = prepare_native_oauth_switch(home, false)?;
    let mut state = parse_state(native_after[0].1.as_deref())?;
    let current_document =
        parse_codex_document(text(native_before[2].1.as_deref())?, "Codex config.toml")?;
    let auth = text(native_before[1].1.as_deref())?;
    if current_document
        .get("model_provider")
        .and_then(toml_edit::Item::as_str)
        != Some(MANAGED_AGENT_PROVIDER_ID)
    {
        state.restore_full_routing = native_selected(
            &current_document,
            &parse_state(native_before[0].1.as_deref())?,
        );
        state.original_settings = Some(routing_settings(&current_document).to_string());
        state.original_auth = auth.map(str::to_string);
    }
    if let Some(auth) = oauth_auth(auth)? {
        state.native_auth = Some(auth);
    } else if !auth_uses_api_key(auth)? {
        state.native_auth = None;
    }
    native_after[0].1 =
        Some(serde_json::to_vec_pretty(&state).map_err(|_| "保存 Codex 切换记录失败")?);
    let config_paths = config_paths("codex", home)?;
    let current = config_images(&config_paths)?;
    for image in &current {
        if native_before
            .iter()
            .any(|(path, bytes)| path == &image.0 && bytes != &image.1)
        {
            return Err("配置已被其他程序修改，请刷新后重试".into());
        }
    }
    let mut restored_config = native_after[2].clone();
    let mut restored_document =
        parse_codex_document(text(restored_config.1.as_deref())?, "Codex CPA 配置")?;
    if restored_document.contains_key("forced_login_method") {
        restored_document["forced_login_method"] =
            toml_edit::value(if options.oauth_configuration {
                "chatgpt"
            } else {
                "api"
            });
    }
    restored_config.1 = Some(restored_document.to_string().into_bytes());
    let mut baseline = current.clone();
    baseline
        .iter_mut()
        .find(|(path, _)| path == &restored_config.0)
        .ok_or("Codex 配置路径不匹配")?
        .1 = restored_config.1.clone();
    let catalog = options.codex_catalog.ok_or("无法生成 Codex 模型目录")?;
    validate_codex_catalog(catalog, model)?;
    let updates = vec![
        AgentFileUpdate {
            path: restored_config.0.clone(),
            after: build_codex_agent_config_with_oauth(
                text(restored_config.1.as_deref())?,
                &format!("{}/v1", managed_core_loopback_origin(port)),
                api_key,
                model,
                options.oauth_configuration,
            )?,
        },
        AgentFileUpdate {
            path: codex_model_catalog_path(home),
            after: catalog.to_string(),
        },
        build_codex_auth_update(home, api_key, options.oauth_configuration)?,
    ];
    let updated = prepare_config_updates("codex", &config_paths, &baseline, &updates, false)?;
    let mut before = vec![native_before[0].clone()];
    let mut after = vec![native_after[0].clone()];
    // Save refreshed OAuth credentials first and activate the CPA provider last.
    for index in [1, 2, 0] {
        before.push(current[index].clone());
        after.push(updated[index].clone());
    }
    let paths = before
        .iter()
        .map(|(path, _)| path.clone())
        .collect::<Vec<_>>();
    commit_config(
        "codex",
        &paths,
        &before,
        &after,
        "update",
        Some(model.to_string()),
    )
}

#[tauri::command]
pub(crate) fn restore_codex_official_config(
    app: tauri::AppHandle,
) -> Result<AgentConfigActionResult, String> {
    let home = app.path().home_dir().map_err(|_| "无法获取用户目录")?;
    let _guard = AGENT_CONFIG_FILE_LOCK
        .lock()
        .map_err(|_| "智能体配置文件锁已损坏")?;
    let result = switch_codex_native_oauth(&home, true)?;
    app.state::<AgentConfigStatusCache>().clear()?;
    Ok(result)
}
