use super::*;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

type Profile = Map<String, Value>;

static HARNESS_SCHEMA: std::sync::LazyLock<Value> = std::sync::LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../src/services/deepSeekHarnessSchema.json"
    ))
    .unwrap()
});

pub(crate) fn harness_fields(group: &str) -> impl Iterator<Item = &str> {
    HARNESS_SCHEMA[group]
        .as_array()
        .unwrap()
        .iter()
        .map(|field| field["name"].as_str().unwrap())
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct DeepSeekHarnessCatalogState {
    models: BTreeMap<String, Profile>,
    provider: Profile,
    generated_models: BTreeMap<String, Profile>,
    generated_provider: Option<Profile>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct HarnessEditorModel {
    pub id: String,
    pub defaults: Profile,
    pub configuration: Profile,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessEditorSnapshot {
    pub revision: String,
    pub models: Vec<HarnessEditorModel>,
    pub provider: Profile,
    base_url: String,
    default_model: Option<String>,
    configured: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct HarnessEditorRequest {
    pub revision: String,
    pub models: Vec<HarnessEditorModel>,
    pub provider: Profile,
}

fn read_harness_state(bytes: Option<&[u8]>) -> Result<DeepSeekHarnessCatalogState, String> {
    bytes
        .map(|bytes| {
            serde_json::from_slice(bytes)
                .map_err(|_| "读取 DSH 模型配置状态失败，请检查 catalog-state.json".into())
        })
        .unwrap_or_else(|| Ok(Default::default()))
}

fn harness_provider(root: &Value) -> Option<&Value> {
    root.get("llm-pi-ai")?
        .get("providers")?
        .get(DEEPSEEK_HARNESS_PROVIDER_ID)
}

fn harness_root(existing: Option<&str>) -> Result<Value, String> {
    serde_json::to_value(parse_agent_yaml_mapping(
        existing,
        "DeepSeek Harness settings",
    )?)
    .map_err(|_| "DSH settings 必须是有效的配置映射".into())
}

fn selected_fields(value: &Value, group: &str) -> Profile {
    harness_fields(group)
        .filter_map(|key| value.get(key).map(|value| (key.into(), value.clone())))
        .collect()
}

fn import_changes(
    current: &Profile,
    generated: Option<&Profile>,
    overrides: &mut Profile,
    group: &str,
) {
    for key in harness_fields(group) {
        let current = current.get(key);
        let previous = generated.and_then(|fields| fields.get(key));
        if current != previous {
            if let Some(value) = current {
                overrides.insert(key.into(), value.clone());
            } else {
                overrides.remove(key);
            }
        }
    }
}

fn import_harness_configuration(root: &Value, state: &mut DeepSeekHarnessCatalogState) {
    let Some(provider) = harness_provider(root) else {
        return;
    };
    import_changes(
        &selected_fields(provider, "provider"),
        state.generated_provider.as_ref(),
        &mut state.provider,
        "provider",
    );
    if let Some(models) = provider.get("models").and_then(Value::as_array) {
        for model in models {
            if let Some(id) = model.get("id").and_then(Value::as_str) {
                import_changes(
                    &selected_fields(model, "model"),
                    state.generated_models.get(id),
                    state.models.entry(id.into()).or_default(),
                    "model",
                );
            }
        }
    }
    state.models.retain(|_, profile| !profile.is_empty());
}

pub(crate) fn harness_api_metadata(item: &Value) -> Option<Value> {
    let mut fields = Profile::new();
    for (field, keys) in [
        (
            "maxTokens",
            &[
                "maxTokens",
                "max_tokens",
                "max_output_tokens",
                "maxOutputTokens",
            ][..],
        ),
        (
            "reasoningEfforts",
            &["reasoningEfforts", "reasoning_efforts"][..],
        ),
        ("compat", &["compat"][..]),
    ] {
        if let Some(value) = keys.iter().find_map(|key| item.get(key)) {
            let definition = HARNESS_SCHEMA["model"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["name"] == field)
                .unwrap();
            if validate_harness_field(value, definition, "", field).is_ok() {
                fields.insert(field.into(), value.clone());
            }
        }
    }
    (!fields.is_empty()).then_some(Value::Object(fields))
}

fn harness_model_defaults(model: &AgentModelOption, api: &str) -> Profile {
    let mut fields = model
        .harness_metadata
        .as_ref()
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(compat) = fields.get_mut("compat").and_then(Value::as_object_mut) {
        compat.retain(|key, _| {
            HARNESS_SCHEMA["compat"]
                .as_array()
                .unwrap()
                .iter()
                .find(|field| field["name"] == key.as_str())
                .is_some_and(|field| field["apis"].as_array().unwrap().contains(&json!(api)))
        });
        if compat.is_empty() {
            fields.remove("compat");
        }
    }
    if let Some(name) = &model.alias {
        fields.insert("name".into(), json!(name));
    }
    if let Some(context) = model.context_window {
        fields.insert("contextWindow".into(), json!(context));
    }
    if let Some(input) = &model.input_modalities {
        fields.insert("input".into(), json!(input));
    }
    fields
}

fn merge_profile(mut defaults: Profile, configuration: &Profile) -> Profile {
    for (key, value) in configuration {
        if key == "compat" {
            if let (Some(old), Some(new)) = (
                defaults.get_mut(key).and_then(Value::as_object_mut),
                value.as_object(),
            ) {
                old.extend(new.clone());
                continue;
            }
        }
        defaults.insert(key.clone(), value.clone());
    }
    defaults
}

pub(crate) fn validate_harness_profile(
    profile: &Profile,
    group: &str,
    api: &str,
    path: &str,
) -> Result<(), String> {
    let definitions = HARNESS_SCHEMA[group].as_array().unwrap();
    for (key, value) in profile {
        let field = definitions
            .iter()
            .find(|field| field["name"] == key.as_str())
            .ok_or_else(|| format!("{path}.{key}: 不支持的配置字段"))?;
        validate_harness_field(value, field, api, &format!("{path}.{key}"))?;
    }
    for field in definitions {
        if field["required"] == true && !profile.contains_key(field["name"].as_str().unwrap()) {
            return Err(format!(
                "{path}.{}: 必须填写",
                field["name"].as_str().unwrap()
            ));
        }
    }
    if group == "backoff"
        && profile
            .get("initialDelayMs")
            .and_then(Value::as_f64)
            .unwrap_or(500.0)
            > profile
                .get("maxDelayMs")
                .and_then(Value::as_f64)
                .unwrap_or(10000.0)
    {
        return Err(format!("{path}: initialDelayMs 不能大于 maxDelayMs"));
    }
    Ok(())
}

fn validate_harness_field(
    value: &Value,
    field: &Value,
    api: &str,
    path: &str,
) -> Result<(), String> {
    let invalid = || format!("{path}: 配置值不符合 DSH 文档要求");
    if !api.is_empty()
        && field
            .get("apis")
            .and_then(Value::as_array)
            .is_some_and(|apis| !apis.contains(&json!(api)))
    {
        return Err(format!("{path}: 不适用于 {api}，请恢复自动或选择对应协议"));
    }
    let valid = match field["kind"].as_str().unwrap() {
        "group" => {
            return validate_harness_profile(
                value.as_object().ok_or_else(invalid)?,
                field["group"].as_str().unwrap(),
                api,
                path,
            )
        }
        "string" => value.as_str().is_some_and(|value| !value.trim().is_empty()),
        "boolean" => value.is_boolean(),
        "integer" | "number" => value.as_f64().is_some_and(|n| {
            n.is_finite()
                && n.abs() <= 9007199254740991.0
                && (field["kind"] != "integer" || n.fract() == 0.0)
                && field["min"].as_f64().is_none_or(|min| n >= min)
                && field["exclusiveMin"].as_f64().is_none_or(|min| n > min)
                && field["max"].as_f64().is_none_or(|max| n <= max)
        }),
        "enum" => field["values"].as_array().unwrap().contains(value),
        "modalities" | "strings" => value.as_array().is_some_and(|values| {
            (!values.is_empty() || field["name"] == "input")
                && values.iter().enumerate().all(|(index, value)| {
                    value.as_str().is_some_and(|s| {
                        !s.trim().is_empty()
                            && (field["kind"] != "modalities" || matches!(s, "text" | "image"))
                    }) && !values[..index].contains(value)
                })
        }),
        "reasoning" => {
            value == &json!(false)
                || value.as_object().is_some_and(|values| {
                    !values.is_empty()
                        && values.iter().all(|(key, value)| {
                            ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
                                .contains(&key.as_str())
                                && ((key == "off" && value.is_null())
                                    || value.as_str().is_some_and(|s| !s.trim().is_empty()))
                        })
                })
        }
        "headers" => value.as_object().is_some_and(|values| {
            values.iter().all(|(key, value)| {
                reqwest::header::HeaderName::from_bytes(key.as_bytes()).is_ok()
                    && value.as_str().is_some_and(|s| {
                        s.chars().all(|c| (c as u32) <= 255)
                            && reqwest::header::HeaderValue::from_str(s).is_ok()
                    })
            })
        }),
        "kwargs" => value.as_object().is_some_and(|values| {
            values.values().all(|value| {
                !value.is_array()
                    && (!value.is_object()
                        || value.as_object().is_some_and(|object| {
                            object
                                .keys()
                                .all(|key| matches!(key.as_str(), "$var" | "omitWhenOff"))
                                && value["$var"].as_str().is_some_and(|s| {
                                    ["thinking.enabled", "thinking.effort", "thinking.budget"]
                                        .contains(&s)
                                })
                                && value.get("omitWhenOff").is_none_or(Value::is_boolean)
                        }))
            })
        }),
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(invalid())
    }
}

fn render_harness_profiles(
    existing: Option<&str>,
    base_url: &str,
    models: &[AgentModelOption],
    state: &mut DeepSeekHarnessCatalogState,
) -> Result<String, String> {
    let root = harness_root(existing)?;
    let old = harness_provider(&root);
    let api = state
        .provider
        .get("api")
        .and_then(Value::as_str)
        .unwrap_or("openai-completions");
    validate_harness_profile(&state.provider, "provider", api, "provider")?;
    let mut published = Vec::new();
    let mut generated = BTreeMap::new();
    for model in models {
        let profile = merge_profile(
            harness_model_defaults(model, api),
            state.models.get(&model.name).unwrap_or(&Profile::new()),
        );
        validate_harness_profile(&profile, "model", api, &model.name)?;
        let mut entry = old
            .and_then(|p| p.get("models"))
            .and_then(Value::as_array)
            .and_then(|entries| entries.iter().find(|entry| entry["id"] == model.name))
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        for key in harness_fields("model") {
            entry.remove(key);
        }
        entry.extend(profile.clone());
        entry.insert("id".into(), json!(model.name));
        generated.insert(model.name.clone(), profile);
        published.push(entry);
    }
    let mut provider = state.provider.clone();
    provider
        .entry("displayName")
        .or_insert(json!("EasyCLIProxyAPI"));
    provider.entry("api").or_insert(json!("openai-completions"));
    let rendered =
        render_agent_yaml_mapping_update(existing, "DeepSeek Harness settings", |root| {
            let managed = root
                .get_mut(yaml_key("llm-pi-ai"))
                .and_then(|v| v.get_mut("providers"))
                .and_then(|v| v.get_mut(DEEPSEEK_HARNESS_PROVIDER_ID))
                .and_then(serde_norway::Value::as_mapping_mut)
                .ok_or("DSH provider 配置缺失")?;
            managed.insert(
                yaml_key("baseURL"),
                serde_norway::Value::String(
                    if api == "anthropic-messages" {
                        base_url.trim_end_matches("/v1")
                    } else {
                        base_url
                    }
                    .into(),
                ),
            );
            for key in harness_fields("provider") {
                managed.remove(yaml_key(key));
            }
            for (key, value) in &provider {
                managed.insert(
                    yaml_key(key),
                    serde_norway::to_value(value).map_err(|_| "序列化 DSH provider 失败")?,
                );
            }
            managed.insert(
                yaml_key("models"),
                serde_norway::to_value(&published).map_err(|_| "序列化 DSH 模型失败")?,
            );
            Ok(())
        })?;
    state.generated_models = generated;
    state.generated_provider = Some(provider);
    Ok(rendered)
}

pub(crate) fn deepseek_harness_template_catalog_state(images: &Images) -> Result<Vec<u8>, String> {
    let root = harness_root(text(
        images.first().ok_or("缺少 DSH settings")?.1.as_deref(),
    )?)?;
    let mut state = DeepSeekHarnessCatalogState::default();
    if let Some(provider) = harness_provider(&root) {
        state.generated_provider = Some(selected_fields(provider, "provider"));
        if let Some(models) = provider.get("models").and_then(Value::as_array) {
            for model in models {
                if let Some(id) = model.get("id").and_then(Value::as_str) {
                    state
                        .generated_models
                        .insert(id.into(), selected_fields(model, "model"));
                }
            }
        }
    }
    serde_json::to_vec(&state).map_err(|_| "生成 DSH 模型配置状态失败".into())
}

pub(crate) fn build_deepseek_harness_catalog_settings(
    existing: Option<&str>,
    base_url: &str,
    selected: &str,
    models: &[AgentModelOption],
    state: &mut DeepSeekHarnessCatalogState,
) -> Result<String, String> {
    import_harness_configuration(&harness_root(existing)?, state);
    let ordered = ordered_agent_models(models, selected);
    let settings = render_deepseek_harness_settings(
        existing,
        base_url,
        selected,
        build_deepseek_harness_models(models, selected)?,
    )?;
    render_harness_profiles(Some(&settings), base_url, &ordered, state)
}

pub(crate) fn prepare_deepseek_harness_configuration(
    home: &Path,
    port: u16,
    api_key: &str,
    selected: &str,
    models: &[AgentModelOption],
) -> Result<(Vec<PathBuf>, Images, Images), String> {
    let mut paths = config_paths("deepseek-harness", home)?;
    paths.push(deepseek_harness_catalog_state_path(&paths)?);
    let before = config_images(&paths)?;
    let mut state = read_harness_state(before[2].1.as_deref())?;
    let settings = build_deepseek_harness_catalog_settings(
        text(before[0].1.as_deref())?,
        &format!("{}/v1", managed_core_loopback_origin(port)),
        selected,
        models,
        &mut state,
    )?;
    let updates = vec![
        AgentFileUpdate {
            path: paths[0].clone(),
            after: settings,
        },
        AgentFileUpdate {
            path: paths[1].clone(),
            after: build_deepseek_harness_credentials(text(before[1].1.as_deref())?, api_key)?,
        },
    ];
    let mut after = prepare_config_updates(
        "deepseek-harness",
        &paths[..2],
        &before[..2].to_vec(),
        &updates,
        false,
    )?;
    after.push((
        paths[2].clone(),
        Some(serde_json::to_vec(&state).map_err(|_| "生成 DSH 模型配置状态失败")?),
    ));
    Ok((paths, before, after))
}

pub(crate) fn apply_deepseek_harness_configuration(
    home: &Path,
    port: u16,
    api_key: &str,
    selected: &str,
    models: &[AgentModelOption],
) -> Result<AgentConfigActionResult, String> {
    let (paths, before, after) =
        prepare_deepseek_harness_configuration(home, port, api_key, selected, models)?;
    commit_config(
        "deepseek-harness",
        &paths,
        &before,
        &after,
        "update",
        Some(selected.into()),
    )
}

fn harness_editor_from_images(
    before: &Images,
    models: &[AgentModelOption],
    port: u16,
) -> Result<(HarnessEditorSnapshot, DeepSeekHarnessCatalogState), String> {
    let root = harness_root(text(before[0].1.as_deref())?)?;
    let mut state = read_harness_state(before[2].1.as_deref())?;
    import_harness_configuration(&root, &mut state);
    let api = state
        .provider
        .get("api")
        .and_then(Value::as_str)
        .unwrap_or("openai-completions");
    let models = models
        .iter()
        .map(|model| HarnessEditorModel {
            id: model.name.clone(),
            defaults: harness_model_defaults(model, api),
            configuration: state.models.get(&model.name).cloned().unwrap_or_default(),
        })
        .collect::<Vec<_>>();
    let base_url = format!("{}/v1", managed_core_loopback_origin(port));
    let revision = sha256_bytes(
        &serde_json::to_vec(&(image_revision(before), &models, &base_url))
            .map_err(|_| "生成 DSH 配置版本失败")?,
    );
    Ok((
        HarnessEditorSnapshot {
            revision,
            models,
            provider: state.provider.clone(),
            base_url,
            default_model: root
                .get("agent-default-model")
                .filter(|s| s["provider"] == DEEPSEEK_HARNESS_PROVIDER_ID)
                .and_then(|s| s.get("model"))
                .and_then(Value::as_str)
                .map(str::to_string),
            configured: harness_provider(&root).is_some(),
        },
        state,
    ))
}

pub(crate) fn harness_editor_snapshot(
    home: &Path,
    models: &[AgentModelOption],
    port: u16,
) -> Result<HarnessEditorSnapshot, String> {
    let mut paths = config_paths("deepseek-harness", home)?;
    paths.push(deepseek_harness_catalog_state_path(&paths)?);
    harness_editor_from_images(&config_images(&paths)?, models, port).map(|(snapshot, _)| snapshot)
}

pub(crate) fn save_harness_editor(
    home: &Path,
    models: &[AgentModelOption],
    port: u16,
    request: HarnessEditorRequest,
) -> Result<HarnessEditorSnapshot, String> {
    let mut paths = config_paths("deepseek-harness", home)?;
    paths.push(deepseek_harness_catalog_state_path(&paths)?);
    let before = config_images(&paths)?;
    let (snapshot, mut state) = harness_editor_from_images(&before, models, port)?;
    if request.revision != snapshot.revision {
        return Err("DSH_MODEL_CATALOG_CHANGED: 模型列表或配置已变化，请重新加载".into());
    }
    if request.models.len() != models.len() {
        return Err("DSH 模型列表不完整，请重新加载".into());
    }
    let mut seen = std::collections::HashSet::new();
    for model in request.models {
        if !seen.insert(model.id.clone()) || !models.iter().any(|m| m.name == model.id) {
            return Err("DSH 模型列表包含重复或不可用的 ID".into());
        }
        state.models.insert(model.id, model.configuration);
    }
    state.provider = request.provider;
    let api = state
        .provider
        .get("api")
        .and_then(Value::as_str)
        .unwrap_or("openai-completions");
    validate_harness_profile(&state.provider, "provider", api, "provider")?;
    for model in models {
        validate_harness_profile(
            &merge_profile(
                harness_model_defaults(model, api),
                &state.models[&model.name],
            ),
            "model",
            api,
            &model.name,
        )?;
    }
    let mut after = before.clone();
    if snapshot.configured {
        if snapshot
            .default_model
            .as_ref()
            .is_some_and(|id| !models.iter().any(|m| &m.name == id))
        {
            return Err("当前默认模型已不可用，请先更新默认模型".into());
        }
        let settings = render_harness_profiles(
            text(before[0].1.as_deref())?,
            &format!("{}/v1", managed_core_loopback_origin(port)),
            models,
            &mut state,
        )?;
        let updates = vec![AgentFileUpdate {
            path: paths[0].clone(),
            after: settings,
        }];
        let prepared = prepare_config_updates(
            "deepseek-harness",
            &paths[..2],
            &before[..2].to_vec(),
            &updates,
            false,
        )?;
        after[0] = prepared[0].clone();
    }
    state.models.retain(|_, profile| !profile.is_empty());
    after[2].1 = Some(serde_json::to_vec(&state).map_err(|_| "生成 DSH 模型配置状态失败")?);
    commit_config(
        "deepseek-harness",
        &paths,
        &before,
        &after,
        "catalog",
        snapshot.default_model.clone(),
    )?;
    harness_editor_snapshot(home, models, port)
}

#[tauri::command]
pub(crate) async fn get_deepseek_harness_model_catalog_editor(
    app: tauri::AppHandle,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<HarnessEditorSnapshot, String> {
    let config = gui_config_state.snapshot()?;
    let models = fetch_agent_models(config.port, effective_agent_api_key(&config)).await?;
    let home = app.path().home_dir().map_err(|_| "无法获取用户目录")?;
    let _guard = AGENT_CONFIG_FILE_LOCK
        .lock()
        .map_err(|_| "智能体配置文件锁已损坏")?;
    harness_editor_snapshot(&home, &models, config.port)
}

#[tauri::command]
pub(crate) async fn save_deepseek_harness_model_catalog_editor(
    app: tauri::AppHandle,
    gui_config_state: tauri::State<'_, GuiConfigState>,
    request: HarnessEditorRequest,
) -> Result<HarnessEditorSnapshot, String> {
    let config = gui_config_state.snapshot()?;
    let models = fetch_agent_models(config.port, effective_agent_api_key(&config)).await?;
    let home = app.path().home_dir().map_err(|_| "无法获取用户目录")?;
    let _guard = AGENT_CONFIG_FILE_LOCK
        .lock()
        .map_err(|_| "智能体配置文件锁已损坏")?;
    save_harness_editor(&home, &models, config.port, request)
}
