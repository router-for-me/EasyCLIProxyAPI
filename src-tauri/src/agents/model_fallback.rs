use super::*;
use serde_norway::{Mapping, Value};

#[cfg(test)]
mod tests;

const ALIAS_PREFIX: &str = "claude-cpa-fallback-";
const METADATA_PREFIX: &str = "EasyCLIProxyAPI model fallback v1";
const DEFAULT_HOPS: usize = 2;
const MAX_HOPS: usize = 8;
const CONFLICT: &str = "Kernel configuration changed. Refresh the model fallback editor and retry";
static SAVE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentModelFallback {
    model: String,
    primary: String,
    fallbacks: Vec<String>,
    revision: String,
}

struct Snapshot {
    content: String,
    revision: String,
}

fn validate_scope(client: &str, slot: &str) -> Result<(), String> {
    for (name, value) in [("client", client), ("slot", slot)] {
        if value.is_empty()
            || value.len() > 48
            || !value.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
            })
            || !value.as_bytes()[0].is_ascii_alphanumeric()
        {
            return Err(format!("Invalid fallback {name}; use 1-48 lowercase letters, digits, hyphens or underscores"));
        }
    }
    Ok(())
}

fn parse_native(content: &str) -> Result<Value, String> {
    let value: Value = serde_norway::from_str(content)
        .map_err(|error| format!("Failed to parse kernel YAML configuration: {error}"))?;
    if value.as_mapping().is_none()
        || value.get("config-version").and_then(Value::as_u64) != Some(8)
    {
        return Err("Agent model fallback requires a native v8 kernel configuration".into());
    }
    Ok(value)
}

fn legacy_view(content: &str) -> Result<Mapping, String> {
    serde_norway::from_str::<Value>(&management_v8_yaml_to_legacy_view(content)?)
        .map_err(|error| error.to_string())?
        .as_mapping()
        .cloned()
        .ok_or_else(|| "Kernel configuration root must be a YAML mapping".into())
}

fn metadata(client: &str, slot: &str, primary: &str) -> String {
    format!("{METADATA_PREFIX} [{client}/{slot}]: {primary}")
}

fn alias_name(client: &str, slot: &str, primary: &str, fallbacks: &[String]) -> String {
    // Numeric encoding avoids Desktop's non-Claude family-name filters, even for
    // clients such as codex and gemini. All 256 hash bits remain in the alias.
    let encoded = serde_json::to_vec(&(client, slot, primary, fallbacks))
        .expect("strings always serialize to JSON");
    let hash = Sha256::digest(&encoded);
    let suffix: String = hash.iter().map(|byte| format!("{byte:03}")).collect();
    format!("{ALIAS_PREFIX}{suffix}")
}

fn alias_entries<'a>(root: &'a Mapping, alias: &str) -> Vec<&'a Value> {
    let mut entries = Vec::new();
    for (section, _) in V8_PROVIDER_FAMILIES {
        if let Some(providers) = root.get(yaml_key(section)).and_then(Value::as_sequence) {
            for provider in providers {
                if let Some(models) = provider.get("models").and_then(Value::as_sequence) {
                    entries.extend(models.iter());
                }
            }
        }
    }
    if let Some(channels) = root
        .get(yaml_key("oauth-model-alias"))
        .and_then(Value::as_mapping)
    {
        for models in channels.values().filter_map(Value::as_sequence) {
            entries.extend(models.iter());
        }
    }
    entries.retain(|entry| {
        configured_model_identity(entry)
            .is_some_and(|(_, name, _)| name.eq_ignore_ascii_case(alias))
    });
    entries
}

fn describe(
    content: &str,
    revision: &str,
    client: &str,
    slot: &str,
    model: &str,
) -> Result<AgentModelFallback, String> {
    validate_scope(client, slot)?;
    let model = validate_thinking_alias_model_id(model, "model")?;
    let native = parse_native(content)?;
    let mut descriptor = AgentModelFallback {
        primary: model.clone(),
        model: model.clone(),
        fallbacks: Vec::new(),
        revision: revision.into(),
    };
    if !model.starts_with(ALIAS_PREFIX) {
        return Ok(descriptor);
    }
    let root = legacy_view(content)?;
    let entries = alias_entries(&root, &model);
    let marker = metadata(client, slot, "");
    let primaries: Vec<_> = entries
        .iter()
        .filter_map(|entry| {
            configured_model_identity(entry)?
                .2?
                .strip_prefix(&marker)
                .map(str::to_owned)
        })
        .collect();
    let Some(primary) = primaries.first() else {
        return Ok(descriptor);
    };
    if primaries.len() != entries.len() || primaries.iter().any(|value| value != primary) {
        return Ok(descriptor);
    }
    let Some(targets) = native
        .get("routing")
        .and_then(|routing| routing.get("model-fallback"))
        .and_then(|policy| policy.get("chains"))
        .and_then(|chains| chains.get(&model))
        .and_then(Value::as_sequence)
    else {
        return Ok(descriptor);
    };
    let Some(fallbacks) = targets
        .iter()
        .map(|target| target.as_str().map(str::to_owned))
        .collect::<Option<Vec<_>>>()
    else {
        return Ok(descriptor);
    };
    if !fallbacks.is_empty() && alias_name(client, slot, primary, &fallbacks) == model {
        descriptor.primary = primary.clone();
        descriptor.fallbacks = fallbacks;
    }
    Ok(descriptor)
}

fn child_mapping<'a>(root: &'a mut Mapping, name: &str) -> Result<&'a mut Mapping, String> {
    root.entry(yaml_key(name))
        .or_insert_with(|| Value::Mapping(Mapping::new()))
        .as_mapping_mut()
        .ok_or_else(|| format!("Kernel configuration {name} must be an object"))
}

fn model_matches(entry: &Value, primary: &str, allow_upstream: bool) -> bool {
    configured_model_identity(entry).is_some_and(|(upstream, name, _)| {
        name.eq_ignore_ascii_case(primary)
            || (allow_upstream && upstream.eq_ignore_ascii_case(primary))
    })
}

fn mark_entry(entry: &mut Value, marker: &str) -> Result<(), String> {
    entry
        .as_mapping_mut()
        .ok_or("Invalid generated model alias")?
        .insert(yaml_key("display-name"), yaml_key(marker));
    Ok(())
}

fn append_aliases(
    root: &mut Mapping,
    primary: &str,
    alias: &str,
    marker: &str,
    definitions: &[OAuthModelDefinitions],
) -> Result<(), String> {
    let sources = root.clone();
    let allow_upstream = alias_entries(&sources, primary).is_empty()
        && !definitions.iter().any(|definition| {
            definition
                .models
                .iter()
                .any(|model| model.id.eq_ignore_ascii_case(primary))
        });
    let mut added = false;
    // The shared helper selects one source. Run it on each matching source in
    // isolation, then merge only its new alias, never its removal operations.
    for (section, _) in V8_PROVIDER_FAMILIES {
        let Some(providers) = sources.get(yaml_key(section)).and_then(Value::as_sequence) else {
            continue;
        };
        for (index, provider) in providers.iter().enumerate() {
            let Some(mapping) = provider.as_mapping() else {
                continue;
            };
            let matches: Vec<_> = provider
                .get("models")
                .and_then(Value::as_sequence)
                .into_iter()
                .flatten()
                .filter(|model| model_matches(model, primary, allow_upstream))
                .collect();
            if !configured_provider_model_is_enabled(mapping, primary)
                || !configured_provider_model_is_enabled(mapping, alias)
                || !matches.iter().any(|model| {
                    configured_model_identity(model).is_some_and(|(upstream, name, _)| {
                        configured_provider_model_is_enabled(mapping, &upstream)
                            && configured_provider_model_is_enabled(mapping, &name)
                    })
                })
            {
                continue;
            }
            for model in matches {
                if !configured_model_identity(model).is_some_and(|(upstream, name, _)| {
                    configured_provider_model_is_enabled(mapping, &upstream)
                        && configured_provider_model_is_enabled(mapping, &name)
                }) {
                    continue;
                }
                let mut one_provider = mapping.clone();
                one_provider.insert(yaml_key("models"), Value::Sequence(vec![model.clone()]));
                let mut isolated = Mapping::new();
                isolated.insert(
                    yaml_key(section),
                    Value::Sequence(vec![Value::Mapping(one_provider)]),
                );
                let source = isolated.clone();
                ensure_claude_desktop_model_alias(&mut isolated, &source, primary, alias, &[])?;
                let mut generated = alias_entries(&isolated, alias)
                    .first()
                    .map(|entry| (**entry).clone())
                    .ok_or("No source route was created for the fallback alias")?;
                mark_entry(&mut generated, marker)?;
                let models = root
                    .get_mut(yaml_key(section))
                    .and_then(Value::as_sequence_mut)
                    .and_then(|providers| providers.get_mut(index))
                    .and_then(|provider| provider.get_mut("models"))
                    .and_then(Value::as_sequence_mut)
                    .ok_or("Model source changed")?;
                models.push(generated);
                added = true;
            }
        }
    }
    let channels = sources
        .get(yaml_key("oauth-model-alias"))
        .and_then(Value::as_mapping)
        .cloned()
        .unwrap_or_default();
    let mut channel_names: std::collections::BTreeSet<String> = channels
        .keys()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    channel_names.extend(
        definitions
            .iter()
            .map(|definition| definition.channel.key.to_owned()),
    );
    for channel in channel_names {
        let models = channels
            .get(yaml_key(&channel))
            .and_then(Value::as_sequence)
            .cloned()
            .unwrap_or_default();
        let definitions: Vec<_> = definitions
            .iter()
            .filter(|definition| definition.channel.key == channel)
            .cloned()
            .collect();
        let matching: Vec<_> = models
            .into_iter()
            .filter(|model| model_matches(model, primary, allow_upstream))
            .collect();
        let direct = definitions.iter().any(|definition| {
            definition
                .models
                .iter()
                .any(|model| model.id.eq_ignore_ascii_case(primary))
        });
        if matching.is_empty() && !direct {
            continue;
        }
        // One public alias may pool several upstream models in this channel.
        // Preserve every pool member, not only the helper's first match.
        let sources: Vec<Vec<Value>> = if matching.is_empty() {
            vec![Vec::new()]
        } else {
            matching.into_iter().map(|model| vec![model]).collect()
        };
        for models in sources {
            let mut isolated = Mapping::new();
            child_mapping(&mut isolated, "oauth-model-alias")?
                .insert(yaml_key(&channel), Value::Sequence(models));
            let source = isolated.clone();
            ensure_claude_desktop_model_alias(
                &mut isolated,
                &source,
                primary,
                alias,
                &definitions,
            )?;
            let mut generated = alias_entries(&isolated, alias)
                .first()
                .map(|entry| (**entry).clone())
                .ok_or("No OAuth route was created for the fallback alias")?;
            mark_entry(&mut generated, marker)?;
            child_mapping(root, "oauth-model-alias")?
                .entry(yaml_key(&channel))
                .or_insert_with(|| Value::Sequence(Vec::new()))
                .as_sequence_mut()
                .ok_or("OAuth model aliases must be an array")?
                .push(generated);
            added = true;
        }
    }
    if !added {
        return Err("No reliable source was found for the primary fallback model. Configure an explicit provider model list containing this model, or enable a matching OAuth model source, then refresh and retry. Implicit provider catalogs are not modified".into());
    }
    Ok(())
}

fn copy_payload_selectors(root: &mut Mapping, primary: &str, alias: &str) {
    let Some(payload) = root
        .get_mut(yaml_key("payload"))
        .and_then(Value::as_mapping_mut)
    else {
        return;
    };
    for rules in payload.values_mut().filter_map(Value::as_sequence_mut) {
        for rule in rules {
            let Some(models) = rule.get_mut("models").and_then(Value::as_sequence_mut) else {
                continue;
            };
            let copies: Vec<_> = models
                .iter()
                .filter(|model| {
                    model
                        .get("name")
                        .and_then(Value::as_str)
                        .is_some_and(|name| name.eq_ignore_ascii_case(primary))
                })
                .cloned()
                .map(|mut model| {
                    model
                        .as_mapping_mut()
                        .expect("named model selector is a mapping")
                        .insert(yaml_key("name"), yaml_key(alias));
                    model
                })
                .collect();
            models.extend(copies);
        }
    }
}

fn merge_native_aliases(
    native: &mut Mapping,
    before: &Mapping,
    after: &Mapping,
) -> Result<(), String> {
    for (legacy, provider) in V8_PROVIDER_FAMILIES {
        let old = before.get(yaml_key(legacy));
        let new = after.get(yaml_key(legacy));
        if old == new {
            continue;
        }
        let old = old.ok_or("Missing original provider records")?;
        let new = new.ok_or("Missing updated provider records")?;
        if let Some(groups) = native
            .get(yaml_key("api-keys"))
            .and_then(|keys| keys.get(provider))
        {
            let updated = update_v8_provider_group_models(provider, groups, old, new)?;
            child_mapping(native, "api-keys")?.insert(yaml_key(provider), updated);
        } else if native.contains_key(yaml_key(legacy)) {
            native.insert(yaml_key(legacy), new.clone());
        } else {
            return Err("Provider configuration changed. Refresh and retry".into());
        }
    }
    for (legacy, parent, key) in [
        ("oauth-model-alias", "oauth", "model-alias"),
        ("payload", "requests", "payload"),
    ] {
        if before.get(yaml_key(legacy)) != after.get(yaml_key(legacy)) {
            let value = after
                .get(yaml_key(legacy))
                .ok_or("Alias update removed a configuration section")?;
            child_mapping(native, parent)?.insert(yaml_key(key), value.clone());
        }
    }
    Ok(())
}

fn prepare_save(
    snapshot: &Snapshot,
    client: &str,
    slot: &str,
    model: &str,
    primary: &str,
    fallbacks: &[String],
    revision: &str,
    definitions: &[OAuthModelDefinitions],
) -> Result<(String, AgentModelFallback), String> {
    validate_scope(client, slot)?;
    let model = validate_thinking_alias_model_id(model, "model")?;
    let primary = validate_thinking_alias_model_id(primary, "primary model")?;
    let fallbacks = fallbacks
        .iter()
        .map(|model| validate_thinking_alias_model_id(model, "fallback model"))
        .collect::<Result<Vec<_>, _>>()?;
    if snapshot.revision != revision {
        return Err(CONFLICT.into());
    }
    let mut native = parse_native(&snapshot.content)?;
    if fallbacks.is_empty() {
        return Ok((
            snapshot.content.clone(),
            AgentModelFallback {
                model: primary.clone(),
                primary,
                fallbacks,
                revision: snapshot.revision.clone(),
            },
        ));
    }
    let mut seen = std::collections::HashSet::new();
    for target in &fallbacks {
        if target.eq_ignore_ascii_case(&primary)
            || target.eq_ignore_ascii_case(&model)
            || !seen.insert(target.to_ascii_lowercase())
        {
            return Err(
                "Fallback models must be distinct and cannot include the primary or current model"
                    .into(),
            );
        }
    }
    let root = native
        .as_mapping_mut()
        .ok_or("Kernel configuration must be an object")?;
    let policy = child_mapping(child_mapping(root, "routing")?, "model-fallback")?;
    let hops = match policy.get(yaml_key("max-hops")) {
        None => DEFAULT_HOPS,
        Some(value) => value
            .as_u64()
            .map(|hops| {
                if hops == 0 {
                    DEFAULT_HOPS
                } else {
                    hops.min(MAX_HOPS as u64) as usize
                }
            })
            .ok_or("Invalid model fallback maximum hops. Adjust it in Routing before saving")?,
    };
    if fallbacks.len() > hops {
        return Err(format!("This chain needs {} fallback hops, but Routing allows {hops}. Adjust Maximum hops in Routing before saving", fallbacks.len()));
    }
    let alias = alias_name(client, slot, &primary, &fallbacks);
    let before = legacy_view(&snapshot.content)?;
    let mut after = before.clone();
    let occupied = !alias_entries(&before, &alias).is_empty()
        || policy
            .get(yaml_key("chains"))
            .and_then(Value::as_mapping)
            .is_some_and(|chains| {
                chains.keys().any(|key| {
                    key.as_str()
                        .is_some_and(|key| key.eq_ignore_ascii_case(&alias))
                })
            });
    if occupied {
        let existing = describe(&snapshot.content, &snapshot.revision, client, slot, &alias)?;
        if existing.primary != primary || existing.fallbacks != fallbacks {
            return Err("Reserved fallback alias is already used by another configuration; no changes were written".into());
        }
    } else {
        append_aliases(
            &mut after,
            &primary,
            &alias,
            &metadata(client, slot, &primary),
            definitions,
        )?;
        copy_payload_selectors(&mut after, &primary, &alias);
    }
    policy.insert(yaml_key("enabled"), Value::Bool(true));
    policy
        .entry(yaml_key("max-hops"))
        .or_insert(Value::Number((DEFAULT_HOPS as u64).into()));
    policy.entry(yaml_key("on")).or_insert_with(|| {
        Value::Sequence(vec![
            Value::Number(429.into()),
            yaml_key("quota_exhausted"),
            yaml_key("auth_unavailable"),
            Value::Number(529.into()),
        ])
    });
    child_mapping(policy, "chains")?.insert(
        yaml_key(&alias),
        Value::Sequence(fallbacks.iter().map(|model| yaml_key(model)).collect()),
    );
    merge_native_aliases(root, &before, &after)?;
    let original = parse_native(&snapshot.content)?;
    // yaml-edit can consume sibling provider keys when replacing an indentless
    // sequence. Normalize with the existing alias writer helper first, and prove
    // that normalization did not change scalar content or configuration values.
    let editable = indent_indentationless_yaml_sequences(&snapshot.content);
    if parse_native(&editable)? != original {
        return Err("Could not safely normalize configuration sequences; write canceled".into());
    }
    let content = render_yaml_value_changes(&editable, &original, &native)?;
    if parse_native(&content)? != native {
        return Err("Updated fallback configuration failed validation; write canceled".into());
    }
    Ok((
        content,
        AgentModelFallback {
            model: alias,
            primary,
            fallbacks,
            revision: snapshot.revision.clone(),
        },
    ))
}

fn strong_etag(headers: &reqwest::header::HeaderMap) -> Result<String, String> {
    let value = headers.get(reqwest::header::ETAG).and_then(|header| header.to_str().ok())
        .filter(|tag| tag.starts_with('"') && tag.ends_with('"') && tag.len() > 2)
        .ok_or("Kernel does not provide a strong configuration ETag; update the kernel before editing model fallback")?;
    Ok(value.to_owned())
}

async fn fetch_snapshot(config: &GuiConfigFile) -> Result<Snapshot, String> {
    let response = management_http_client()?
        .get(management_endpoint(config, "config.yaml")?)
        .header(
            reqwest::header::AUTHORIZATION,
            management_authorization(config)?,
        )
        .header(reqwest::header::ACCEPT, "application/yaml")
        .send()
        .await
        .map_err(|error| {
            format_management_request_error("Failed to read model fallback configuration", &error)
        })?;
    let revision = strong_etag(response.headers());
    let content = read_management_text(response).await?;
    Ok(Snapshot {
        content,
        revision: revision?,
    })
}

#[tauri::command]
pub(crate) async fn read_agent_model_fallback(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    client: String,
    slot: String,
    model: String,
) -> Result<AgentModelFallback, String> {
    validate_scope(&client, &slot)?;
    validate_thinking_alias_model_id(&model, "model")?;
    let snapshot = fetch_snapshot(&gui_config_state.snapshot()?).await?;
    describe(
        &snapshot.content,
        &snapshot.revision,
        &client,
        &slot,
        &model,
    )
}

#[tauri::command]
pub(crate) async fn save_agent_model_fallback(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    client: String,
    slot: String,
    model: String,
    primary: String,
    fallbacks: Vec<String>,
    revision: String,
) -> Result<AgentModelFallback, String> {
    let _guard = SAVE_LOCK.lock().await;
    validate_scope(&client, &slot)?;
    let config = gui_config_state.snapshot()?;
    let snapshot = fetch_snapshot(&config).await?;
    if snapshot.revision != revision {
        return Err(CONFLICT.into());
    }
    let definitions = if fallbacks.is_empty() {
        Vec::new()
    } else {
        fetch_oauth_model_definitions(&config).await
    };
    let (content, mut descriptor) = prepare_save(
        &snapshot,
        &client,
        &slot,
        &model,
        &primary,
        &fallbacks,
        &revision,
        &definitions,
    )?;
    if content == snapshot.content {
        return Ok(descriptor);
    }
    let response = management_http_client()?
        .put(management_endpoint(&config, "config.yaml")?)
        .header(
            reqwest::header::AUTHORIZATION,
            management_authorization(&config)?,
        )
        .header(reqwest::header::CONTENT_TYPE, "application/yaml")
        .header(reqwest::header::IF_MATCH, &snapshot.revision)
        .body(content)
        .send()
        .await
        .map_err(|error| {
            format_management_request_error(
                "Fallback save could not be confirmed; refresh before retrying",
                &error,
            )
        })?;
    if response.status() == reqwest::StatusCode::PRECONDITION_FAILED {
        return Err(CONFLICT.into());
    }
    let updated_revision = strong_etag(response.headers());
    read_management_value(response).await?;
    match updated_revision {
        Ok(revision) => {
            descriptor.revision = revision;
            Ok(descriptor)
        }
        Err(_) => {
            let saved = fetch_snapshot(&config).await.map_err(|error| format!("Model fallback was saved, but its revision could not be read. Refresh before retrying: {error}"))?;
            describe(
                &saved.content,
                &saved.revision,
                &client,
                &slot,
                &descriptor.model,
            )
        }
    }
}
