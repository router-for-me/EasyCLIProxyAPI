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
    pub(crate) effort: Option<String>,
    pub(crate) fast: bool,
    pub(crate) service_tier: Option<String>,
}

// Used by backup/template comparisons, not as an alias editor version lock.
pub(crate) fn model_alias_config_revision(content: &str) -> Result<String, String> {
    let document = serde_norway::from_str::<serde_norway::Value>(content)
        .map_err(|error| format!("Failed to parse kernel YAML configuration: {error}"))?;
    let mut value = serde_json::to_value(document).map_err(|error| error.to_string())?;
    let root = value
        .as_object_mut()
        .ok_or("Kernel configuration root must be a YAML mapping")?;
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

#[cfg(test)]
pub(crate) fn model_alias_edit_context(
    content: &str,
    alias: &str,
    definitions: &[OAuthModelDefinitions],
) -> Result<ModelAliasEditContext, String> {
    model_alias_edit_context_for_mapping(content, alias, definitions, None)
}

pub(crate) fn model_alias_edit_context_for_mapping(
    content: &str,
    alias: &str,
    definitions: &[OAuthModelDefinitions],
    entry: Option<&ThinkingAliasEntry>,
) -> Result<ModelAliasEditContext, String> {
    let source = resolve_model_alias_edit_source_for_mapping(content, alias, definitions, entry)?.source;
    let document = serde_norway::from_str::<serde_norway::Value>(content)
        .map_err(|error| error.to_string())?;
    let root = document
        .as_mapping()
        .ok_or("Kernel configuration root must be a YAML mapping")?;
    Ok(ModelAliasEditContext {
        effort: find_thinking_alias_effort(root, alias, &source.protocol),
        fast: find_speed_alias_service_tier(root, alias, &source.protocol).as_deref()
            == Some("priority"),
        service_tier: find_speed_alias_service_tier(root, alias, &source.protocol),
        source,
    })
}

pub(crate) fn model_alias_edit_source_id(alias: &str) -> String {
    format!("alias-edit:{}", alias.to_ascii_lowercase())
}

fn editable_model_alias_for_mapping(
    root: &serde_norway::Mapping,
    alias: &str,
    entry: Option<&ThinkingAliasEntry>,
) -> Result<EditableModelAlias, String> {
    if let Some(entry) = entry {
        let position = &entry.position;
        let (models, location, provider, kind, protocol) = if position.section == "oauth-model-alias" {
            let channel = entry.oauth_channel.as_deref().and_then(oauth_alias_channel)
                .ok_or("Unknown OAuth alias channel")?;
            let models = root.get(yaml_key("oauth-model-alias"))
                .and_then(|channels| channels.get(channel.key));
            (models, ThinkingAliasSourceLocation::Oauth {
                channel: channel.key, force_mapping: channel.force_mapping,
            }, channel.provider.to_string(), channel.kind.to_string(), channel.protocol.to_string())
        } else {
            let (section, fallback, kind, protocol) = [
                ("codex-api-key", "Codex API", "codex-api", "codex"),
                ("openai-compatibility", "OpenAI-compatible", "openai-compatible", "openai"),
                ("claude-api-key", "Claude API", "claude-api", "claude"),
                ("gemini-api-key", "Gemini API", "gemini-api", "gemini"),
            ].into_iter().find(|(section, ..)| *section == position.section)
                .ok_or("Unknown model alias section")?;
            let provider_index = position.provider_index.ok_or("Missing alias provider position")?;
            let provider = root.get(yaml_key(section))
                .and_then(serde_norway::Value::as_sequence)
                .and_then(|providers| providers.get(provider_index))
                .and_then(serde_norway::Value::as_mapping)
                .ok_or("Alias provider no longer exists")?;
            (provider.get(yaml_key("models")), ThinkingAliasSourceLocation::ConfigModel {
                section, provider_index, model_index: position.model_index,
            }, thinking_alias_provider_name(provider, fallback, provider_index), kind.into(), protocol.into())
        };
        let model_list = models.and_then(serde_norway::Value::as_sequence)
            .ok_or("Alias model list no longer exists")?;
        let model_index = if model_list.get(position.model_index)
            .and_then(configured_model_identity)
            .is_some_and(|(upstream, client, _)| upstream == entry.source_model && client == entry.alias) {
            position.model_index
        } else {
            model_list.iter().position(|model| configured_model_identity(model)
                .is_some_and(|(upstream, client, _)| upstream == entry.source_model && client == entry.alias))
                .ok_or("Alias row moved or changed. Refresh the list and select it again")?
        };
        let model = &model_list[model_index];
        let location = match location {
            ThinkingAliasSourceLocation::ConfigModel { section, provider_index, .. } =>
                ThinkingAliasSourceLocation::ConfigModel { section, provider_index, model_index },
            other => other,
        };
        let (upstream, _client, display_name) = configured_model_identity(model)
            .ok_or("Invalid model alias record")?;
        return Ok(EditableModelAlias {
            source: ResolvedThinkingAliasSource {
                source: ThinkingAliasSource {
                    id: model_alias_edit_source_id(alias), model: upstream, display_name,
                    provider, kind, reasoning_levels: configured_model_reasoning_levels(model, &protocol), protocol,
                }, location,
            }, value: model.clone(), model_index,
        });
    }
    let mut matches = Vec::new();
    let mut matching_names = 0;
    for (section, provider, kind, protocol) in [
        ("codex-api-key", "Codex API", "codex-api", "codex"),
        (
            "openai-compatibility",
            "OpenAI-compatible",
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
            .ok_or_else(|| format!("{section} must be an array"))?;
        for (provider_index, value) in providers.iter().enumerate() {
            let Some(value) = value.as_mapping() else {
                continue;
            };
            let Some(models) = yaml_mapping_value(value, "models") else {
                continue;
            };
            let models = models
                .as_sequence()
                .ok_or_else(|| format!("{section}.models must be an array"))?;
            for (model_index, model) in models.iter().enumerate() {
                let Some((upstream, client, display_name)) = configured_model_identity(model)
                else {
                    continue;
                };
                if !client.eq_ignore_ascii_case(alias) {
                    continue;
                }
                let provider_name = thinking_alias_provider_name(value, provider, provider_index);
                if entry.is_some_and(|entry| {
                    entry.source_model != upstream || entry.provider != provider_name
                        || entry.kind != kind || entry.oauth_channel.is_some()
                }) {
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
                            provider: provider_name,
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
            .ok_or("oauth-model-alias must be a YAML mapping")?;
        for (channel_name, models) in channels {
            let models = models
                .as_sequence()
                .ok_or("oauth-model-alias channel configuration must be an array")?;
            for (model_index, model) in models.iter().enumerate() {
                let Some((upstream, client, display_name)) = configured_model_identity(model)
                else {
                    continue;
                };
                if !client.eq_ignore_ascii_case(alias) {
                    continue;
                }
                if entry.is_some_and(|entry| {
                    entry.source_model != upstream
                        || entry.oauth_channel.as_deref() != channel_name.as_str()
                }) {
                    continue;
                }
                matching_names += 1;
                if upstream == client {
                    continue;
                }
                let channel = channel_name
                    .as_str()
                    .and_then(oauth_alias_channel)
                    .ok_or("Editing model aliases for this OAuth channel is not supported yet")?;
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
        return Err("Alias does not exist or has multiple mappings with the same name. Refresh, check the configuration, and try again".to_string());
    }
    Ok(matches.remove(0))
}

#[cfg(test)]
pub(crate) fn resolve_model_alias_edit_source(
    content: &str,
    alias: &str,
    definitions: &[OAuthModelDefinitions],
) -> Result<ResolvedThinkingAliasSource, String> {
    resolve_model_alias_edit_source_for_mapping(content, alias, definitions, None)
}

pub(crate) fn resolve_model_alias_edit_source_for_mapping(
    content: &str,
    alias: &str,
    definitions: &[OAuthModelDefinitions],
    entry: Option<&ThinkingAliasEntry>,
) -> Result<ResolvedThinkingAliasSource, String> {
    let document = serde_norway::from_str::<serde_norway::Value>(content)
        .map_err(|error| format!("Failed to parse kernel YAML configuration: {error}"))?;
    let root = document
        .as_mapping()
        .ok_or("Kernel configuration root must be a YAML mapping")?;
    let mut source = editable_model_alias_for_mapping(root, alias, entry)?.source;
    if let ThinkingAliasSourceLocation::Oauth { channel, .. } = source.location {
        if let Some(model) = definitions
            .iter()
            .filter(|set| set.channel.key == channel && set.channel.supports_reasoning)
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

#[cfg(test)]
pub(crate) fn edit_model_alias_in_yaml(
    content: &str,
    original_alias: &str,
    source: &ResolvedThinkingAliasSource,
    alias: &str,
    effort: &str,
    fast: bool,
) -> Result<String, String> {
    edit_model_alias_in_yaml_for_mapping(content, original_alias, source, alias, effort, fast, None)
}

#[cfg(test)]
pub(crate) fn edit_model_alias_in_yaml_for_mapping(
    content: &str,
    original_alias: &str,
    source: &ResolvedThinkingAliasSource,
    alias: &str,
    effort: &str,
    fast: bool,
    entry: Option<&ThinkingAliasEntry>,
) -> Result<String, String> {
    edit_model_alias_with_tier_in_yaml_for_mapping(content, original_alias, source, alias, effort, fast.then_some("priority"), entry)
}

pub(crate) fn edit_model_alias_with_tier_in_yaml_for_mapping(
    content: &str,
    original_alias: &str,
    source: &ResolvedThinkingAliasSource,
    alias: &str,
    effort: &str,
    service_tier: Option<&str>,
    entry: Option<&ThinkingAliasEntry>,
) -> Result<String, String> {
    validate_alias_service_tier(service_tier)?;
    let fast = service_tier.is_some();
    if fast && !alias_source_supports_fast(source) {
        return Err("Fast supports only OpenAI-compatible API, Codex API, or Codex OAuth model sources".to_string());
    }
    let mut document = yaml_serde_edit::YamlValue::parse(content)
        .map_err(|error| format!("Failed to parse kernel YAML configuration: {error}"))?;
    let mut updated = document.get().clone();
    let root = updated
        .as_mapping_mut()
        .ok_or("Kernel configuration root must be a YAML mapping")?;
    let original = editable_model_alias_for_mapping(root, original_alias, entry)?;
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
                .ok_or("Source model configuration changed. Refresh and try again")?;
            let (upstream, _, _) = configured_model_identity(model).ok_or("Invalid source model configuration format")?;
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
        service_tier,
        change_effort: find_thinking_alias_effort(
            root,
            original_alias,
            &original.source.source.protocol,
        )
        .as_deref()
        .unwrap_or("")
            != effort,
        change_fast: find_speed_alias_service_tier(
            root,
            original_alias,
            &original.source.source.protocol,
        )
        .as_deref()
        .filter(|tier| matches!(*tier, "priority" | "ultrafast"))
            != service_tier,
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
        remove_editable_model_alias(root, &original)?;
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
            .ok_or("Model provider changed. Refresh and try again")?,
        ThinkingAliasSourceLocation::Oauth { channel, .. } => root
            .entry(yaml_key("oauth-model-alias"))
            .or_insert_with(|| serde_norway::Value::Mapping(Default::default()))
            .as_mapping_mut()
            .ok_or("oauth-model-alias must be a YAML mapping")?
            .entry(yaml_key(channel))
            .or_insert_with(|| serde_norway::Value::Sequence(Vec::new()))
            .as_sequence_mut()
            .ok_or("oauth-model-alias channel configuration must be an array")?,
    };
    if same_group {
        let model = models
            .get_mut(original.model_index)
            .ok_or("Original alias changed. Refresh and try again")?;
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

fn remove_editable_model_alias(root: &mut serde_norway::Mapping, original: &EditableModelAlias) -> Result<(), String> {
    let models = match &original.source.location {
        ThinkingAliasSourceLocation::ConfigModel { section, provider_index, .. } =>
            yaml_mapping_value_mut(root, section)
                .and_then(serde_norway::Value::as_sequence_mut)
                .and_then(|providers| providers.get_mut(*provider_index))
                .and_then(serde_norway::Value::as_mapping_mut)
                .and_then(|provider| yaml_mapping_value_mut(provider, "models"))
                .and_then(serde_norway::Value::as_sequence_mut),
        ThinkingAliasSourceLocation::Oauth { channel, .. } =>
            yaml_mapping_value_mut(root, "oauth-model-alias")
                .and_then(serde_norway::Value::as_mapping_mut)
                .and_then(|channels| yaml_mapping_value_mut(channels, channel))
                .and_then(serde_norway::Value::as_sequence_mut),
    }.ok_or("Original alias changed. Refresh and try again")?;
    if original.model_index >= models.len() { return Err("Original alias changed. Refresh and try again".to_string()); }
    models.remove(original.model_index);
    Ok(())
}

pub(crate) fn remove_model_alias_mapping_from_yaml(content: &str, alias: &str, entry: &ThinkingAliasEntry) -> Result<String, String> {
    let mut document = yaml_serde_edit::YamlValue::parse(content).map_err(|error| error.to_string())?;
    let mut updated = document.get().clone();
    let root = updated.as_mapping_mut().ok_or("Kernel configuration root must be a YAML mapping")?;
    let original = editable_model_alias_for_mapping(root, alias, Some(entry))?;
    remove_editable_model_alias(root, &original)?;
    let scope = AliasPayloadScope::after_removal(root, alias, None);
    remove_alias_payload_options(root, alias, &scope)?;
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
    service_tier: Option<&'a str>,
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
    let remaining = AliasPayloadScope::after_removal(root, original_alias, None);
    let mut found_effort = false;
    let mut found_fast = false;
    let payload = root
        .entry(yaml_key("payload"))
        .or_insert_with(|| serde_norway::Value::Mapping(Default::default()));
    let payload = payload.as_mapping_mut().ok_or("payload must be a YAML mapping")?;
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
            .ok_or_else(|| format!("payload.{section} must be an array"))?;
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
            let models = models.as_sequence().ok_or("payload.models must be an array")?;
            let (mut target, others): (Vec<_>, Vec<_>) =
                models.iter().cloned().partition(|model| {
                    thinking_payload_model_matches(model, original_alias, original_protocol)
                });
            if target.is_empty() {
                result.push(rule.clone());
                continue;
            }
            // Rules still used by another mapping stay in their original order.
            let retained: Vec<_> = if original_alias != alias || original_protocol != protocol {
                target
                    .iter()
                    .filter(|model| !remaining.matches(model, original_alias))
                    .cloned()
                    .collect()
            } else {
                Vec::new()
            };
            let mut others = others;
            others.extend(retained.iter().cloned());
            for model in &mut target {
                let model = model
                    .as_mapping_mut()
                    .ok_or("payload.models entries must be mappings")?;
                model.insert(
                    yaml_key("name"),
                    serde_norway::Value::String(alias.to_string()),
                );
                if (!retained.is_empty() && original_protocol != protocol)
                    || yaml_mapping_value(model, "protocol")
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
                        .ok_or("payload.override.params must be a mapping")?;
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
                                "This rule's reasoning configuration cannot be converted. Adjust it in the configuration before switching model protocols",
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
                        if let Some(tier) = edit.service_tier {
                            let replacement = serde_norway::Mapping::from_iter([(
                                yaml_key("service_tier"),
                                yaml_key(tier),
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
    if edit.change_fast && !found_fast {
        if let Some(tier) = edit.service_tier {
            params.insert(yaml_key("service_tier"), yaml_key(tier));
        }
    }
    append_alias_payload_override(root, alias, protocol, params)
}
