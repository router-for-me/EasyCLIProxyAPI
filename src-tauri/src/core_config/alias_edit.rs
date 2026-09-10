use super::*;

struct EditableModelAlias {
    source: ResolvedThinkingAliasSource,
    value: serde_norway::Value,
    model_index: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelAliasEditContext {
    pub(crate) source: ThinkingAliasSource,
    pub(crate) revision: String,
    pub(crate) effort: Option<String>,
    pub(crate) fast: bool,
}

pub(crate) fn validate_model_alias_revision(
    content: &str,
    revision: Option<&str>,
) -> Result<(), String> {
    if revision != Some(model_alias_config_revision(content)?.as_str()) {
        return Err("配置已变化，请关闭编辑器并刷新后重试".to_string());
    }
    Ok(())
}

pub(crate) fn model_alias_config_revision(content: &str) -> Result<String, String> {
    let document = serde_norway::from_str::<serde_norway::Value>(content)
        .map_err(|error| format!("解析内核 YAML 配置失败: {error}"))?;
    let mut value = serde_json::to_value(document).map_err(|error| error.to_string())?;
    let root = value
        .as_object_mut()
        .ok_or("内核配置顶层必须是 YAML 映射")?;
    if root
        .get("oauth-model-alias")
        .and_then(serde_json::Value::as_object)
        .is_some_and(|aliases| aliases.is_empty())
    {
        root.remove("oauth-model-alias");
    }
    value.sort_all_objects();
    Ok(sha256_bytes(
        serde_json::to_string(&value)
            .map_err(|error| error.to_string())?
            .as_bytes(),
    ))
}

pub(crate) fn model_alias_edit_context(
    content: &str,
    alias: &str,
    definitions: &[OAuthModelDefinitions],
) -> Result<ModelAliasEditContext, String> {
    let source = resolve_model_alias_edit_source(content, alias, definitions)?.source;
    let document = serde_norway::from_str::<serde_norway::Value>(content)
        .map_err(|error| error.to_string())?;
    let root = document
        .as_mapping()
        .ok_or("内核配置顶层必须是 YAML 映射")?;
    Ok(ModelAliasEditContext {
        effort: find_thinking_alias_effort(root, alias, &source.protocol),
        fast: find_speed_alias_service_tier(root, alias, &source.protocol).as_deref()
            == Some("priority"),
        source,
        revision: model_alias_config_revision(content)?,
    })
}

pub(crate) fn model_alias_edit_source_id(alias: &str) -> String {
    format!("alias-edit:{}", alias.to_ascii_lowercase())
}

fn editable_model_alias(
    root: &serde_norway::Mapping,
    alias: &str,
) -> Result<EditableModelAlias, String> {
    let mut matches = Vec::new();
    let mut matching_names = 0;
    for (section, provider, kind, protocol) in [
        ("codex-api-key", "Codex API", "codex-api", "codex"),
        (
            "openai-compatibility",
            "OpenAI 兼容",
            "openai-compatible",
            "openai",
        ),
        ("claude-api-key", "Claude API", "claude-api", "claude"),
        ("gemini-api-key", "Gemini API", "gemini-api", "gemini"),
    ] {
        let Some(providers) = yaml_mapping_value(root, section) else {
            continue;
        };
        let providers = providers
            .as_sequence()
            .ok_or_else(|| format!("{section} 必须是数组"))?;
        for (provider_index, value) in providers.iter().enumerate() {
            let Some(value) = value.as_mapping() else {
                continue;
            };
            let Some(models) = yaml_mapping_value(value, "models") else {
                continue;
            };
            let models = models
                .as_sequence()
                .ok_or_else(|| format!("{section}.models 必须是数组"))?;
            for (model_index, model) in models.iter().enumerate() {
                let Some((upstream, client, display_name)) = configured_model_identity(model)
                else {
                    continue;
                };
                if !client.eq_ignore_ascii_case(alias) {
                    continue;
                }
                matching_names += 1;
                if upstream == client {
                    continue;
                }
                matches.push(EditableModelAlias {
                    source: ResolvedThinkingAliasSource {
                        source: ThinkingAliasSource {
                            id: model_alias_edit_source_id(alias),
                            model: upstream,
                            display_name,
                            provider: thinking_alias_provider_name(value, provider, provider_index),
                            kind: kind.to_string(),
                            protocol: protocol.to_string(),
                            reasoning_levels: configured_model_reasoning_levels(model, protocol),
                        },
                        location: ThinkingAliasSourceLocation::ConfigModel {
                            section,
                            provider_index,
                            model_index,
                        },
                    },
                    value: model.clone(),
                    model_index,
                });
            }
        }
    }
    if let Some(channels) = yaml_mapping_value(root, "oauth-model-alias") {
        let channels = channels
            .as_mapping()
            .ok_or("oauth-model-alias 必须是 YAML 映射")?;
        for (channel_name, models) in channels {
            let models = models
                .as_sequence()
                .ok_or("oauth-model-alias 的通道配置必须是数组")?;
            for (model_index, model) in models.iter().enumerate() {
                let Some((upstream, client, display_name)) = configured_model_identity(model)
                else {
                    continue;
                };
                if !client.eq_ignore_ascii_case(alias) {
                    continue;
                }
                matching_names += 1;
                if upstream == client {
                    continue;
                }
                let channel = channel_name
                    .as_str()
                    .and_then(oauth_alias_channel)
                    .ok_or("暂不支持编辑此 OAuth 通道的模型别名")?;
                matches.push(EditableModelAlias {
                    source: ResolvedThinkingAliasSource {
                        source: ThinkingAliasSource {
                            id: model_alias_edit_source_id(alias),
                            model: upstream,
                            display_name,
                            provider: channel.provider.to_string(),
                            kind: channel.kind.to_string(),
                            protocol: channel.protocol.to_string(),
                            reasoning_levels: Vec::new(),
                        },
                        location: ThinkingAliasSourceLocation::Oauth {
                            channel: channel.key,
                            force_mapping: channel.force_mapping,
                        },
                    },
                    value: model.clone(),
                    model_index,
                });
            }
        }
    }
    if matching_names != 1 || matches.len() != 1 {
        return Err("别名不存在或存在多个同名映射，请刷新并检查配置后重试".to_string());
    }
    Ok(matches.remove(0))
}

pub(crate) fn resolve_model_alias_edit_source(
    content: &str,
    alias: &str,
    definitions: &[OAuthModelDefinitions],
) -> Result<ResolvedThinkingAliasSource, String> {
    let document = serde_norway::from_str::<serde_norway::Value>(content)
        .map_err(|error| format!("解析内核 YAML 配置失败: {error}"))?;
    let root = document
        .as_mapping()
        .ok_or("内核配置顶层必须是 YAML 映射")?;
    let mut source = editable_model_alias(root, alias)?.source;
    if let ThinkingAliasSourceLocation::Oauth { channel, .. } = source.location {
        if let Some(model) = definitions
            .iter()
            .filter(|set| set.channel.key == channel)
            .flat_map(|set| &set.models)
            .find(|model| model.id.eq_ignore_ascii_case(&source.source.model))
        {
            source.source.reasoning_levels = model.reasoning_levels.clone();
        }
    }
    if let Some(effort) = find_thinking_alias_effort(root, alias, &source.source.protocol) {
        if !source.source.reasoning_levels.contains(&effort) {
            source.source.reasoning_levels.push(effort);
        }
    }
    Ok(source)
}

pub(crate) fn edit_model_alias_in_yaml(
    content: &str,
    original_alias: &str,
    source: &ResolvedThinkingAliasSource,
    alias: &str,
    effort: &str,
    fast: bool,
) -> Result<String, String> {
    if fast && !alias_source_supports_fast(source) {
        return Err("Fast 仅支持 OpenAI 兼容 API、Codex API 或 Codex OAuth 模型源".to_string());
    }
    let mut document = yaml_serde_edit::YamlValue::parse(content)
        .map_err(|error| format!("解析内核 YAML 配置失败: {error}"))?;
    let mut updated = document.get().clone();
    let root = updated
        .as_mapping_mut()
        .ok_or("内核配置顶层必须是 YAML 映射")?;
    let original = editable_model_alias(root, original_alias)?;
    if !alias.eq_ignore_ascii_case(original_alias) && configured_model_alias_exists(root, alias) {
        return Err(format!("别名模型 {alias} 已存在"));
    }
    let mut replacement = match &source.location {
        ThinkingAliasSourceLocation::ConfigModel {
            section,
            provider_index,
            model_index,
        } => {
            let model = yaml_mapping_value(root, section)
                .and_then(serde_norway::Value::as_sequence)
                .and_then(|providers| providers.get(*provider_index))
                .and_then(serde_norway::Value::as_mapping)
                .and_then(|provider| yaml_mapping_value(provider, "models"))
                .and_then(serde_norway::Value::as_sequence)
                .and_then(|models| models.get(*model_index))
                .ok_or("原模型配置已经变化，请刷新后重试")?;
            let (upstream, _, _) = configured_model_identity(model).ok_or("原模型配置格式无效")?;
            let same_model = matches!(&original.source.location,
                ThinkingAliasSourceLocation::ConfigModel { section: old_section, provider_index: old_provider, .. }
                if old_section == section && old_provider == provider_index)
                && original.source.source.model == upstream;
            let mut mapping = if same_model {
                original.value.as_mapping().cloned()
            } else {
                model.as_mapping().cloned()
            }
            .unwrap_or_default();
            mapping.insert(yaml_key("name"), serde_norway::Value::String(upstream));
            mapping
        }
        ThinkingAliasSourceLocation::Oauth {
            channel,
            force_mapping,
        } => {
            let same_channel = matches!(&original.source.location,
                ThinkingAliasSourceLocation::Oauth { channel: old_channel, .. } if old_channel == channel);
            let mut mapping = if same_channel {
                original.value.as_mapping().cloned().unwrap_or_default()
            } else {
                serde_norway::Mapping::new()
            };
            mapping.insert(
                yaml_key("name"),
                serde_norway::Value::String(source.source.model.clone()),
            );
            if !same_channel {
                mapping.insert(yaml_key("fork"), serde_norway::Value::Bool(true));
                if *force_mapping {
                    mapping.insert(yaml_key("force-mapping"), serde_norway::Value::Bool(true));
                }
            }
            mapping
        }
    };
    replacement.insert(
        yaml_key("alias"),
        serde_norway::Value::String(alias.to_string()),
    );
    let same_group = match (&original.source.location, &source.location) {
        (
            ThinkingAliasSourceLocation::ConfigModel {
                section: a,
                provider_index: ai,
                ..
            },
            ThinkingAliasSourceLocation::ConfigModel {
                section: b,
                provider_index: bi,
                ..
            },
        ) => a == b && ai == bi,
        (
            ThinkingAliasSourceLocation::Oauth { channel: a, .. },
            ThinkingAliasSourceLocation::Oauth { channel: b, .. },
        ) => a == b,
        _ => false,
    };
    let payload_edit = AliasPayloadEdit {
        source: &source.source,
        effort,
        fast,
        change_effort: find_thinking_alias_effort(
            root,
            original_alias,
            &original.source.source.protocol,
        )
        .as_deref()
        .unwrap_or("")
            != effort,
        change_fast: (find_speed_alias_service_tier(
            root,
            original_alias,
            &original.source.source.protocol,
        )
        .as_deref()
            == Some("priority"))
            != fast,
    };
    if same_group
        && original.value.as_mapping() == Some(&replacement)
        && original.source.source.protocol == source.source.protocol
        && !payload_edit.change_effort
        && !payload_edit.change_fast
    {
        return Ok(content.to_string());
    }
    if !same_group {
        remove_existing_claude_model_alias(root, original_alias)?;
    }
    let models = match &source.location {
        ThinkingAliasSourceLocation::ConfigModel {
            section,
            provider_index,
            ..
        } => yaml_mapping_value_mut(root, section)
            .and_then(serde_norway::Value::as_sequence_mut)
            .and_then(|providers| providers.get_mut(*provider_index))
            .and_then(serde_norway::Value::as_mapping_mut)
            .and_then(|provider| yaml_mapping_value_mut(provider, "models"))
            .and_then(serde_norway::Value::as_sequence_mut)
            .ok_or("模型提供商已经变化，请刷新后重试")?,
        ThinkingAliasSourceLocation::Oauth { channel, .. } => root
            .entry(yaml_key("oauth-model-alias"))
            .or_insert_with(|| serde_norway::Value::Mapping(Default::default()))
            .as_mapping_mut()
            .ok_or("oauth-model-alias 必须是 YAML 映射")?
            .entry(yaml_key(channel))
            .or_insert_with(|| serde_norway::Value::Sequence(Vec::new()))
            .as_sequence_mut()
            .ok_or("oauth-model-alias 的通道配置必须是数组")?,
    };
    if same_group {
        let model = models
            .get_mut(original.model_index)
            .ok_or("原别名已经变化，请刷新后重试")?;
        *model = serde_norway::Value::Mapping(replacement);
    } else {
        models.push(serde_norway::Value::Mapping(replacement));
    }
    edit_alias_payload(
        root,
        original_alias,
        &original.source.source.protocol,
        alias,
        &payload_edit,
    )?;
    render_updated_core_yaml(&mut document, updated)
}

pub(crate) const ALIAS_EFFORT_KEYS: &[&str] = &[
    "reasoning.effort",
    "reasoning_effort",
    "output_config.effort",
    "generationConfig.thinkingConfig.thinkingLevel",
    "thinking.effort",
    "thinking.type",
];

struct AliasPayloadEdit<'a> {
    source: &'a ThinkingAliasSource,
    effort: &'a str,
    fast: bool,
    change_effort: bool,
    change_fast: bool,
}

fn insert_alias_edit_params(
    params: &mut serde_norway::Mapping,
    replacement: serde_norway::Mapping,
    raw: bool,
) -> Result<(), String> {
    for (key, value) in replacement {
        let value = if raw {
            serde_norway::Value::String(
                serde_json::to_string(&value).map_err(|error| error.to_string())?,
            )
        } else {
            value
        };
        params.insert(key, value);
    }
    Ok(())
}

fn edit_alias_payload(
    root: &mut serde_norway::Mapping,
    original_alias: &str,
    original_protocol: &str,
    alias: &str,
    edit: &AliasPayloadEdit<'_>,
) -> Result<(), String> {
    let protocol = &edit.source.protocol;
    let mut found_effort = false;
    let mut found_fast = false;
    let payload = root
        .entry(yaml_key("payload"))
        .or_insert_with(|| serde_norway::Value::Mapping(Default::default()));
    let payload = payload.as_mapping_mut().ok_or("payload 必须是 YAML 映射")?;
    for section in [
        "default",
        "default-raw",
        "override",
        "override-raw",
        "filter",
    ] {
        let Some(rules) = yaml_mapping_value_mut(payload, section) else {
            continue;
        };
        let rules = rules
            .as_sequence_mut()
            .ok_or_else(|| format!("payload.{section} 必须是数组"))?;
        let mut result = Vec::new();
        for rule in rules.iter() {
            let Some(mapping) = rule.as_mapping() else {
                result.push(rule.clone());
                continue;
            };
            let Some(models) = yaml_mapping_value(mapping, "models") else {
                result.push(rule.clone());
                continue;
            };
            let models = models.as_sequence().ok_or("payload.models 必须是数组")?;
            let (mut target, others): (Vec<_>, Vec<_>) =
                models.iter().cloned().partition(|model| {
                    thinking_payload_model_matches(model, original_alias, original_protocol)
                });
            if target.is_empty() {
                result.push(rule.clone());
                continue;
            }
            for model in &mut target {
                let model = model
                    .as_mapping_mut()
                    .ok_or("payload.models 条目必须是映射")?;
                model.insert(
                    yaml_key("name"),
                    serde_norway::Value::String(alias.to_string()),
                );
                if yaml_mapping_value(model, "protocol")
                    .and_then(serde_norway::Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty())
                {
                    model.insert(
                        yaml_key("protocol"),
                        serde_norway::Value::String(protocol.to_string()),
                    );
                }
            }
            let mut edited = mapping.clone();
            edited.insert(yaml_key("models"), serde_norway::Value::Sequence(target));
            let mut remove_target = false;
            if matches!(section, "override" | "override-raw") {
                if let Some(params) = yaml_mapping_value_mut(&mut edited, "params") {
                    let params = params
                        .as_mapping_mut()
                        .ok_or("payload.override.params 必须是映射")?;
                    let has_effort = ALIAS_EFFORT_KEYS
                        .iter()
                        .any(|key| params.contains_key(yaml_key(key)));
                    let has_fast = params.contains_key(yaml_key("service_tier"));
                    found_effort |= has_effort;
                    found_fast |= has_fast;
                    let raw = section == "override-raw";
                    if has_effort && (edit.change_effort || original_protocol != protocol) {
                        let effort = if edit.change_effort {
                            edit.effort.to_string()
                        } else {
                            thinking_effort_from_params(params, original_protocol, raw).ok_or(
                                "此规则的思考配置无法转换，请先在配置中调整后再切换模型协议",
                            )?
                        };
                        for key in ALIAS_EFFORT_KEYS {
                            params.remove(yaml_key(key));
                        }
                        if !effort.is_empty() {
                            let mut replacement = serde_norway::Mapping::new();
                            insert_thinking_effort_params(&mut replacement, edit.source, &effort)?;
                            insert_alias_edit_params(params, replacement, raw)?;
                        }
                    }
                    if has_fast && edit.change_fast {
                        params.remove(yaml_key("service_tier"));
                        if edit.fast {
                            let replacement = serde_norway::Mapping::from_iter([(
                                yaml_key("service_tier"),
                                yaml_key("priority"),
                            )]);
                            insert_alias_edit_params(params, replacement, raw)?;
                        }
                    }
                    remove_target = params.is_empty();
                }
            }
            let mut unchanged = mapping.clone();
            unchanged.insert(yaml_key("models"), edited[yaml_key("models")].clone());
            if !remove_target
                && original_alias == alias
                && original_protocol == protocol
                && edited == unchanged
            {
                result.push(rule.clone());
                continue;
            }
            if !others.is_empty() {
                let mut shared = mapping.clone();
                shared.insert(yaml_key("models"), serde_norway::Value::Sequence(others));
                result.push(serde_norway::Value::Mapping(shared));
            }
            if !remove_target {
                result.push(serde_norway::Value::Mapping(edited));
            }
        }
        *rules = result;
        if rules.is_empty() {
            payload.remove(yaml_key(section));
        }
    }
    if payload.is_empty() {
        root.remove(yaml_key("payload"));
    }
    let mut params = serde_norway::Mapping::new();
    if edit.change_effort && !found_effort && !edit.effort.is_empty() {
        insert_thinking_effort_params(&mut params, edit.source, edit.effort)?;
    }
    if edit.change_fast && !found_fast && edit.fast {
        params.insert(yaml_key("service_tier"), yaml_key("priority"));
    }
    append_alias_payload_override(root, alias, protocol, params)
}
