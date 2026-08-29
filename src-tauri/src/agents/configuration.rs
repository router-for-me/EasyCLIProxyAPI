use super::*;

#[cfg(test)]
pub(crate) fn build_agent_updates(
    client: AgentClient,
    home: &Path,
    port: u16,
    api_key: &str,
    model: &str,
    models: &[AgentModelOption],
    codex_catalog: Option<&str>,
) -> Result<Vec<AgentFileUpdate>, String> {
    build_agent_updates_with_oauth(
        client,
        home,
        port,
        api_key,
        model,
        AgentConfigurationOptions {
            models,
            codex_catalog,
            oauth_configuration: false,
            remote_compaction: false,
            claude_code_model_mappings: None,
            claude_desktop_model_mappings: None,
        },
    )
}

pub(crate) fn build_agent_updates_with_oauth(
    client: AgentClient,
    home: &Path,
    port: u16,
    api_key: &str,
    model: &str,
    options: AgentConfigurationOptions<'_>,
) -> Result<Vec<AgentFileUpdate>, String> {
    let AgentConfigurationOptions {
        models,
        codex_catalog,
        oauth_configuration,
        remote_compaction,
        claude_code_model_mappings,
        claude_desktop_model_mappings,
    } = options;
    let paths = agent_config_paths(client, home);
    let root_base = managed_core_loopback_origin(port);
    let openai_base = format!("{root_base}/v1");
    match client {
        AgentClient::ClaudeCode => {
            let before = read_optional_text(&paths[0])?;
            let after = build_claude_agent_config(
                before.as_deref(),
                &root_base,
                api_key,
                model,
                models,
                claude_code_model_mappings,
            )
            .or_else(|_| {
                build_claude_agent_config(
                    None,
                    &root_base,
                    api_key,
                    model,
                    models,
                    claude_code_model_mappings,
                )
            })?;
            Ok(vec![AgentFileUpdate {
                path: paths[0].clone(),
                after,
            }])
        }
        AgentClient::ClaudeDesktop => {
            if paths.len() != 4 {
                return Err("Claude Desktop 当前平台配置路径不可用".to_string());
            }
            let normal_before = read_optional_text(&paths[0])?;
            let threep_before = read_optional_text(&paths[1])?;
            let profile_before = read_optional_text(&paths[2])?;
            let meta_before = read_optional_text(&paths[3])?;
            Ok(vec![
                AgentFileUpdate {
                    path: paths[0].clone(),
                    after: build_claude_desktop_deployment_config(normal_before.as_deref())
                        .or_else(|_| build_claude_desktop_deployment_config(None))?,
                },
                AgentFileUpdate {
                    path: paths[1].clone(),
                    after: build_claude_desktop_deployment_config(threep_before.as_deref())
                        .or_else(|_| build_claude_desktop_deployment_config(None))?,
                },
                AgentFileUpdate {
                    path: paths[2].clone(),
                    after: build_claude_desktop_profile(
                        profile_before.as_deref(),
                        &root_base,
                        api_key,
                        model,
                        models,
                        claude_desktop_model_mappings,
                    )
                    .or_else(|_| {
                        build_claude_desktop_profile(
                            None,
                            &root_base,
                            api_key,
                            model,
                            models,
                            claude_desktop_model_mappings,
                        )
                    })?,
                },
                AgentFileUpdate {
                    path: paths[3].clone(),
                    after: build_claude_desktop_meta(meta_before.as_deref())
                        .or_else(|_| build_claude_desktop_meta(None))?,
                },
            ])
        }
        AgentClient::Codex => {
            let before = read_optional_text(&paths[0])?;
            let after = build_codex_agent_config_with_oauth(
                before.as_deref(),
                &openai_base,
                api_key,
                model,
                oauth_configuration,
                remote_compaction,
            )
            .or_else(|_| {
                build_codex_agent_config_with_oauth(
                    None,
                    &openai_base,
                    api_key,
                    model,
                    oauth_configuration,
                    remote_compaction,
                )
            })?;
            let mut updates = vec![AgentFileUpdate {
                path: paths[0].clone(),
                after,
            }];
            let catalog = codex_catalog.ok_or_else(|| "无法生成 Codex 模型目录".to_string())?;
            validate_codex_catalog(catalog, model)?;
            updates.push(AgentFileUpdate {
                path: codex_model_catalog_path(home),
                after: catalog.to_string(),
            });
            updates.push(build_codex_auth_update(home, api_key, oauth_configuration)?);
            Ok(updates)
        }
        AgentClient::OpenCode => {
            let before = read_optional_text(&paths[0])?;
            let after = build_opencode_agent_config(
                before.as_deref(),
                &openai_base,
                api_key,
                model,
                models,
            )
            .or_else(|_| build_opencode_agent_config(None, &openai_base, api_key, model, models))?;
            Ok(vec![AgentFileUpdate {
                path: paths[0].clone(),
                after,
            }])
        }
        AgentClient::OpenClaw => {
            let before = read_optional_text(&paths[0])?;
            let after = build_openclaw_agent_config(
                before.as_deref(),
                &openai_base,
                api_key,
                model,
                models,
            )
            .or_else(|_| build_openclaw_agent_config(None, &openai_base, api_key, model, models))?;
            Ok(vec![AgentFileUpdate {
                path: paths[0].clone(),
                after,
            }])
        }
        AgentClient::Hermes => {
            let before = read_optional_text(&paths[0])?;
            let after =
                build_hermes_agent_config(before.as_deref(), &openai_base, api_key, model, models)
                    .or_else(|_| {
                        build_hermes_agent_config(None, &openai_base, api_key, model, models)
                    })?;
            Ok(vec![AgentFileUpdate {
                path: paths[0].clone(),
                after,
            }])
        }
        AgentClient::DeepSeekHarness => {
            if paths.len() != 2 {
                return Err("DeepSeek Harness 配置路径数量无效".to_string());
            }
            let settings_before = read_optional_text(&paths[0])?;
            let credentials_before = read_optional_text(&paths[1])?;
            Ok(vec![
                AgentFileUpdate {
                    path: paths[0].clone(),
                    after: build_deepseek_harness_settings(
                        settings_before.as_deref(),
                        &openai_base,
                        model,
                        models,
                    )?,
                },
                AgentFileUpdate {
                    path: paths[1].clone(),
                    after: build_deepseek_harness_credentials(
                        credentials_before.as_deref(),
                        api_key,
                    )?,
                },
            ])
        }
        AgentClient::ZCode => {
            let app_before = read_optional_text(&paths[0])?;
            let cli_before = read_optional_text(&paths[1])?;
            let app_after =
                build_zcode_agent_config(app_before.as_deref(), &root_base, api_key, model, models)
                    .or_else(|_| {
                        build_zcode_agent_config(None, &root_base, api_key, model, models)
                    })?;
            let cli_after = build_zcode_cli_agent_config(
                cli_before.as_deref(),
                &root_base,
                api_key,
                model,
                models,
            )
            .or_else(|_| build_zcode_cli_agent_config(None, &root_base, api_key, model, models))?;
            Ok(vec![
                AgentFileUpdate {
                    path: paths[0].clone(),
                    after: app_after,
                },
                AgentFileUpdate {
                    path: paths[1].clone(),
                    after: cli_after,
                },
            ])
        }
        AgentClient::KimiCode => {
            let before = read_optional_text(&paths[0])?;
            let after = build_kimi_code_agent_config(
                before.as_deref(),
                &openai_base,
                api_key,
                model,
                models,
            )
            .or_else(|_| {
                build_kimi_code_agent_config(None, &openai_base, api_key, model, models)
            })?;
            Ok(vec![AgentFileUpdate {
                path: paths[0].clone(),
                after,
            }])
        }
        AgentClient::GrokBuild => {
            let before = read_optional_text(&paths[0])?;
            let after = build_grok_build_agent_config(
                before.as_deref(),
                &openai_base,
                api_key,
                model,
                models,
            )
            .or_else(|_| {
                build_grok_build_agent_config(None, &openai_base, api_key, model, models)
            })?;
            Ok(vec![AgentFileUpdate {
                path: paths[0].clone(),
                after,
            }])
        }
    }
}

pub(crate) fn read_optional_text(path: &Path) -> Result<Option<String>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    fs::read_to_string(path)
        .map(Some)
        .map_err(|error| format!("读取配置失败 {}: {error}", path_to_string(path)))
}

pub(crate) fn read_agent_yaml_mapping_or_empty(
    path: &Path,
    label: &str,
) -> Result<serde_norway::Mapping, String> {
    if !path.is_file() {
        return Ok(serde_norway::Mapping::new());
    }
    let content = fs::read_to_string(path)
        .map_err(|error| format!("读取 {label} 失败 {}: {error}", path_to_string(path)))?;
    parse_agent_yaml_mapping(Some(&content), label)
}

pub(crate) fn parse_agent_yaml_mapping(
    content: Option<&str>,
    label: &str,
) -> Result<serde_norway::Mapping, String> {
    let Some(content) = content.map(str::trim).filter(|content| !content.is_empty()) else {
        return Ok(serde_norway::Mapping::new());
    };
    serde_norway::from_str::<serde_norway::Value>(content)
        .map_err(|error| format!("{label} YAML 格式无效: {error}"))?
        .as_mapping()
        .cloned()
        .ok_or_else(|| format!("{label} 根节点必须是 YAML 映射"))
}

pub(crate) fn render_agent_yaml_mapping_update<F>(
    existing: Option<&str>,
    label: &str,
    update: F,
) -> Result<String, String>
where
    F: FnOnce(&mut serde_norway::Mapping) -> Result<(), String>,
{
    let original_mapping = parse_agent_yaml_mapping(existing, label)?;
    let original = serde_norway::Value::Mapping(original_mapping.clone());
    let mut updated_mapping = original_mapping;
    update(&mut updated_mapping)?;
    let updated = serde_norway::Value::Mapping(updated_mapping);
    if updated == original {
        return Ok(existing.unwrap_or("{}\n").to_string());
    }
    let source = existing
        .map(str::trim)
        .filter(|content| !content.is_empty())
        .map(|_| existing.unwrap_or_default())
        .unwrap_or("{}\n");
    let mut document = yaml_serde_edit::YamlValue::parse(source)
        .map_err(|error| format!("{label} YAML 格式无效: {error}"))?;
    render_updated_core_yaml(&mut document, updated)
        .map_err(|error| format!("更新 {label} 失败: {error}"))
}

pub(crate) fn build_deepseek_harness_models(
    models: &[AgentModelOption],
    selected_model: &str,
) -> Result<serde_norway::Value, String> {
    let entries = ordered_agent_models(models, selected_model)
        .into_iter()
        .map(|model| {
            let mut entry = serde_norway::Mapping::new();
            entry.insert(yaml_key("id"), serde_norway::Value::String(model.name));
            if let Some(name) = model.alias.filter(|name| !name.trim().is_empty()) {
                entry.insert(yaml_key("name"), serde_norway::Value::String(name));
            }
            if let Some(context_window) = model.context_window {
                entry.insert(
                    yaml_key("contextWindow"),
                    serde_norway::to_value(context_window)
                        .map_err(|error| format!("序列化 Harness 模型上下文失败: {error}"))?,
                );
            }
            Ok(serde_norway::Value::Mapping(entry))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(serde_norway::Value::Sequence(entries))
}

pub(crate) fn build_deepseek_harness_settings(
    existing: Option<&str>,
    base_url: &str,
    model: &str,
    models: &[AgentModelOption],
) -> Result<String, String> {
    let published_models = build_deepseek_harness_models(models, model)?;
    render_agent_yaml_mapping_update(existing, "DeepSeek Harness settings", |root| {
        let llm = root
            .entry(yaml_key("llm-pi-ai"))
            .or_insert_with(|| serde_norway::Value::Mapping(serde_norway::Mapping::new()))
            .as_mapping_mut()
            .ok_or_else(|| "DeepSeek Harness llm-pi-ai 必须是映射".to_string())?;
        let providers = llm
            .entry(yaml_key("providers"))
            .or_insert_with(|| serde_norway::Value::Mapping(serde_norway::Mapping::new()))
            .as_mapping_mut()
            .ok_or_else(|| "DeepSeek Harness llm-pi-ai.providers 必须是映射".to_string())?;
        let provider = providers
            .entry(yaml_key(DEEPSEEK_HARNESS_PROVIDER_ID))
            .or_insert_with(|| serde_norway::Value::Mapping(serde_norway::Mapping::new()))
            .as_mapping_mut()
            .ok_or_else(|| "DeepSeek Harness EasyCLIProxyAPI provider 必须是映射".to_string())?;
        for (key, value) in [
            ("displayName", "EasyCLIProxyAPI"),
            ("apiKeyEnv", DEEPSEEK_HARNESS_CREDENTIAL),
            ("api", "openai-completions"),
            ("baseURL", base_url),
        ] {
            provider.insert(
                yaml_key(key),
                serde_norway::Value::String(value.to_string()),
            );
        }
        provider.insert(yaml_key("models"), published_models);

        let selection = root
            .entry(yaml_key("agent-default-model"))
            .or_insert_with(|| serde_norway::Value::Mapping(serde_norway::Mapping::new()))
            .as_mapping_mut()
            .ok_or_else(|| "DeepSeek Harness agent-default-model 必须是映射".to_string())?;
        selection.insert(
            yaml_key("provider"),
            serde_norway::Value::String(DEEPSEEK_HARNESS_PROVIDER_ID.to_string()),
        );
        selection.insert(
            yaml_key("model"),
            serde_norway::Value::String(model.to_string()),
        );
        selection.remove(yaml_key("reasoningEffort"));
        Ok(())
    })
}

pub(crate) fn build_deepseek_harness_credentials(
    existing: Option<&str>,
    api_key: &str,
) -> Result<String, String> {
    render_agent_yaml_mapping_update(existing, "DeepSeek Harness credentials", |root| {
        root.insert(
            yaml_key(DEEPSEEK_HARNESS_CREDENTIAL),
            serde_norway::Value::String(api_key.to_string()),
        );
        Ok(())
    })
}

pub(crate) fn write_deepseek_harness_file(
    path: &Path,
    content: &[u8],
    owner_only: bool,
) -> Result<(), String> {
    write_bytes_directly(path, content)?;
    #[cfg(unix)]
    if owner_only {
        use std::os::unix::fs::PermissionsExt;

        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| {
            format!(
                "设置 DeepSeek Harness 凭据权限失败 {}: {error}",
                path_to_string(path)
            )
        })?;
    }
    #[cfg(not(unix))]
    let _ = owner_only;
    Ok(())
}

pub(crate) fn write_agent_configuration_file(
    client: AgentClient,
    path: &Path,
    content: &[u8],
) -> Result<(), String> {
    if client == AgentClient::DeepSeekHarness {
        let owner_only = path.file_name().and_then(|name| name.to_str())
            == Some(DEEPSEEK_HARNESS_CREDENTIALS_FILE);
        write_deepseek_harness_file(path, content, owner_only)
    } else {
        write_bytes_directly(path, content)
    }
}

pub(crate) fn build_claude_agent_config(
    existing: Option<&str>,
    base_url: &str,
    api_key: &str,
    model: &str,
    models: &[AgentModelOption],
    mappings: Option<&ClaudeDesktopModelMappings>,
) -> Result<String, String> {
    let mut root = match existing.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => serde_json::from_str::<serde_json::Value>(value)
            .map_err(|error| format!("Claude Code settings.json 格式无效: {error}"))?,
        None => serde_json::json!({}),
    };
    let root = root
        .as_object_mut()
        .ok_or_else(|| "Claude Code settings.json 根节点必须是对象".to_string())?;
    let mappings = mappings
        .cloned()
        .unwrap_or_else(|| ClaudeDesktopModelMappings::all(model));
    let max_context_tokens = mappings.max_context_tokens;
    let model_settings = claude_code_model_settings(&mappings);
    let subagent_model = model_settings.haiku.clone();
    let effort_level = claude_code_model_effort_level(models, &mappings.sonnet)?;
    let env = ensure_json_object_entry(root, "env");
    env.remove("ANTHROPIC_API_KEY");
    env.remove("CLAUDE_CODE_EFFORT_LEVEL");
    env.remove(CLAUDE_CODE_MAX_CONTEXT_TOKENS_ENV);
    env.remove(CLAUDE_AUTOCOMPACT_PCT_OVERRIDE_ENV);
    env.remove(DISABLE_AUTO_COMPACT_ENV);
    for (key, value) in [
        ("ANTHROPIC_BASE_URL", base_url),
        ("ANTHROPIC_AUTH_TOKEN", api_key),
        ("ANTHROPIC_MODEL", model_settings.sonnet.as_str()),
        (
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            model_settings.haiku.as_str(),
        ),
        (
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            model_settings.sonnet.as_str(),
        ),
        ("ANTHROPIC_DEFAULT_OPUS_MODEL", model_settings.opus.as_str()),
        (
            "ANTHROPIC_DEFAULT_FABLE_MODEL",
            model_settings.sonnet.as_str(),
        ),
        ("CLAUDE_CODE_SUBAGENT_MODEL", subagent_model.as_str()),
    ] {
        env.insert(
            key.to_string(),
            serde_json::Value::String(value.to_string()),
        );
    }
    env.insert(
        CLAUDE_CODE_MAX_CONTEXT_TOKENS_ENV.to_string(),
        serde_json::Value::String(max_context_tokens.to_string()),
    );
    env.insert(
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY_ENV.to_string(),
        serde_json::Value::String("1".to_string()),
    );
    env.insert(
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE_ENV.to_string(),
        serde_json::Value::String(mappings.auto_compact_pct.to_string()),
    );
    if mappings.disable_auto_compact {
        env.insert(
            DISABLE_AUTO_COMPACT_ENV.to_string(),
            serde_json::Value::String("1".to_string()),
        );
    }
    for (key, value) in claude_code_model_presentation_environment(&mappings, models)? {
        env.insert(key, serde_json::Value::String(value));
    }
    if let Some(effort_level) = effort_level {
        env.insert(
            "CLAUDE_CODE_EFFORT_LEVEL".to_string(),
            serde_json::Value::String(effort_level),
        );
    }
    root.insert(
        "model".to_string(),
        serde_json::Value::String(model_settings.sonnet),
    );
    let mut rendered = serde_json::to_string_pretty(&serde_json::Value::Object(root.clone()))
        .map_err(|error| format!("生成 Claude Code 配置失败: {error}"))?;
    rendered.push('\n');
    Ok(rendered)
}

pub(crate) fn parse_agent_json_object(
    existing: Option<&str>,
    label: &str,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let value = match existing.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => serde_json::from_str::<serde_json::Value>(value)
            .map_err(|error| format!("{label} 格式无效: {error}"))?,
        None => serde_json::json!({}),
    };
    value
        .as_object()
        .cloned()
        .ok_or_else(|| format!("{label} 根节点必须是对象"))
}

pub(crate) fn parse_agent_json5_object(
    existing: Option<&str>,
    label: &str,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let value = match existing.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => json5::from_str::<serde_json::Value>(value)
            .map_err(|error| format!("{label} 格式无效: {error}"))?,
        None => serde_json::json!({}),
    };
    value
        .as_object()
        .cloned()
        .ok_or_else(|| format!("{label} 根节点必须是对象"))
}

pub(crate) fn ensure_json_object_entry<'a>(
    root: &'a mut serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> &'a mut serde_json::Map<String, serde_json::Value> {
    if !root.get(key).is_some_and(serde_json::Value::is_object) {
        root.insert(key.to_string(), serde_json::json!({}));
    }
    root.get_mut(key)
        .and_then(serde_json::Value::as_object_mut)
        .expect("object entry was just normalized")
}

pub(crate) fn ensure_json_array_entry<'a>(
    root: &'a mut serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> &'a mut Vec<serde_json::Value> {
    if !root.get(key).is_some_and(serde_json::Value::is_array) {
        root.insert(key.to_string(), serde_json::json!([]));
    }
    root.get_mut(key)
        .and_then(serde_json::Value::as_array_mut)
        .expect("array entry was just normalized")
}

pub(crate) fn render_agent_json(
    root: serde_json::Map<String, serde_json::Value>,
    label: &str,
) -> Result<String, String> {
    let mut rendered = serde_json::to_string_pretty(&serde_json::Value::Object(root))
        .map_err(|error| format!("生成 {label} 失败: {error}"))?;
    rendered.push('\n');
    Ok(rendered)
}

pub(crate) fn ordered_agent_models(
    models: &[AgentModelOption],
    selected_model: &str,
) -> Vec<AgentModelOption> {
    let mut ordered = Vec::with_capacity(models.len().max(1));
    if let Some(selected) = models
        .iter()
        .find(|model| model.name.eq_ignore_ascii_case(selected_model))
    {
        ordered.push(selected.clone());
    } else {
        ordered.push(AgentModelOption {
            name: selected_model.to_string(),
            alias: None,
            is_alias: false,
            context_window: None,
        });
    }
    for model in models {
        if ordered
            .iter()
            .any(|existing| existing.name.eq_ignore_ascii_case(&model.name))
        {
            continue;
        }
        ordered.push(model.clone());
    }
    ordered
}

pub(crate) fn build_claude_desktop_deployment_config(
    existing: Option<&str>,
) -> Result<String, String> {
    let mut root = parse_agent_json_object(existing, "Claude Desktop 配置")?;
    root.insert("deploymentMode".to_string(), serde_json::json!("3p"));
    render_agent_json(root, "Claude Desktop 配置")
}

pub(crate) fn build_claude_desktop_profile(
    existing: Option<&str>,
    base_url: &str,
    api_key: &str,
    model: &str,
    models: &[AgentModelOption],
    mappings: Option<&ClaudeDesktopModelMappings>,
) -> Result<String, String> {
    let mut root = parse_agent_json_object(existing, "Claude Desktop 网关配置")?;
    root.remove("coworkEgressAllowedHosts");
    root.insert(
        "disableDeploymentModeChooser".to_string(),
        serde_json::json!(true),
    );
    root.insert(
        "inferenceGatewayApiKey".to_string(),
        serde_json::json!(api_key),
    );
    root.insert(
        "inferenceGatewayAuthScheme".to_string(),
        serde_json::json!("bearer"),
    );
    root.insert(
        "inferenceGatewayBaseUrl".to_string(),
        serde_json::json!(base_url),
    );
    root.insert(
        "inferenceProvider".to_string(),
        serde_json::json!("gateway"),
    );
    let mappings = mappings
        .cloned()
        .unwrap_or_else(|| ClaudeDesktopModelMappings::all(model));
    let inference_models = vec![
        claude_desktop_inference_model(
            CLAUDE_DESKTOP_OPUS_MODEL_ID,
            &mappings.opus,
            mappings.opus_1m,
            models,
        ),
        claude_desktop_inference_model(
            CLAUDE_DESKTOP_SONNET_MODEL_ID,
            &mappings.sonnet,
            mappings.sonnet_1m,
            models,
        ),
        claude_desktop_inference_model(
            CLAUDE_DESKTOP_HAIKU_MODEL_ID,
            &mappings.haiku,
            mappings.haiku_1m,
            models,
        ),
    ];
    let mut deduplicated_models = Vec::<serde_json::Value>::with_capacity(inference_models.len());
    for entry in inference_models {
        let Some(name) = entry.get("name").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let existing = deduplicated_models.iter_mut().find(|existing| {
            existing
                .get("name")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|existing_name| existing_name.eq_ignore_ascii_case(name))
        });
        if let Some(existing) = existing {
            if entry.get("supports1m").and_then(serde_json::Value::as_bool) == Some(true) {
                *existing = entry;
            }
        } else {
            deduplicated_models.push(entry);
        }
    }
    root.insert(
        "inferenceModels".to_string(),
        serde_json::Value::Array(deduplicated_models),
    );
    render_agent_json(root, "Claude Desktop 网关配置")
}

pub(crate) fn claude_desktop_inference_model(
    route_model: &str,
    source_model: &str,
    enable_1m: bool,
    models: &[AgentModelOption],
) -> serde_json::Value {
    let selected = models
        .iter()
        .find(|model| model.name.eq_ignore_ascii_case(source_model));
    let direct_alias = selected.is_some_and(|model| model.is_alias);
    let context_window = claude_effective_context_window(models, source_model, enable_1m);
    let mut entry = serde_json::Map::new();
    entry.insert(
        "name".to_string(),
        serde_json::json!(if direct_alias {
            source_model
        } else {
            route_model
        }),
    );
    if let Some(context_window) = context_window {
        entry.insert(
            "contextWindow".to_string(),
            serde_json::json!(context_window),
        );
        if enable_1m {
            entry.insert("supports1m".to_string(), serde_json::json!(true));
            entry.insert("prefer1m".to_string(), serde_json::json!(true));
        }
    }
    serde_json::Value::Object(entry)
}

pub(crate) fn build_claude_desktop_meta(existing: Option<&str>) -> Result<String, String> {
    let mut root = parse_agent_json_object(existing, "Claude Desktop 配置索引")?;
    let entries = ensure_json_array_entry(&mut root, "entries");
    let mut managed_entry = None;
    let mut retained_entries = Vec::with_capacity(entries.len());
    for entry in std::mem::take(entries) {
        match entry.get("id").and_then(serde_json::Value::as_str) {
            Some(id) if id == CLAUDE_DESKTOP_PROFILE_ID => {
                if managed_entry.is_none() {
                    managed_entry = entry.as_object().cloned();
                }
            }
            Some(_) => retained_entries.push(entry),
            None => {}
        }
    }
    let mut managed_entry = managed_entry.unwrap_or_default();
    managed_entry.insert(
        "id".to_string(),
        serde_json::json!(CLAUDE_DESKTOP_PROFILE_ID),
    );
    managed_entry.insert("name".to_string(), serde_json::json!("EasyCLIProxyAPI"));
    retained_entries.push(serde_json::Value::Object(managed_entry));
    *entries = retained_entries;
    root.insert(
        "appliedId".to_string(),
        serde_json::json!(CLAUDE_DESKTOP_PROFILE_ID),
    );
    render_agent_json(root, "Claude Desktop 配置索引")
}

pub(crate) fn update_agent_json_file<F>(path: &Path, label: &str, update: F) -> Result<bool, String>
where
    F: FnOnce(&mut serde_json::Map<String, serde_json::Value>) -> bool,
{
    if !path.is_file() {
        return Ok(false);
    }
    let content = fs::read_to_string(path)
        .map_err(|error| format!("读取 {label} 失败 {}: {error}", path_to_string(path)))?;
    let mut root = parse_agent_json_object(Some(&content), label)?;
    if !update(&mut root) {
        return Ok(false);
    }
    if root.is_empty() {
        fs::remove_file(path)
            .map_err(|error| format!("删除空的 {label} 失败 {}: {error}", path_to_string(path)))?;
    } else {
        let rendered = render_agent_json(root, label)?;
        write_bytes_directly(path, rendered.as_bytes())?;
    }
    Ok(true)
}

pub(crate) fn remove_claude_desktop_managed_configuration(
    paths: &[PathBuf],
) -> Result<Vec<String>, String> {
    if paths.len() != 4 {
        return Err("Claude Desktop 当前平台配置路径不可用".to_string());
    }
    let mut changed = Vec::new();
    for (path, label) in [
        (&paths[0], "Claude Desktop 主配置"),
        (&paths[1], "Claude Desktop 3P 配置"),
    ] {
        if update_agent_json_file(path, label, |root| {
            if root
                .get("deploymentMode")
                .and_then(serde_json::Value::as_str)
                == Some("3p")
            {
                root.remove("deploymentMode");
                true
            } else {
                false
            }
        })? {
            changed.push(path_to_string(path));
        }
    }

    if update_agent_json_file(&paths[2], "Claude Desktop 网关配置", |root| {
        let mut updated = false;
        for key in [
            "coworkEgressAllowedHosts",
            "disableDeploymentModeChooser",
            "inferenceGatewayApiKey",
            "inferenceGatewayAuthScheme",
            "inferenceGatewayBaseUrl",
            "inferenceProvider",
            "inferenceModels",
        ] {
            updated |= root.remove(key).is_some();
        }
        updated
    })? {
        changed.push(path_to_string(&paths[2]));
    }

    if update_agent_json_file(&paths[3], "Claude Desktop 配置索引", |root| {
        let mut updated = false;
        if root.get("appliedId").and_then(serde_json::Value::as_str)
            == Some(CLAUDE_DESKTOP_PROFILE_ID)
        {
            root.remove("appliedId");
            updated = true;
        }
        let entries_empty = if let Some(entries) = root
            .get_mut("entries")
            .and_then(serde_json::Value::as_array_mut)
        {
            let previous_len = entries.len();
            entries.retain(|entry| {
                entry.get("id").and_then(serde_json::Value::as_str)
                    != Some(CLAUDE_DESKTOP_PROFILE_ID)
            });
            updated |= entries.len() != previous_len;
            entries.is_empty()
        } else {
            false
        };
        if entries_empty {
            root.remove("entries");
        }
        updated
    })? {
        changed.push(path_to_string(&paths[3]));
    }
    Ok(changed)
}

pub(crate) fn remove_claude_code_managed_configuration(
    paths: &[PathBuf],
) -> Result<Vec<String>, String> {
    let Some(path) = paths.first() else {
        return Err("Claude Code 当前平台配置路径不可用".to_string());
    };
    let updated = update_agent_json_file(path, "Claude Code 配置", |root| {
        let managed_model = root
            .get("env")
            .and_then(serde_json::Value::as_object)
            .and_then(|env| env.get("ANTHROPIC_MODEL"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let managed = root
            .get("env")
            .and_then(serde_json::Value::as_object)
            .and_then(|env| env.get("ANTHROPIC_BASE_URL"))
            .and_then(serde_json::Value::as_str)
            .is_some_and(is_managed_agent_base_url);
        if !managed {
            return false;
        }
        if root.get("model").and_then(serde_json::Value::as_str) == managed_model.as_deref() {
            root.remove("model");
        }
        let env_empty = if let Some(env) = root
            .get_mut("env")
            .and_then(serde_json::Value::as_object_mut)
        {
            for key in [
                "ANTHROPIC_BASE_URL",
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_AUTH_TOKEN",
                "ANTHROPIC_MODEL",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL",
                "ANTHROPIC_DEFAULT_SONNET_MODEL",
                "ANTHROPIC_DEFAULT_OPUS_MODEL",
                "ANTHROPIC_DEFAULT_FABLE_MODEL",
                CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY_ENV,
                CLAUDE_CODE_MAX_CONTEXT_TOKENS_ENV,
                CLAUDE_AUTOCOMPACT_PCT_OVERRIDE_ENV,
                DISABLE_AUTO_COMPACT_ENV,
            ] {
                env.remove(key);
            }
            env.is_empty()
        } else {
            false
        };
        if env_empty {
            root.remove("env");
        }
        true
    })?;
    Ok(updated.then(|| path_to_string(path)).into_iter().collect())
}

pub(crate) fn remove_codex_managed_configuration(paths: &[PathBuf]) -> Result<Vec<String>, String> {
    use toml_edit::{Document, Item};

    let Some(path) = paths.first() else {
        return Err("Codex 当前平台配置路径不可用".to_string());
    };
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(path)
        .map_err(|error| format!("读取 Codex 配置失败 {}: {error}", path_to_string(path)))?;
    let mut document = content
        .parse::<Document>()
        .map_err(|error| format!("解析 Codex 配置失败: {error}"))?;
    let managed_selected =
        document.get("model_provider").and_then(Item::as_str) == Some(MANAGED_AGENT_PROVIDER_ID);
    let managed_catalog =
        document.get("model_catalog_json").and_then(Item::as_str) == Some(CODEX_MODEL_CATALOG_FILE);
    let managed_provider = document
        .get("model_providers")
        .and_then(Item::as_table)
        .is_some_and(|providers| providers.contains_key(MANAGED_AGENT_PROVIDER_ID));
    if !managed_selected && !managed_catalog && !managed_provider {
        return Ok(Vec::new());
    }
    if managed_selected {
        document.remove("model_provider");
        document.remove("model");
    }
    if managed_catalog {
        document.remove("model_catalog_json");
    }
    if let Some(providers) = document
        .get_mut("model_providers")
        .and_then(Item::as_table_mut)
    {
        providers.remove(MANAGED_AGENT_PROVIDER_ID);
    }
    if document
        .get("model_providers")
        .and_then(Item::as_table)
        .is_some_and(toml_edit::Table::is_empty)
    {
        document.remove("model_providers");
    }
    let rendered = document.to_string();
    toml::from_str::<toml::Value>(&rendered)
        .map_err(|error| format!("验证恢复后的 Codex 配置失败: {error}"))?;
    if rendered.trim().is_empty() {
        fs::remove_file(path).map_err(|error| {
            format!("删除空的 Codex 配置失败 {}: {error}", path_to_string(path))
        })?;
    } else {
        write_bytes_directly(path, rendered.as_bytes())?;
    }
    let mut changed = vec![path_to_string(path)];
    if managed_catalog {
        let catalog_path = path.with_file_name(CODEX_MODEL_CATALOG_FILE);
        if catalog_path.is_file() {
            fs::remove_file(&catalog_path).map_err(|error| {
                format!(
                    "删除 Codex CPA 模型目录失败 {}: {error}",
                    path_to_string(&catalog_path)
                )
            })?;
            changed.push(path_to_string(&catalog_path));
        }
    }
    Ok(changed)
}

pub(crate) fn remove_opencode_managed_configuration(
    paths: &[PathBuf],
) -> Result<Vec<String>, String> {
    let Some(path) = paths.first() else {
        return Err("OpenCode 当前平台配置路径不可用".to_string());
    };
    let prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
    let updated = update_agent_json5_file(path, "OpenCode 配置", |root| {
        let mut changed = false;
        if root
            .get("model")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|model| model.starts_with(&prefix))
        {
            root.remove("model");
            changed = true;
        }
        let providers_empty = if let Some(providers) = root
            .get_mut("provider")
            .and_then(serde_json::Value::as_object_mut)
        {
            changed |= providers.remove(MANAGED_AGENT_PROVIDER_ID).is_some();
            providers.is_empty()
        } else {
            false
        };
        if providers_empty {
            root.remove("provider");
        }
        changed
    })?;
    Ok(updated.then(|| path_to_string(path)).into_iter().collect())
}

pub(crate) fn remove_zcode_managed_configuration(paths: &[PathBuf]) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Err("ZCode 当前平台配置路径不可用".to_string());
    }
    let prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
    let mut changed_paths = Vec::new();
    for path in paths {
        let updated = update_agent_json_file(path, "ZCode 配置", |root| {
            let mut changed = false;
            let remove_model = if root
                .get("model")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|model| model.starts_with(&prefix))
            {
                true
            } else if let Some(model) = root
                .get_mut("model")
                .and_then(serde_json::Value::as_object_mut)
            {
                if model
                    .get("main")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|model| model.starts_with(&prefix))
                {
                    model.remove("main");
                    changed = true;
                }
                model.is_empty()
            } else {
                false
            };
            if remove_model {
                root.remove("model");
                changed = true;
            }
            let providers_empty = if let Some(providers) = root
                .get_mut("provider")
                .and_then(serde_json::Value::as_object_mut)
            {
                changed |= providers.remove(MANAGED_AGENT_PROVIDER_ID).is_some();
                providers.is_empty()
            } else {
                false
            };
            if providers_empty {
                root.remove("provider");
            }
            changed
        })?;
        if updated {
            changed_paths.push(path_to_string(path));
        }
    }
    Ok(changed_paths)
}

pub(crate) fn remove_kimi_code_managed_configuration(
    paths: &[PathBuf],
) -> Result<Vec<String>, String> {
    remove_managed_toml_client_configuration(
        paths,
        "Kimi Code",
        Some("providers"),
        "models",
        None,
        "default_model",
    )
}

pub(crate) fn remove_grok_build_managed_configuration(
    paths: &[PathBuf],
) -> Result<Vec<String>, String> {
    remove_managed_toml_client_configuration(
        paths,
        "Grok Build",
        None,
        "model",
        Some("models"),
        "default",
    )
}

pub(crate) fn remove_managed_toml_client_configuration(
    paths: &[PathBuf],
    label: &str,
    provider_section: Option<&str>,
    model_entry_section: &str,
    default_section: Option<&str>,
    default_key: &str,
) -> Result<Vec<String>, String> {
    use toml_edit::{Document, Item};

    let Some(path) = paths.first() else {
        return Err(format!("{label} 当前平台配置路径不可用"));
    };
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(path)
        .map_err(|error| format!("读取 {label} 配置失败 {}: {error}", path_to_string(path)))?;
    let mut document = content
        .parse::<Document>()
        .map_err(|error| format!("解析 {label} 配置失败: {error}"))?;
    let prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
    let mut changed = false;

    let default_table = if let Some(section) = default_section {
        document
            .as_table_mut()
            .get_mut(section)
            .and_then(Item::as_table_mut)
    } else {
        Some(document.as_table_mut())
    };
    if let Some(table) = default_table {
        if table
            .get(default_key)
            .and_then(Item::as_str)
            .is_some_and(|model| model.starts_with(&prefix))
        {
            table.remove(default_key);
            changed = true;
        }
    }

    if let Some(section) = provider_section {
        if let Some(providers) = document
            .as_table_mut()
            .get_mut(section)
            .and_then(Item::as_table_mut)
        {
            changed |= providers.remove(MANAGED_AGENT_PROVIDER_ID).is_some();
        }
    }
    if let Some(models) = document
        .as_table_mut()
        .get_mut(model_entry_section)
        .and_then(Item::as_table_mut)
    {
        let managed = models
            .iter()
            .map(|(key, _)| key.to_string())
            .filter(|key| key.starts_with(&prefix))
            .collect::<Vec<_>>();
        changed |= !managed.is_empty();
        for key in managed {
            models.remove(&key);
        }
    }
    for section in provider_section.into_iter().chain([model_entry_section]) {
        let empty = document
            .as_table()
            .get(section)
            .and_then(Item::as_table)
            .is_some_and(toml_edit::Table::is_empty);
        if empty {
            document.as_table_mut().remove(section);
        }
    }
    if let Some(section) = default_section {
        let empty = document
            .as_table()
            .get(section)
            .and_then(Item::as_table)
            .is_some_and(toml_edit::Table::is_empty);
        if empty {
            document.as_table_mut().remove(section);
        }
    }
    if !changed {
        return Ok(Vec::new());
    }
    let rendered = document.to_string();
    toml::from_str::<toml::Value>(&rendered)
        .map_err(|error| format!("验证恢复后的 {label} 配置失败: {error}"))?;
    if rendered.trim().is_empty() {
        fs::remove_file(path).map_err(|error| {
            format!(
                "删除空的 {label} 配置失败 {}: {error}",
                path_to_string(path)
            )
        })?;
    } else {
        write_bytes_directly(path, rendered.as_bytes())?;
    }
    Ok(vec![path_to_string(path)])
}

pub(crate) fn update_agent_json5_file<F>(
    path: &Path,
    label: &str,
    update: F,
) -> Result<bool, String>
where
    F: FnOnce(&mut serde_json::Map<String, serde_json::Value>) -> bool,
{
    if !path.is_file() {
        return Ok(false);
    }
    let content = fs::read_to_string(path)
        .map_err(|error| format!("读取 {label} 失败 {}: {error}", path_to_string(path)))?;
    let value = json5::from_str::<serde_json::Value>(&content)
        .map_err(|error| format!("解析 {label} 失败: {error}"))?;
    let mut root = value
        .as_object()
        .cloned()
        .ok_or_else(|| format!("{label} 根节点必须是对象"))?;
    if !update(&mut root) {
        return Ok(false);
    }
    if root.is_empty() {
        fs::remove_file(path)
            .map_err(|error| format!("删除空的 {label} 失败 {}: {error}", path_to_string(path)))?;
    } else {
        let rendered = render_agent_json(root, label)?;
        let comments = extract_json5_comments(&content);
        let rendered = if comments.is_empty() {
            rendered
        } else {
            format!("{}\n{rendered}", comments.join("\n"))
        };
        write_bytes_directly(path, rendered.as_bytes())?;
    }
    Ok(true)
}

pub(crate) fn remove_openclaw_managed_configuration(
    paths: &[PathBuf],
) -> Result<Vec<String>, String> {
    let Some(path) = paths.first() else {
        return Err("OpenClaw 当前平台配置路径不可用".to_string());
    };
    let prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
    let updated = update_agent_json5_file(path, "OpenClaw 配置", |root| {
        let mut changed = false;
        if let Some(models) = root
            .get_mut("models")
            .and_then(serde_json::Value::as_object_mut)
        {
            let providers_empty = if let Some(providers) = models
                .get_mut("providers")
                .and_then(serde_json::Value::as_object_mut)
            {
                changed |= providers.remove(MANAGED_AGENT_PROVIDER_ID).is_some();
                providers.is_empty()
            } else {
                false
            };
            if providers_empty {
                models.remove("providers");
            }
        }
        if let Some(defaults) = root
            .get_mut("agents")
            .and_then(serde_json::Value::as_object_mut)
            .and_then(|agents| agents.get_mut("defaults"))
            .and_then(serde_json::Value::as_object_mut)
        {
            let model_empty = if let Some(model) = defaults
                .get_mut("model")
                .and_then(serde_json::Value::as_object_mut)
            {
                if model
                    .get("primary")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|model| model.starts_with(&prefix))
                {
                    model.remove("primary");
                    changed = true;
                }
                model.is_empty()
            } else {
                false
            };
            if model_empty {
                defaults.remove("model");
            }
            let catalog_empty = if let Some(catalog) = defaults
                .get_mut("models")
                .and_then(serde_json::Value::as_object_mut)
            {
                let previous_len = catalog.len();
                catalog.retain(|name, _| !name.starts_with(&prefix));
                changed |= catalog.len() != previous_len;
                catalog.is_empty()
            } else {
                false
            };
            if catalog_empty {
                defaults.remove("models");
            }
        }
        changed
    })?;
    Ok(updated.then(|| path_to_string(path)).into_iter().collect())
}

pub(crate) fn remove_hermes_managed_configuration(
    paths: &[PathBuf],
) -> Result<Vec<String>, String> {
    let Some(path) = paths.first() else {
        return Err("Hermes 当前平台配置路径不可用".to_string());
    };
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(path)
        .map_err(|error| format!("读取 Hermes 配置失败 {}: {error}", path_to_string(path)))?;
    let mut document = yaml_serde_edit::YamlValue::parse(&content)
        .map_err(|error| format!("解析 Hermes 配置失败: {error}"))?;
    let mut updated = document.get().clone();
    let root = updated
        .as_mapping_mut()
        .ok_or_else(|| "Hermes 配置根节点必须是映射".to_string())?;
    let mut changed = false;
    let providers_empty = if let Some(providers) = root
        .get_mut(yaml_key("custom_providers"))
        .and_then(serde_norway::Value::as_sequence_mut)
    {
        let previous_len = providers.len();
        providers.retain(|provider| {
            provider.get("name").and_then(serde_norway::Value::as_str)
                != Some(MANAGED_AGENT_PROVIDER_ID)
        });
        changed |= providers.len() != previous_len;
        providers.is_empty()
    } else {
        false
    };
    if providers_empty {
        root.remove(yaml_key("custom_providers"));
    }
    let model_empty = if let Some(model) = root
        .get_mut(yaml_key("model"))
        .and_then(serde_norway::Value::as_mapping_mut)
    {
        if model
            .get(yaml_key("provider"))
            .and_then(serde_norway::Value::as_str)
            == Some(MANAGED_AGENT_PROVIDER_ID)
        {
            model.remove(yaml_key("provider"));
            model.remove(yaml_key("default"));
            changed = true;
        }
        model.is_empty()
    } else {
        false
    };
    if model_empty {
        root.remove(yaml_key("model"));
    }
    if !changed {
        return Ok(Vec::new());
    }
    if root.is_empty() {
        fs::remove_file(path).map_err(|error| {
            format!("删除空的 Hermes 配置失败 {}: {error}", path_to_string(path))
        })?;
    } else {
        let rendered = render_updated_core_yaml(&mut document, updated)?;
        write_bytes_directly(path, rendered.as_bytes())?;
    }
    Ok(vec![path_to_string(path)])
}

pub(crate) fn remove_agent_managed_configuration(
    client: AgentClient,
    paths: &[PathBuf],
) -> Result<Vec<String>, String> {
    match client {
        AgentClient::ClaudeCode => remove_claude_code_managed_configuration(paths),
        AgentClient::ClaudeDesktop => remove_claude_desktop_managed_configuration(paths),
        AgentClient::Codex => remove_codex_managed_configuration(paths),
        AgentClient::OpenCode => remove_opencode_managed_configuration(paths),
        AgentClient::OpenClaw => remove_openclaw_managed_configuration(paths),
        AgentClient::Hermes => remove_hermes_managed_configuration(paths),
        AgentClient::DeepSeekHarness => remove_deepseek_harness_managed_configuration(paths),
        AgentClient::ZCode => remove_zcode_managed_configuration(paths),
        AgentClient::KimiCode => remove_kimi_code_managed_configuration(paths),
        AgentClient::GrokBuild => remove_grok_build_managed_configuration(paths),
    }
}

pub(crate) fn remove_deepseek_harness_settings_fields(root: &mut serde_norway::Mapping) -> bool {
    let mut changed = false;
    let mut remove_llm = false;
    if let Some(llm) = root
        .get_mut(yaml_key("llm-pi-ai"))
        .and_then(serde_norway::Value::as_mapping_mut)
    {
        let mut remove_providers = false;
        if let Some(providers) = llm
            .get_mut(yaml_key("providers"))
            .and_then(serde_norway::Value::as_mapping_mut)
        {
            changed |= providers
                .remove(yaml_key(DEEPSEEK_HARNESS_PROVIDER_ID))
                .is_some();
            remove_providers = providers.is_empty();
        }
        if remove_providers {
            llm.remove(yaml_key("providers"));
        }
        remove_llm = llm.is_empty();
    }
    if remove_llm {
        root.remove(yaml_key("llm-pi-ai"));
    }
    let managed_selection = root
        .get(yaml_key("agent-default-model"))
        .and_then(serde_norway::Value::as_mapping)
        .and_then(|selection| yaml_mapping_value(selection, "provider"))
        .and_then(serde_norway::Value::as_str)
        == Some(DEEPSEEK_HARNESS_PROVIDER_ID);
    if managed_selection {
        root.remove(yaml_key("agent-default-model"));
        changed = true;
    }
    changed
}

pub(crate) fn remove_deepseek_harness_managed_configuration(
    paths: &[PathBuf],
) -> Result<Vec<String>, String> {
    if paths.len() != 2 {
        return Err("DeepSeek Harness 配置路径数量无效".to_string());
    }
    let mut changed_paths = Vec::new();
    if paths[0].is_file() {
        let current = fs::read_to_string(&paths[0])
            .map_err(|error| format!("读取 DeepSeek Harness settings 失败: {error}"))?;
        let mut changed = false;
        let rendered = render_agent_yaml_mapping_update(
            Some(&current),
            "DeepSeek Harness settings",
            |root| {
                changed = remove_deepseek_harness_settings_fields(root);
                Ok(())
            },
        )?;
        if changed {
            let root = parse_agent_yaml_mapping(Some(&rendered), "DeepSeek Harness settings")?;
            if root.is_empty() {
                fs::remove_file(&paths[0])
                    .map_err(|error| format!("删除空的 DeepSeek Harness settings 失败: {error}"))?;
            } else {
                write_bytes_directly(&paths[0], rendered.as_bytes())?;
            }
            changed_paths.push(path_to_string(&paths[0]));
        }
    }
    if paths[1].is_file() {
        let current = fs::read_to_string(&paths[1])
            .map_err(|error| format!("读取 DeepSeek Harness credentials 失败: {error}"))?;
        let mut changed = false;
        let rendered = render_agent_yaml_mapping_update(
            Some(&current),
            "DeepSeek Harness credentials",
            |root| {
                changed = root.remove(yaml_key(DEEPSEEK_HARNESS_CREDENTIAL)).is_some();
                Ok(())
            },
        )?;
        if changed {
            let root = parse_agent_yaml_mapping(Some(&rendered), "DeepSeek Harness credentials")?;
            if root.is_empty() {
                fs::remove_file(&paths[1]).map_err(|error| {
                    format!("删除空的 DeepSeek Harness credentials 失败: {error}")
                })?;
            } else {
                write_deepseek_harness_file(&paths[1], rendered.as_bytes(), true)?;
            }
            changed_paths.push(path_to_string(&paths[1]));
        }
    }
    Ok(changed_paths)
}

pub(crate) fn restore_json_key(
    current: &mut serde_json::Map<String, serde_json::Value>,
    original: Option<&serde_json::Map<String, serde_json::Value>>,
    key: &str,
) {
    if let Some(value) = original.and_then(|root| root.get(key)).cloned() {
        current.insert(key.to_string(), value);
    } else {
        current.remove(key);
    }
}

pub(crate) fn parse_restored_json_object(
    content: Option<&str>,
    label: &str,
) -> Result<Option<serde_json::Map<String, serde_json::Value>>, String> {
    content
        .map(|content| parse_agent_json_object(Some(content), label))
        .transpose()
}

pub(crate) fn parse_restored_json5_object(
    content: Option<&str>,
    label: &str,
) -> Result<Option<serde_json::Map<String, serde_json::Value>>, String> {
    content
        .map(|content| parse_agent_json5_object(Some(content), label))
        .transpose()
}

pub(crate) fn render_restored_json(
    root: serde_json::Map<String, serde_json::Value>,
    original_existed: bool,
    label: &str,
) -> Result<Option<String>, String> {
    if root.is_empty() && !original_existed {
        Ok(None)
    } else {
        render_agent_json(root, label).map(Some)
    }
}

pub(crate) fn build_restored_claude_code_config(
    current: &str,
    original: Option<&str>,
) -> Result<Option<String>, String> {
    let mut root = parse_agent_json_object(Some(current), "当前 Claude Code 配置")?;
    let original_root = parse_restored_json_object(original, "原始 Claude Code 配置")?;
    restore_json_key(&mut root, original_root.as_ref(), "model");
    let original_env = original_root
        .as_ref()
        .and_then(|root| root.get("env"))
        .and_then(serde_json::Value::as_object);
    if root.get("env").is_some_and(serde_json::Value::is_object) {
        let env = root
            .get_mut("env")
            .and_then(serde_json::Value::as_object_mut)
            .expect("Claude Code env was checked as an object");
        for key in [
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_FABLE_MODEL",
            CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY_ENV,
            CLAUDE_CODE_MAX_CONTEXT_TOKENS_ENV,
            CLAUDE_AUTOCOMPACT_PCT_OVERRIDE_ENV,
            DISABLE_AUTO_COMPACT_ENV,
        ] {
            restore_json_key(env, original_env, key);
        }
        if env.is_empty() && original_env.is_none() {
            root.remove("env");
        }
    } else {
        restore_json_key(&mut root, original_root.as_ref(), "env");
    }
    render_restored_json(root, original.is_some(), "恢复后的 Claude Code 配置")
}

pub(crate) fn build_restored_claude_desktop_config(
    index: usize,
    current: &str,
    original: Option<&str>,
) -> Result<Option<String>, String> {
    let mut root = parse_agent_json_object(Some(current), "当前 Claude Desktop 配置")?;
    let original_root = parse_restored_json_object(original, "原始 Claude Desktop 配置")?;
    match index {
        0 | 1 => restore_json_key(&mut root, original_root.as_ref(), "deploymentMode"),
        2 => {
            for key in [
                "coworkEgressAllowedHosts",
                "disableDeploymentModeChooser",
                "inferenceGatewayApiKey",
                "inferenceGatewayAuthScheme",
                "inferenceGatewayBaseUrl",
                "inferenceProvider",
                "inferenceModels",
            ] {
                restore_json_key(&mut root, original_root.as_ref(), key);
            }
        }
        3 => {
            restore_json_key(&mut root, original_root.as_ref(), "appliedId");
            let mut entries = root
                .remove("entries")
                .and_then(|value| value.as_array().cloned())
                .unwrap_or_default();
            entries.retain(|entry| {
                entry.get("id").and_then(serde_json::Value::as_str)
                    != Some(CLAUDE_DESKTOP_PROFILE_ID)
            });
            let original_managed_entries = original_root
                .as_ref()
                .and_then(|root| root.get("entries"))
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .filter(|entry| {
                    entry.get("id").and_then(serde_json::Value::as_str)
                        == Some(CLAUDE_DESKTOP_PROFILE_ID)
                })
                .cloned();
            entries.extend(original_managed_entries);
            if !entries.is_empty()
                || original_root
                    .as_ref()
                    .and_then(|root| root.get("entries"))
                    .is_some()
            {
                root.insert("entries".to_string(), serde_json::Value::Array(entries));
            }
        }
        _ => return Err("Claude Desktop 配置文件索引无效".to_string()),
    }
    render_restored_json(root, original.is_some(), "恢复后的 Claude Desktop 配置")
}

pub(crate) fn build_restored_opencode_config(
    current: &str,
    original: Option<&str>,
) -> Result<Option<String>, String> {
    let mut root = parse_agent_json5_object(Some(current), "当前 OpenCode 配置")?;
    let original_root = parse_restored_json5_object(original, "原始 OpenCode 配置")?;
    for key in ["$schema", "model"] {
        restore_json_key(&mut root, original_root.as_ref(), key);
    }
    let original_provider = original_root
        .as_ref()
        .and_then(|root| root.get("provider"))
        .and_then(serde_json::Value::as_object);
    let original_managed = original_provider
        .and_then(|providers| providers.get(MANAGED_AGENT_PROVIDER_ID))
        .and_then(serde_json::Value::as_object);
    if root
        .get("provider")
        .is_some_and(serde_json::Value::is_object)
    {
        let providers = root
            .get_mut("provider")
            .and_then(serde_json::Value::as_object_mut)
            .expect("OpenCode provider was checked as an object");
        if providers
            .get(MANAGED_AGENT_PROVIDER_ID)
            .is_some_and(serde_json::Value::is_object)
        {
            let managed = providers
                .get_mut(MANAGED_AGENT_PROVIDER_ID)
                .and_then(serde_json::Value::as_object_mut)
                .expect("OpenCode managed provider was checked as an object");
            for key in ["npm", "name", "models"] {
                restore_json_key(managed, original_managed, key);
            }
            let original_options = original_managed
                .and_then(|managed| managed.get("options"))
                .and_then(serde_json::Value::as_object);
            if managed
                .get("options")
                .is_some_and(serde_json::Value::is_object)
            {
                let options = managed
                    .get_mut("options")
                    .and_then(serde_json::Value::as_object_mut)
                    .expect("OpenCode options were checked as an object");
                for key in ["baseURL", "apiKey"] {
                    restore_json_key(options, original_options, key);
                }
                if options.is_empty() && original_options.is_none() {
                    managed.remove("options");
                }
            } else {
                restore_json_key(managed, original_managed, "options");
            }
            if managed.is_empty() && original_managed.is_none() {
                providers.remove(MANAGED_AGENT_PROVIDER_ID);
            }
        } else if let Some(original_managed) = original_provider
            .and_then(|providers| providers.get(MANAGED_AGENT_PROVIDER_ID))
            .cloned()
        {
            providers.insert(MANAGED_AGENT_PROVIDER_ID.to_string(), original_managed);
        }
        if providers.is_empty() && original_provider.is_none() {
            root.remove("provider");
        }
    } else {
        restore_json_key(&mut root, original_root.as_ref(), "provider");
    }
    let restored = render_restored_json(root, original.is_some(), "恢复后的 OpenCode 配置")?;
    Ok(restored.map(|rendered| {
        let comments = extract_json5_comments(current);
        if comments.is_empty() {
            rendered
        } else {
            format!("{}\n{rendered}", comments.join("\n"))
        }
    }))
}

pub(crate) fn build_restored_zcode_config(
    current: &str,
    original: Option<&str>,
) -> Result<Option<String>, String> {
    let mut root = parse_agent_json_object(Some(current), "当前 ZCode 配置")?;
    let original_root = parse_restored_json_object(original, "原始 ZCode 配置")?;
    restore_json_key(&mut root, original_root.as_ref(), "model");
    let original_provider = original_root
        .as_ref()
        .and_then(|root| root.get("provider"))
        .and_then(serde_json::Value::as_object);
    let original_managed = original_provider
        .and_then(|providers| providers.get(MANAGED_AGENT_PROVIDER_ID))
        .and_then(serde_json::Value::as_object);
    if root
        .get("provider")
        .is_some_and(serde_json::Value::is_object)
    {
        let providers = root
            .get_mut("provider")
            .and_then(serde_json::Value::as_object_mut)
            .expect("ZCode provider was checked as an object");
        if providers
            .get(MANAGED_AGENT_PROVIDER_ID)
            .is_some_and(serde_json::Value::is_object)
        {
            let managed = providers
                .get_mut(MANAGED_AGENT_PROVIDER_ID)
                .and_then(serde_json::Value::as_object_mut)
                .expect("ZCode managed provider was checked as an object");
            for key in [
                "enabled",
                "name",
                "source",
                "kind",
                "defaultKind",
                "apiFormat",
                "npm",
                "models",
            ] {
                restore_json_key(managed, original_managed, key);
            }
            let original_options = original_managed
                .and_then(|managed| managed.get("options"))
                .and_then(serde_json::Value::as_object);
            if managed
                .get("options")
                .is_some_and(serde_json::Value::is_object)
            {
                let options = managed
                    .get_mut("options")
                    .and_then(serde_json::Value::as_object_mut)
                    .expect("ZCode options were checked as an object");
                for key in ["baseURL", "apiKey"] {
                    restore_json_key(options, original_options, key);
                }
                if options.is_empty() && original_options.is_none() {
                    managed.remove("options");
                }
            } else {
                restore_json_key(managed, original_managed, "options");
            }
            if managed.is_empty() && original_managed.is_none() {
                providers.remove(MANAGED_AGENT_PROVIDER_ID);
            }
        } else if let Some(original_managed) = original_provider
            .and_then(|providers| providers.get(MANAGED_AGENT_PROVIDER_ID))
            .cloned()
        {
            providers.insert(MANAGED_AGENT_PROVIDER_ID.to_string(), original_managed);
        }
        if providers.is_empty() && original_provider.is_none() {
            root.remove("provider");
        }
    } else {
        restore_json_key(&mut root, original_root.as_ref(), "provider");
    }
    render_restored_json(root, original.is_some(), "恢复后的 ZCode 配置")
}

pub(crate) fn build_restored_kimi_code_config(
    current: &str,
    original: Option<&str>,
) -> Result<Option<String>, String> {
    build_restored_managed_toml_client_config(
        current,
        original,
        "Kimi Code",
        Some(("providers", &["type", "base_url", "api_key"])),
        "models",
        None,
        "default_model",
    )
}

pub(crate) fn build_restored_grok_build_config(
    current: &str,
    original: Option<&str>,
) -> Result<Option<String>, String> {
    build_restored_managed_toml_client_config(
        current,
        original,
        "Grok Build",
        None,
        "model",
        Some("models"),
        "default",
    )
}

pub(crate) fn build_restored_managed_toml_client_config(
    current: &str,
    original: Option<&str>,
    label: &str,
    provider: Option<(&str, &[&str])>,
    model_entry_section: &str,
    default_section: Option<&str>,
    default_key: &str,
) -> Result<Option<String>, String> {
    use toml_edit::Item;

    let mut current_document = parse_codex_document(Some(current), &format!("当前 {label} 配置"))?;
    let original_document = original
        .map(|content| parse_codex_document(Some(content), &format!("原始 {label} 配置")))
        .transpose()?;
    if let Some(original_document) = original_document.as_ref() {
        merge_missing_codex_table_items(
            current_document.as_table_mut(),
            original_document.as_table(),
        );
    }

    if let Some(section) = default_section {
        let original_table = original_document
            .as_ref()
            .and_then(|document| document.as_table().get(section))
            .and_then(Item::as_table);
        if let Some(current_table) = current_document
            .as_table_mut()
            .get_mut(section)
            .and_then(Item::as_table_mut)
        {
            restore_codex_table_item(current_table, original_table, default_key);
        }
    } else {
        restore_codex_table_item(
            current_document.as_table_mut(),
            original_document
                .as_ref()
                .map(|document| document.as_table()),
            default_key,
        );
    }

    if let Some((section, managed_keys)) = provider {
        let original_provider = original_document
            .as_ref()
            .and_then(|document| document.as_table().get(section))
            .and_then(Item::as_table)
            .and_then(|providers| providers.get(MANAGED_AGENT_PROVIDER_ID))
            .and_then(Item::as_table)
            .cloned();
        if let Some(providers) = current_document
            .as_table_mut()
            .get_mut(section)
            .and_then(Item::as_table_mut)
        {
            if let Some(current_provider) = providers
                .get_mut(MANAGED_AGENT_PROVIDER_ID)
                .and_then(Item::as_table_mut)
            {
                for key in managed_keys {
                    restore_codex_table_item(current_provider, original_provider.as_ref(), key);
                }
                if current_provider.is_empty() {
                    providers.remove(MANAGED_AGENT_PROVIDER_ID);
                }
            }
        }
    }

    let prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
    let original_models = original_document
        .as_ref()
        .and_then(|document| document.as_table().get(model_entry_section))
        .and_then(Item::as_table)
        .map(|models| {
            models
                .iter()
                .filter(|(key, _)| key.starts_with(&prefix))
                .map(|(key, item)| (key.to_string(), item.clone()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if let Some(models) = current_document
        .as_table_mut()
        .get_mut(model_entry_section)
        .and_then(Item::as_table_mut)
    {
        let managed = models
            .iter()
            .map(|(key, _)| key.to_string())
            .filter(|key| key.starts_with(&prefix))
            .collect::<Vec<_>>();
        for key in managed {
            models.remove(&key);
        }
        for (key, item) in &original_models {
            models.insert(key, item.clone());
        }
    } else if !original_models.is_empty() {
        let models = ensure_toml_child_table(current_document.as_table_mut(), model_entry_section);
        for (key, item) in &original_models {
            models.insert(key, item.clone());
        }
    }

    for section in provider
        .map(|(section, _)| section)
        .into_iter()
        .chain([model_entry_section])
        .chain(default_section)
    {
        let empty = current_document
            .as_table()
            .get(section)
            .and_then(Item::as_table)
            .is_some_and(toml_edit::Table::is_empty);
        if empty {
            current_document.as_table_mut().remove(section);
        }
    }
    let rendered = current_document.to_string();
    toml::from_str::<toml::Value>(&rendered)
        .map_err(|error| format!("验证恢复后的 {label} 配置失败: {error}"))?;
    if original.is_none() && rendered.trim().is_empty() {
        Ok(None)
    } else {
        Ok(Some(rendered))
    }
}

pub(crate) fn build_restored_openclaw_config(
    current: &str,
    original: Option<&str>,
) -> Result<Option<String>, String> {
    let current_value = json5::from_str::<serde_json::Value>(current)
        .map_err(|error| format!("当前 OpenClaw 配置格式无效: {error}"))?;
    let mut root = current_value
        .as_object()
        .cloned()
        .ok_or_else(|| "当前 OpenClaw 配置根节点必须是对象".to_string())?;
    let original_root = original
        .map(|content| {
            json5::from_str::<serde_json::Value>(content)
                .map_err(|error| format!("原始 OpenClaw 配置格式无效: {error}"))?
                .as_object()
                .cloned()
                .ok_or_else(|| "原始 OpenClaw 配置根节点必须是对象".to_string())
        })
        .transpose()?;
    let original_models = original_root
        .as_ref()
        .and_then(|root| root.get("models"))
        .and_then(serde_json::Value::as_object);
    if root.get("models").is_some_and(serde_json::Value::is_object) {
        let models = root
            .get_mut("models")
            .and_then(serde_json::Value::as_object_mut)
            .expect("OpenClaw models were checked as an object");
        restore_json_key(models, original_models, "mode");
        let original_providers = original_models
            .and_then(|models| models.get("providers"))
            .and_then(serde_json::Value::as_object);
        if models
            .get("providers")
            .is_some_and(serde_json::Value::is_object)
        {
            let providers = models
                .get_mut("providers")
                .and_then(serde_json::Value::as_object_mut)
                .expect("OpenClaw providers were checked as an object");
            let original_managed = original_providers
                .and_then(|providers| providers.get(MANAGED_AGENT_PROVIDER_ID))
                .and_then(serde_json::Value::as_object);
            if providers
                .get(MANAGED_AGENT_PROVIDER_ID)
                .is_some_and(serde_json::Value::is_object)
            {
                let managed = providers
                    .get_mut(MANAGED_AGENT_PROVIDER_ID)
                    .and_then(serde_json::Value::as_object_mut)
                    .expect("OpenClaw managed provider was checked as an object");
                for key in ["baseUrl", "apiKey", "api", "models"] {
                    restore_json_key(managed, original_managed, key);
                }
                if managed.is_empty() && original_managed.is_none() {
                    providers.remove(MANAGED_AGENT_PROVIDER_ID);
                }
            } else if let Some(original_managed) = original_providers
                .and_then(|providers| providers.get(MANAGED_AGENT_PROVIDER_ID))
                .cloned()
            {
                providers.insert(MANAGED_AGENT_PROVIDER_ID.to_string(), original_managed);
            }
            if providers.is_empty() && original_providers.is_none() {
                models.remove("providers");
            }
        } else {
            restore_json_key(models, original_models, "providers");
        }
        if models.is_empty() && original_models.is_none() {
            root.remove("models");
        }
    } else {
        restore_json_key(&mut root, original_root.as_ref(), "models");
    }

    let original_defaults = original_root
        .as_ref()
        .and_then(|root| root.get("agents"))
        .and_then(|agents| agents.get("defaults"))
        .and_then(serde_json::Value::as_object);
    if let Some(defaults) = root
        .get_mut("agents")
        .and_then(serde_json::Value::as_object_mut)
        .and_then(|agents| agents.get_mut("defaults"))
        .and_then(serde_json::Value::as_object_mut)
    {
        let original_model = original_defaults
            .and_then(|defaults| defaults.get("model"))
            .and_then(serde_json::Value::as_object);
        if defaults
            .get("model")
            .is_some_and(serde_json::Value::is_object)
        {
            let model = defaults
                .get_mut("model")
                .and_then(serde_json::Value::as_object_mut)
                .expect("OpenClaw default model was checked as an object");
            restore_json_key(model, original_model, "primary");
            if model.is_empty() && original_model.is_none() {
                defaults.remove("model");
            }
        } else {
            restore_json_key(defaults, original_defaults, "model");
        }

        let original_catalog = original_defaults
            .and_then(|defaults| defaults.get("models"))
            .and_then(serde_json::Value::as_object);
        if defaults
            .get("models")
            .is_some_and(serde_json::Value::is_object)
        {
            let prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
            let catalog = defaults
                .get_mut("models")
                .and_then(serde_json::Value::as_object_mut)
                .expect("OpenClaw model catalog was checked as an object");
            catalog.retain(|name, _| !name.starts_with(&prefix));
            if let Some(original_catalog) = original_catalog {
                catalog.extend(
                    original_catalog
                        .iter()
                        .filter(|(name, _)| name.starts_with(&prefix))
                        .map(|(name, value)| (name.clone(), value.clone())),
                );
            }
            if catalog.is_empty() && original_catalog.is_none() {
                defaults.remove("models");
            }
        } else {
            restore_json_key(defaults, original_defaults, "models");
        }
    }
    let original_agents = original_root
        .as_ref()
        .and_then(|root| root.get("agents"))
        .and_then(serde_json::Value::as_object);
    if let Some(agents) = root
        .get_mut("agents")
        .and_then(serde_json::Value::as_object_mut)
    {
        let remove_defaults = agents
            .get("defaults")
            .and_then(serde_json::Value::as_object)
            .is_some_and(serde_json::Map::is_empty)
            && original_defaults.is_none();
        if remove_defaults {
            agents.remove("defaults");
        }
        if agents.is_empty() && original_agents.is_none() {
            root.remove("agents");
        }
    }
    if root.is_empty() && original.is_none() {
        return Ok(None);
    }
    let rendered = render_agent_json(root, "恢复后的 OpenClaw 配置")?;
    let comments = extract_json5_comments(current);
    Ok(Some(if comments.is_empty() {
        rendered
    } else {
        format!("{}\n{rendered}", comments.join("\n"))
    }))
}

pub(crate) fn restore_yaml_key(
    current: &mut serde_norway::Mapping,
    original: Option<&serde_norway::Mapping>,
    key: &str,
) {
    if let Some(value) = original.and_then(|root| root.get(yaml_key(key))).cloned() {
        current.insert(yaml_key(key), value);
    } else {
        current.remove(yaml_key(key));
    }
}

pub(crate) fn build_restored_hermes_config(
    current: &str,
    original: Option<&str>,
) -> Result<Option<String>, String> {
    let mut document = yaml_serde_edit::YamlValue::parse(current)
        .map_err(|error| format!("当前 Hermes 配置格式无效: {error}"))?;
    let mut updated = document.get().clone();
    let root = updated
        .as_mapping_mut()
        .ok_or_else(|| "当前 Hermes 配置根节点必须是映射".to_string())?;
    let original_value = original
        .map(|content| {
            serde_norway::from_str::<serde_norway::Value>(content)
                .map_err(|error| format!("原始 Hermes 配置格式无效: {error}"))
        })
        .transpose()?;
    let original_root = original_value
        .as_ref()
        .and_then(serde_norway::Value::as_mapping);
    let original_managed = original_root
        .and_then(|root| root.get(yaml_key("custom_providers")))
        .and_then(serde_norway::Value::as_sequence)
        .and_then(|providers| {
            providers.iter().find(|provider| {
                provider.get("name").and_then(serde_norway::Value::as_str)
                    == Some(MANAGED_AGENT_PROVIDER_ID)
            })
        });
    if let Some(providers) = root
        .get_mut(yaml_key("custom_providers"))
        .and_then(serde_norway::Value::as_sequence_mut)
    {
        let current_managed = providers
            .iter()
            .find(|provider| {
                provider.get("name").and_then(serde_norway::Value::as_str)
                    == Some(MANAGED_AGENT_PROVIDER_ID)
            })
            .and_then(serde_norway::Value::as_mapping)
            .cloned();
        providers.retain(|provider| {
            provider.get("name").and_then(serde_norway::Value::as_str)
                != Some(MANAGED_AGENT_PROVIDER_ID)
        });
        let mut managed = current_managed.unwrap_or_default();
        let original_managed = original_managed.and_then(serde_norway::Value::as_mapping);
        for key in ["name", "base_url", "api_key", "api_mode", "model", "models"] {
            restore_yaml_key(&mut managed, original_managed, key);
        }
        if original_managed.is_some() {
            providers.push(serde_norway::Value::Mapping(managed));
        } else if !managed.is_empty() {
            managed.insert(
                yaml_key("name"),
                serde_norway::Value::String(MANAGED_AGENT_PROVIDER_ID.to_string()),
            );
            providers.push(serde_norway::Value::Mapping(managed));
        }
        if providers.is_empty()
            && original_root
                .and_then(|root| root.get(yaml_key("custom_providers")))
                .is_none()
        {
            root.remove(yaml_key("custom_providers"));
        }
    } else {
        restore_yaml_key(root, original_root, "custom_providers");
    }
    let original_model = original_root
        .and_then(|root| root.get(yaml_key("model")))
        .and_then(serde_norway::Value::as_mapping);
    if let Some(model) = root
        .get_mut(yaml_key("model"))
        .and_then(serde_norway::Value::as_mapping_mut)
    {
        for key in ["default", "provider"] {
            restore_yaml_key(model, original_model, key);
        }
        if model.is_empty() && original_model.is_none() {
            root.remove(yaml_key("model"));
        }
    } else {
        restore_yaml_key(root, original_root, "model");
    }
    if root.is_empty() && original.is_none() {
        return Ok(None);
    }
    render_updated_core_yaml(&mut document, updated).map(Some)
}

pub(crate) fn restore_deepseek_harness_provider(
    current: &mut serde_norway::Mapping,
    original: Option<&serde_norway::Mapping>,
) -> Result<(), String> {
    let original_llm = original
        .and_then(|root| yaml_mapping_value(root, "llm-pi-ai"))
        .and_then(serde_norway::Value::as_mapping);
    let original_providers = original_llm
        .and_then(|llm| yaml_mapping_value(llm, "providers"))
        .and_then(serde_norway::Value::as_mapping);
    let original_provider = original_providers
        .and_then(|providers| yaml_mapping_value(providers, DEEPSEEK_HARNESS_PROVIDER_ID))
        .cloned();

    if let Some(original_provider) = original_provider {
        let llm = current
            .entry(yaml_key("llm-pi-ai"))
            .or_insert_with(|| serde_norway::Value::Mapping(serde_norway::Mapping::new()))
            .as_mapping_mut()
            .ok_or_else(|| "当前 DeepSeek Harness llm-pi-ai 必须是映射".to_string())?;
        let providers = llm
            .entry(yaml_key("providers"))
            .or_insert_with(|| serde_norway::Value::Mapping(serde_norway::Mapping::new()))
            .as_mapping_mut()
            .ok_or_else(|| "当前 DeepSeek Harness llm-pi-ai.providers 必须是映射".to_string())?;
        providers.insert(yaml_key(DEEPSEEK_HARNESS_PROVIDER_ID), original_provider);
    } else {
        let mut remove_llm = false;
        if let Some(llm) = current
            .get_mut(yaml_key("llm-pi-ai"))
            .and_then(serde_norway::Value::as_mapping_mut)
        {
            let mut remove_providers = false;
            if let Some(providers) = llm
                .get_mut(yaml_key("providers"))
                .and_then(serde_norway::Value::as_mapping_mut)
            {
                providers.remove(yaml_key(DEEPSEEK_HARNESS_PROVIDER_ID));
                remove_providers = providers.is_empty() && original_providers.is_none();
            }
            if remove_providers {
                llm.remove(yaml_key("providers"));
            }
            remove_llm = llm.is_empty() && original_llm.is_none();
        }
        if remove_llm {
            current.remove(yaml_key("llm-pi-ai"));
        }
    }
    Ok(())
}

pub(crate) fn build_restored_deepseek_harness_settings(
    current: &str,
    original: Option<&str>,
) -> Result<Option<String>, String> {
    let original_root = parse_agent_yaml_mapping(original, "原始 DeepSeek Harness settings")?;
    let rendered = render_agent_yaml_mapping_update(
        Some(current),
        "当前 DeepSeek Harness settings",
        |root| {
            restore_deepseek_harness_provider(root, Some(&original_root))?;
            restore_yaml_key(root, Some(&original_root), "agent-default-model");
            Ok(())
        },
    )?;
    let root = parse_agent_yaml_mapping(Some(&rendered), "恢复后的 DeepSeek Harness settings")?;
    Ok((!root.is_empty() || original.is_some()).then_some(rendered))
}

pub(crate) fn build_restored_deepseek_harness_credentials(
    current: &str,
    original: Option<&str>,
) -> Result<Option<String>, String> {
    let original_root = parse_agent_yaml_mapping(original, "原始 DeepSeek Harness credentials")?;
    let rendered = render_agent_yaml_mapping_update(
        Some(current),
        "当前 DeepSeek Harness credentials",
        |root| {
            restore_yaml_key(root, Some(&original_root), DEEPSEEK_HARNESS_CREDENTIAL);
            Ok(())
        },
    )?;
    let root = parse_agent_yaml_mapping(Some(&rendered), "恢复后的 DeepSeek Harness credentials")?;
    Ok((!root.is_empty() || original.is_some()).then_some(rendered))
}

pub(crate) fn agent_config_semantically_equal(
    client: AgentClient,
    actual: &str,
    expected: &str,
) -> bool {
    match client {
        AgentClient::Codex | AgentClient::KimiCode | AgentClient::GrokBuild => {
            toml::from_str::<toml::Value>(actual).ok()
                == toml::from_str::<toml::Value>(expected).ok()
        }
        AgentClient::OpenCode | AgentClient::OpenClaw => {
            json5::from_str::<serde_json::Value>(actual).ok()
                == json5::from_str::<serde_json::Value>(expected).ok()
        }
        AgentClient::Hermes => {
            serde_norway::from_str::<serde_norway::Value>(actual).ok()
                == serde_norway::from_str::<serde_norway::Value>(expected).ok()
        }
        AgentClient::DeepSeekHarness => {
            serde_norway::from_str::<serde_norway::Value>(actual).ok()
                == serde_norway::from_str::<serde_norway::Value>(expected).ok()
        }
        _ => {
            serde_json::from_str::<serde_json::Value>(actual).ok()
                == serde_json::from_str::<serde_json::Value>(expected).ok()
        }
    }
}

pub(crate) fn build_agent_session_restored_bytes(
    client: AgentClient,
    paths: &[PathBuf],
    path: &Path,
    current: Option<&[u8]>,
    original: Option<&[u8]>,
) -> Result<Option<Vec<u8>>, String> {
    let Some(current) = current else {
        return Ok(original.map(ToOwned::to_owned));
    };
    if client == AgentClient::Codex && paths.first().is_none_or(|config| config != path) {
        return Ok(original.map(ToOwned::to_owned));
    }
    let current = std::str::from_utf8(current)
        .map_err(|_| format!("当前智能体配置不是 UTF-8 文本: {}", path_to_string(path)))?;
    let original_bytes = original;
    let original = original_bytes
        .map(|bytes| {
            std::str::from_utf8(bytes)
                .map_err(|_| format!("原智能体配置不是 UTF-8 文本: {}", path_to_string(path)))
        })
        .transpose()?;
    let restored = match client {
        AgentClient::ClaudeCode => build_restored_claude_code_config(current, original)?,
        AgentClient::ClaudeDesktop => {
            let index = paths
                .iter()
                .position(|candidate| candidate == path)
                .ok_or_else(|| "Claude Desktop 恢复路径不匹配".to_string())?;
            build_restored_claude_desktop_config(index, current, original)?
        }
        AgentClient::Codex => build_restored_codex_agent_config(Some(current), original)?,
        AgentClient::OpenCode => build_restored_opencode_config(current, original)?,
        AgentClient::OpenClaw => build_restored_openclaw_config(current, original)?,
        AgentClient::Hermes => build_restored_hermes_config(current, original)?,
        AgentClient::DeepSeekHarness => {
            let index = paths
                .iter()
                .position(|candidate| candidate == path)
                .ok_or_else(|| "DeepSeek Harness 恢复路径不匹配".to_string())?;
            match index {
                0 => build_restored_deepseek_harness_settings(current, original)?,
                1 => build_restored_deepseek_harness_credentials(current, original)?,
                _ => return Err("DeepSeek Harness 恢复路径索引无效".to_string()),
            }
        }
        AgentClient::ZCode => build_restored_zcode_config(current, original)?,
        AgentClient::KimiCode => build_restored_kimi_code_config(current, original)?,
        AgentClient::GrokBuild => build_restored_grok_build_config(current, original)?,
    };
    if let (Some(restored), Some(original), Some(original_bytes)) =
        (restored.as_deref(), original, original_bytes)
    {
        if agent_config_semantically_equal(client, restored, original) {
            return Ok(Some(original_bytes.to_vec()));
        }
    }
    Ok(restored.map(String::into_bytes))
}

#[cfg(test)]
pub(crate) fn build_codex_agent_config(
    existing: Option<&str>,
    base_url: &str,
    api_key: &str,
    model: &str,
) -> Result<String, String> {
    build_codex_agent_config_with_oauth(existing, base_url, api_key, model, false, false)
}

pub(crate) fn build_codex_agent_config_with_oauth(
    existing: Option<&str>,
    base_url: &str,
    api_key: &str,
    model: &str,
    oauth_configuration: bool,
    remote_compaction: bool,
) -> Result<String, String> {
    use toml_edit::{value, Document, Item, Table};

    let mut document = match existing.filter(|value| !value.trim().is_empty()) {
        Some(value) => value
            .parse::<Document>()
            .map_err(|error| format!("Codex config.toml 格式无效: {error}"))?,
        None => Document::new(),
    };
    set_codex_table_item(
        document.as_table_mut(),
        "model_provider",
        value(MANAGED_AGENT_PROVIDER_ID),
    );
    set_codex_table_item(document.as_table_mut(), "model", value(model));
    set_codex_table_item(
        document.as_table_mut(),
        "model_catalog_json",
        value(CODEX_MODEL_CATALOG_FILE),
    );
    if !document
        .get("model_providers")
        .is_some_and(toml_edit::Item::is_table)
    {
        document.remove("model_providers");
        document["model_providers"] = Item::Table(Table::new());
    }
    let providers = document["model_providers"]
        .as_table_mut()
        .ok_or_else(|| "Codex model_providers 必须是 TOML 表".to_string())?;
    if !providers
        .get(MANAGED_AGENT_PROVIDER_ID)
        .is_some_and(toml_edit::Item::is_table)
    {
        providers.remove(MANAGED_AGENT_PROVIDER_ID);
        providers.insert(MANAGED_AGENT_PROVIDER_ID, Item::Table(Table::new()));
    }
    let provider = providers
        .get_mut(MANAGED_AGENT_PROVIDER_ID)
        .and_then(Item::as_table_mut)
        .ok_or_else(|| "Codex cpa-gui provider 必须是 TOML 表".to_string())?;
    // Codex currently uses the exact provider name `OpenAI` as its capability
    // marker for Remote Compaction V2. Keep the product name by default because
    // not every upstream account or proxy route supports the V2 response item.
    let provider_name = if remote_compaction {
        CODEX_REMOTE_COMPACTION_PROVIDER_NAME
    } else {
        CODEX_MANAGED_PROVIDER_NAME
    };
    set_codex_table_item(provider, "name", value(provider_name));
    set_codex_table_item(provider, "base_url", value(base_url));
    set_codex_table_item(provider, "wire_api", value("responses"));
    set_codex_table_item(provider, "experimental_bearer_token", value(api_key));
    if oauth_configuration {
        set_codex_table_item(provider, "requires_openai_auth", value(true));
    } else {
        provider.remove("requires_openai_auth");
    }
    let rendered = document.to_string();
    toml::from_str::<toml::Value>(&rendered)
        .map_err(|error| format!("验证 Codex 配置失败: {error}"))?;
    Ok(rendered)
}

pub(crate) fn build_codex_api_auth(api_key: &str) -> Result<String, String> {
    let mut rendered = serde_json::to_string_pretty(&serde_json::json!({
        "auth_mode": "apikey",
        "OPENAI_API_KEY": api_key,
    }))
    .map_err(|error| format!("生成 Codex auth.json 失败: {error}"))?;
    rendered.push('\n');
    Ok(rendered)
}

pub(crate) fn build_codex_auth_update(
    home: &Path,
    api_key: &str,
    oauth_configuration: bool,
) -> Result<AgentFileUpdate, String> {
    let path = codex_configuration_directory(home).join("auth.json");
    let after = if oauth_configuration {
        validate_codex_oauth_login_at(&path)?;
        read_optional_text(&path)?
            .ok_or_else(|| "Codex OAuth 登录凭据在应用配置前已被删除，请重新登录".to_string())?
    } else {
        build_codex_api_auth(api_key)?
    };
    Ok(AgentFileUpdate { path, after })
}

const CODEX_MANAGED_ROOT_KEYS: [&str; 3] = ["model_provider", "model", "model_catalog_json"];
const CODEX_MANAGED_PROVIDER_KEYS: [&str; 5] = [
    "name",
    "base_url",
    "wire_api",
    "experimental_bearer_token",
    "requires_openai_auth",
];

pub(crate) fn set_codex_table_item(
    table: &mut toml_edit::Table,
    key: &str,
    mut item: toml_edit::Item,
) {
    if let (Some(current), Some(next)) = (
        table.get(key).and_then(toml_edit::Item::as_value),
        item.as_value_mut(),
    ) {
        *next.decor_mut() = current.decor().clone();
    }
    *table.entry(key).or_insert(toml_edit::Item::None) = item;
}

pub(crate) fn restore_codex_table_item(
    current: &mut toml_edit::Table,
    original: Option<&toml_edit::Table>,
    key: &str,
) {
    let original_item = original.and_then(|table| table.get(key)).cloned();
    if let Some(item) = original_item {
        let existed = current.contains_key(key);
        let original_key_decor = original.and_then(|table| table.key_decor(key)).cloned();
        set_codex_table_item(current, key, item);
        if !existed {
            if let (Some(current_decor), Some(original_decor)) =
                (current.key_decor_mut(key), original_key_decor)
            {
                *current_decor = original_decor;
            }
        }
    } else {
        current.remove(key);
    }
}

pub(crate) fn parse_codex_document(
    content: Option<&str>,
    label: &str,
) -> Result<toml_edit::Document, String> {
    use toml_edit::Document;

    match content.filter(|value| !value.trim().is_empty()) {
        Some(value) => value
            .parse::<Document>()
            .map_err(|error| format!("{label} 格式无效: {error}")),
        None => Ok(Document::new()),
    }
}

pub(crate) fn codex_provider_table(document: &toml_edit::Document) -> Option<&toml_edit::Table> {
    document
        .as_table()
        .get("model_providers")
        .and_then(toml_edit::Item::as_table)
        .and_then(|providers| providers.get(MANAGED_AGENT_PROVIDER_ID))
        .and_then(toml_edit::Item::as_table)
}

pub(crate) fn ensure_codex_provider_table(
    document: &mut toml_edit::Document,
) -> Result<&mut toml_edit::Table, String> {
    use toml_edit::{Item, Table};

    let root = document.as_table_mut();
    if !root.contains_key("model_providers") {
        root.insert("model_providers", Item::Table(Table::new()));
    }
    let providers = root
        .get_mut("model_providers")
        .and_then(Item::as_table_mut)
        .ok_or_else(|| "Codex model_providers 必须是 TOML 表".to_string())?;
    if !providers.contains_key(MANAGED_AGENT_PROVIDER_ID) {
        providers.insert(MANAGED_AGENT_PROVIDER_ID, Item::Table(Table::new()));
    }
    providers
        .get_mut(MANAGED_AGENT_PROVIDER_ID)
        .and_then(Item::as_table_mut)
        .ok_or_else(|| "Codex cpa-gui provider 必须是 TOML 表".to_string())
}

pub(crate) fn merge_missing_codex_table_items(
    current: &mut toml_edit::Table,
    original: &toml_edit::Table,
) {
    for (key, original_item) in original.iter() {
        if !current.contains_key(key) {
            current.insert(key, original_item.clone());
            continue;
        }
        if let (Some(current_table), Some(original_table)) = (
            current.get_mut(key).and_then(toml_edit::Item::as_table_mut),
            original_item.as_table(),
        ) {
            merge_missing_codex_table_items(current_table, original_table);
        }
    }
}

pub(crate) fn build_restored_codex_agent_config(
    current: Option<&str>,
    original: Option<&str>,
) -> Result<Option<String>, String> {
    use toml_edit::Item;

    let mut current_document = parse_codex_document(current, "当前 Codex config.toml")?;
    let original_document = original
        .map(|content| parse_codex_document(Some(content), "原始 Codex config.toml"))
        .transpose()?;
    if let Some(original_document) = original_document.as_ref() {
        merge_missing_codex_table_items(
            current_document.as_table_mut(),
            original_document.as_table(),
        );
    }

    for key in CODEX_MANAGED_ROOT_KEYS {
        restore_codex_table_item(
            current_document.as_table_mut(),
            original_document
                .as_ref()
                .map(|document| document.as_table()),
            key,
        );
    }

    let original_provider_items = CODEX_MANAGED_PROVIDER_KEYS
        .into_iter()
        .map(|key| {
            (
                key,
                original_document
                    .as_ref()
                    .and_then(codex_provider_table)
                    .and_then(|provider| provider.get(key))
                    .cloned(),
            )
        })
        .collect::<Vec<_>>();
    let needs_provider = original_provider_items
        .iter()
        .any(|(_, item)| item.is_some());

    if needs_provider {
        let provider = ensure_codex_provider_table(&mut current_document)?;
        let original_provider = original_document.as_ref().and_then(codex_provider_table);
        for (key, item) in &original_provider_items {
            if item.is_some() {
                restore_codex_table_item(provider, original_provider, key);
            } else {
                provider.remove(key);
            }
        }
    } else if let Some(providers) = current_document
        .as_table_mut()
        .get_mut("model_providers")
        .and_then(Item::as_table_mut)
    {
        if let Some(provider) = providers
            .get_mut(MANAGED_AGENT_PROVIDER_ID)
            .and_then(Item::as_table_mut)
        {
            for key in CODEX_MANAGED_PROVIDER_KEYS {
                provider.remove(key);
            }
            if provider.is_empty() {
                providers.remove(MANAGED_AGENT_PROVIDER_ID);
            }
        }
    }

    let remove_providers = current_document
        .as_table()
        .get("model_providers")
        .and_then(Item::as_table)
        .is_some_and(toml_edit::Table::is_empty);
    if remove_providers {
        current_document.as_table_mut().remove("model_providers");
    }

    let rendered = current_document.to_string();
    toml::from_str::<toml::Value>(&rendered)
        .map_err(|error| format!("验证恢复后的 Codex 配置失败: {error}"))?;
    if original.is_none() && rendered.trim().is_empty() {
        Ok(None)
    } else {
        Ok(Some(rendered))
    }
}

pub(crate) fn validate_codex_catalog(catalog: &str, model: &str) -> Result<(), String> {
    let root: serde_json::Value = serde_json::from_str(catalog)
        .map_err(|error| format!("Codex 模型目录格式无效: {error}"))?;
    let models = root
        .get("models")
        .and_then(serde_json::Value::as_array)
        .filter(|models| !models.is_empty())
        .ok_or_else(|| "Codex 模型目录必须包含非空 models 数组".to_string())?;
    if !models.iter().any(|entry| {
        entry
            .get("slug")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|slug| slug.eq_ignore_ascii_case(model))
    }) {
        return Err(format!("默认模型 {model} 不在生成的 Codex 模型目录中"));
    }
    Ok(())
}

pub(crate) fn build_opencode_agent_config(
    existing: Option<&str>,
    base_url: &str,
    api_key: &str,
    model: &str,
    available_models: &[AgentModelOption],
) -> Result<String, String> {
    let mut root = parse_agent_json5_object(existing, "OpenCode opencode.json")?;
    root.entry("$schema".to_string())
        .or_insert_with(|| serde_json::json!("https://opencode.ai/config.json"));
    let providers = ensure_json_object_entry(&mut root, "provider");
    let models = ordered_agent_models(available_models, model)
        .into_iter()
        .map(|model| {
            let display_name = model.alias.as_deref().unwrap_or(&model.name).to_string();
            (model.name, serde_json::json!({ "name": display_name }))
        })
        .collect::<serde_json::Map<_, _>>();
    let managed_provider = ensure_json_object_entry(providers, MANAGED_AGENT_PROVIDER_ID);
    managed_provider.insert(
        "npm".to_string(),
        serde_json::json!("@ai-sdk/openai-compatible"),
    );
    managed_provider.insert("name".to_string(), serde_json::json!("EasyCLIProxyAPI"));
    let options = ensure_json_object_entry(managed_provider, "options");
    options.insert("baseURL".to_string(), serde_json::json!(base_url));
    options.insert("apiKey".to_string(), serde_json::json!(api_key));
    managed_provider.insert("models".to_string(), serde_json::Value::Object(models));
    root.insert(
        "model".to_string(),
        serde_json::json!(format!("{MANAGED_AGENT_PROVIDER_ID}/{model}")),
    );
    let rendered = render_agent_json(root, "OpenCode 配置")?;
    let comments = existing.map(extract_json5_comments).unwrap_or_default();
    if comments.is_empty() {
        Ok(rendered)
    } else {
        Ok(format!("{}\n{rendered}", comments.join("\n")))
    }
}

pub(crate) fn build_zcode_agent_config(
    existing: Option<&str>,
    base_url: &str,
    api_key: &str,
    model: &str,
    available_models: &[AgentModelOption],
) -> Result<String, String> {
    build_zcode_config(existing, base_url, api_key, model, available_models, false)
}

pub(crate) fn build_zcode_cli_agent_config(
    existing: Option<&str>,
    base_url: &str,
    api_key: &str,
    model: &str,
    available_models: &[AgentModelOption],
) -> Result<String, String> {
    build_zcode_config(existing, base_url, api_key, model, available_models, true)
}

fn build_zcode_config(
    existing: Option<&str>,
    base_url: &str,
    api_key: &str,
    model: &str,
    available_models: &[AgentModelOption],
    cli_config: bool,
) -> Result<String, String> {
    let mut root = parse_agent_json_object(existing, "ZCode config.json")?;
    let providers = ensure_json_object_entry(&mut root, "provider");
    let models = ordered_agent_models(available_models, model)
        .into_iter()
        .map(|model| {
            let display_name = model.alias.as_deref().unwrap_or(&model.name).to_string();
            let mut entry = serde_json::Map::new();
            entry.insert("name".to_string(), serde_json::json!(display_name));
            if let Some(context_window) = model.context_window {
                entry.insert(
                    "limit".to_string(),
                    serde_json::json!({ "context": context_window }),
                );
            }
            (model.name, serde_json::Value::Object(entry))
        })
        .collect::<serde_json::Map<_, _>>();
    let managed_provider = ensure_json_object_entry(providers, MANAGED_AGENT_PROVIDER_ID);
    managed_provider.insert("enabled".to_string(), serde_json::json!(true));
    managed_provider.insert("name".to_string(), serde_json::json!("EasyCLIProxyAPI"));
    managed_provider.insert("source".to_string(), serde_json::json!("custom"));
    managed_provider.insert("kind".to_string(), serde_json::json!("anthropic"));
    managed_provider.insert("defaultKind".to_string(), serde_json::json!("anthropic"));
    managed_provider.insert(
        "apiFormat".to_string(),
        serde_json::json!("anthropic-messages"),
    );
    managed_provider.insert("npm".to_string(), serde_json::json!("@ai-sdk/anthropic"));
    let options = ensure_json_object_entry(managed_provider, "options");
    options.insert("baseURL".to_string(), serde_json::json!(base_url));
    options.insert("apiKey".to_string(), serde_json::json!(api_key));
    managed_provider.insert("models".to_string(), serde_json::Value::Object(models));
    let model = format!("{MANAGED_AGENT_PROVIDER_ID}/{model}");
    if cli_config {
        ensure_json_object_entry(&mut root, "model")
            .insert("main".to_string(), serde_json::json!(model));
    } else {
        root.insert("model".to_string(), serde_json::json!(model));
    }
    render_agent_json(root, "ZCode 配置")
}

pub(crate) fn ensure_toml_child_table<'a>(
    parent: &'a mut toml_edit::Table,
    key: &str,
) -> &'a mut toml_edit::Table {
    use toml_edit::{Item, Table};

    if !parent.get(key).is_some_and(Item::is_table) {
        parent.remove(key);
        parent.insert(key, Item::Table(Table::new()));
    }
    parent
        .get_mut(key)
        .and_then(Item::as_table_mut)
        .expect("inserted TOML table must remain a table")
}

pub(crate) fn managed_model_alias(model: &str) -> String {
    format!("{MANAGED_AGENT_PROVIDER_ID}/{model}")
}

pub(crate) fn build_kimi_code_agent_config(
    existing: Option<&str>,
    base_url: &str,
    api_key: &str,
    model: &str,
    available_models: &[AgentModelOption],
) -> Result<String, String> {
    use toml_edit::{value, Array, Item, Table};

    let mut document = parse_codex_document(existing, "Kimi Code config.toml")?;
    set_codex_table_item(
        document.as_table_mut(),
        "default_model",
        value(managed_model_alias(model)),
    );

    let providers = ensure_toml_child_table(document.as_table_mut(), "providers");
    let provider = ensure_toml_child_table(providers, MANAGED_AGENT_PROVIDER_ID);
    set_codex_table_item(provider, "type", value("openai"));
    set_codex_table_item(provider, "base_url", value(base_url));
    set_codex_table_item(provider, "api_key", value(api_key));

    let models = ensure_toml_child_table(document.as_table_mut(), "models");
    let prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
    let stale = models
        .iter()
        .map(|(key, _)| key.to_string())
        .filter(|key| key.starts_with(&prefix))
        .collect::<Vec<_>>();
    for key in stale {
        models.remove(&key);
    }
    for option in ordered_agent_models(available_models, model) {
        let mut entry = Table::new();
        entry.insert("provider", value(MANAGED_AGENT_PROVIDER_ID));
        entry.insert("model", value(option.name.clone()));
        entry.insert(
            "display_name",
            value(option.alias.as_deref().unwrap_or(&option.name)),
        );
        let context = option
            .context_window
            .unwrap_or(200_000)
            .min(i64::MAX as u64) as i64;
        entry.insert("max_context_size", value(context));
        let mut capabilities = Array::new();
        capabilities.push("tool_use");
        entry.insert("capabilities", value(capabilities));
        models.insert(&managed_model_alias(&option.name), Item::Table(entry));
    }
    let rendered = document.to_string();
    toml::from_str::<toml::Value>(&rendered)
        .map_err(|error| format!("验证 Kimi Code 配置失败: {error}"))?;
    Ok(rendered)
}

pub(crate) fn build_grok_build_agent_config(
    existing: Option<&str>,
    base_url: &str,
    api_key: &str,
    model: &str,
    available_models: &[AgentModelOption],
) -> Result<String, String> {
    use toml_edit::{value, Item, Table};

    let mut document = parse_codex_document(existing, "Grok Build config.toml")?;
    let defaults = ensure_toml_child_table(document.as_table_mut(), "models");
    set_codex_table_item(defaults, "default", value(managed_model_alias(model)));

    let models = ensure_toml_child_table(document.as_table_mut(), "model");
    let prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
    let stale = models
        .iter()
        .map(|(key, _)| key.to_string())
        .filter(|key| key.starts_with(&prefix))
        .collect::<Vec<_>>();
    for key in stale {
        models.remove(&key);
    }
    for option in ordered_agent_models(available_models, model) {
        let mut entry = Table::new();
        entry.insert("model", value(option.name.clone()));
        entry.insert("base_url", value(base_url));
        entry.insert(
            "name",
            value(option.alias.as_deref().unwrap_or(&option.name)),
        );
        entry.insert("api_key", value(api_key));
        entry.insert("api_backend", value("chat_completions"));
        let context = option
            .context_window
            .unwrap_or(200_000)
            .min(i64::MAX as u64) as i64;
        entry.insert("context_window", value(context));
        models.insert(&managed_model_alias(&option.name), Item::Table(entry));
    }
    let rendered = document.to_string();
    toml::from_str::<toml::Value>(&rendered)
        .map_err(|error| format!("验证 Grok Build 配置失败: {error}"))?;
    Ok(rendered)
}

pub(crate) fn build_openclaw_agent_config(
    existing: Option<&str>,
    base_url: &str,
    api_key: &str,
    model: &str,
    available_models: &[AgentModelOption],
) -> Result<String, String> {
    let mut root = match existing.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => json5::from_str::<serde_json::Value>(value)
            .map_err(|error| format!("OpenClaw openclaw.json 格式无效: {error}"))?,
        None => serde_json::json!({}),
    };
    let root = root
        .as_object_mut()
        .ok_or_else(|| "OpenClaw openclaw.json 根节点必须是对象".to_string())?;
    let ordered_models = ordered_agent_models(available_models, model);
    let models = ensure_json_object_entry(root, "models");
    models
        .entry("mode".to_string())
        .or_insert_with(|| serde_json::json!("merge"));
    let providers = ensure_json_object_entry(models, "providers");
    let managed_provider = ensure_json_object_entry(providers, MANAGED_AGENT_PROVIDER_ID);
    managed_provider.insert("baseUrl".to_string(), serde_json::json!(base_url));
    managed_provider.insert("apiKey".to_string(), serde_json::json!(api_key));
    managed_provider.insert("api".to_string(), serde_json::json!("openai-completions"));
    managed_provider.insert(
        "models".to_string(),
        serde_json::Value::Array(
            ordered_models
                .iter()
                .map(|model| {
                    serde_json::json!({
                        "id": model.name.clone(),
                        "name": model.alias.as_deref().unwrap_or(&model.name),
                    })
                })
                .collect(),
        ),
    );
    let agents = ensure_json_object_entry(root, "agents");
    let defaults = ensure_json_object_entry(agents, "defaults");
    let default_model = ensure_json_object_entry(defaults, "model");
    default_model.insert(
        "primary".to_string(),
        serde_json::json!(format!("{MANAGED_AGENT_PROVIDER_ID}/{model}")),
    );
    let model_catalog = ensure_json_object_entry(defaults, "models");
    let managed_prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
    model_catalog.retain(|name, _| !name.starts_with(&managed_prefix));
    for model in &ordered_models {
        let name = format!("{MANAGED_AGENT_PROVIDER_ID}/{}", model.name);
        let value = model
            .alias
            .as_deref()
            .map(|alias| serde_json::json!({ "alias": alias }))
            .unwrap_or_else(|| serde_json::json!({}));
        model_catalog.insert(name, value);
    }
    let rendered = render_agent_json(root.clone(), "OpenClaw 配置")?;
    let comments = existing.map(extract_json5_comments).unwrap_or_default();
    if comments.is_empty() {
        Ok(rendered)
    } else {
        Ok(format!("{}\n{rendered}", comments.join("\n")))
    }
}

pub(crate) fn extract_json5_comments(content: &str) -> Vec<String> {
    let bytes = content.as_bytes();
    let mut comments = Vec::new();
    let mut index = 0;
    let mut quote = None;
    let mut escaped = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if let Some(active_quote) = quote {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == active_quote {
                quote = None;
            }
            index += 1;
            continue;
        }
        if matches!(byte, b'\'' | b'"') {
            quote = Some(byte);
            index += 1;
            continue;
        }
        if byte == b'/' && bytes.get(index + 1) == Some(&b'/') {
            let start = index;
            index += 2;
            while index < bytes.len() && !matches!(bytes[index], b'\r' | b'\n') {
                index += 1;
            }
            comments.push(content[start..index].to_string());
            continue;
        }
        if byte == b'/' && bytes.get(index + 1) == Some(&b'*') {
            let start = index;
            index += 2;
            while index + 1 < bytes.len() && !(bytes[index] == b'*' && bytes[index + 1] == b'/') {
                index += 1;
            }
            index = (index + 2).min(bytes.len());
            comments.push(content[start..index].to_string());
            continue;
        }
        index += 1;
    }
    comments
}

pub(crate) fn ensure_yaml_mapping_entry<'a>(
    root: &'a mut serde_norway::Mapping,
    key: &str,
) -> &'a mut serde_norway::Mapping {
    let key_value = serde_norway::Value::String(key.to_string());
    if !root
        .get(&key_value)
        .is_some_and(|value| value.as_mapping().is_some())
    {
        root.insert(
            key_value.clone(),
            serde_norway::Value::Mapping(serde_norway::Mapping::new()),
        );
    }
    root.get_mut(&key_value)
        .and_then(serde_norway::Value::as_mapping_mut)
        .expect("mapping entry was just normalized")
}

pub(crate) fn ensure_yaml_sequence_entry<'a>(
    root: &'a mut serde_norway::Mapping,
    key: &str,
) -> &'a mut Vec<serde_norway::Value> {
    let key_value = serde_norway::Value::String(key.to_string());
    if !root
        .get(&key_value)
        .is_some_and(|value| value.as_sequence().is_some())
    {
        root.insert(key_value.clone(), serde_norway::Value::Sequence(Vec::new()));
    }
    root.get_mut(&key_value)
        .and_then(serde_norway::Value::as_sequence_mut)
        .expect("sequence entry was just normalized")
}

pub(crate) fn build_hermes_agent_config(
    existing: Option<&str>,
    base_url: &str,
    api_key: &str,
    model: &str,
    available_models: &[AgentModelOption],
) -> Result<String, String> {
    let original = match existing.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => serde_norway::from_str::<serde_norway::Value>(value)
            .map_err(|error| format!("Hermes config.yaml 格式无效: {error}"))?,
        None => serde_norway::Value::Mapping(serde_norway::Mapping::new()),
    };
    let mut root = original.clone();
    let mapping = root
        .as_mapping_mut()
        .ok_or_else(|| "Hermes config.yaml 根节点必须是映射".to_string())?;
    let providers = ensure_yaml_sequence_entry(mapping, "custom_providers");
    let mut managed_provider = None;
    let mut retained_providers = Vec::with_capacity(providers.len());
    for provider in std::mem::take(providers) {
        match provider.get("name").and_then(serde_norway::Value::as_str) {
            Some(name) if name == MANAGED_AGENT_PROVIDER_ID => {
                if managed_provider.is_none() {
                    managed_provider = provider.as_mapping().cloned();
                }
            }
            Some(_) => retained_providers.push(provider),
            None => {}
        }
    }
    let provider_models = ordered_agent_models(available_models, model)
        .into_iter()
        .map(|model| (model.name, serde_json::json!({})))
        .collect::<serde_json::Map<_, _>>();
    let canonical_provider = serde_norway::to_value(serde_json::json!({
        "name": MANAGED_AGENT_PROVIDER_ID,
        "base_url": base_url,
        "api_key": api_key,
        "api_mode": "chat_completions",
        "model": model,
        "models": provider_models
    }))
    .map_err(|error| format!("生成 Hermes provider 失败: {error}"))?;
    let canonical_provider = canonical_provider
        .as_mapping()
        .ok_or_else(|| "生成 Hermes provider 失败: 根节点不是映射".to_string())?;
    let mut managed_provider = managed_provider.unwrap_or_default();
    for (key, value) in canonical_provider {
        managed_provider.insert(key.clone(), value.clone());
    }
    retained_providers.push(serde_norway::Value::Mapping(managed_provider));
    *providers = retained_providers;
    let model_config = ensure_yaml_mapping_entry(mapping, "model");
    model_config.insert(
        serde_norway::Value::String("default".to_string()),
        serde_norway::Value::String(model.to_string()),
    );
    model_config.insert(
        serde_norway::Value::String("provider".to_string()),
        serde_norway::Value::String(MANAGED_AGENT_PROVIDER_ID.to_string()),
    );
    let rendered = if let Some(existing) = existing.filter(|value| !value.trim().is_empty()) {
        render_yaml_value_changes(existing, &original, &root)?
    } else {
        serde_norway::to_string(&root).map_err(|error| format!("生成 Hermes 配置失败: {error}"))?
    };
    serde_norway::from_str::<serde_norway::Value>(&rendered)
        .map_err(|error| format!("验证 Hermes 配置失败: {error}"))?;
    Ok(rendered)
}
