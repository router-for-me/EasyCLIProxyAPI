use super::*;

pub(crate) async fn restore_native_provider_groups(config: &GuiConfigFile, original: &str) -> Result<(), String> {
    let original: serde_norway::Value = serde_norway::from_str(original).map_err(|error| error.to_string())?;
    if original.get("config-version").and_then(serde_norway::Value::as_i64) != Some(8) { return Ok(()); }
    let current: serde_norway::Value = serde_norway::from_str(&fetch_management_raw_config_yaml(config).await?)
        .map_err(|error| error.to_string())?;
    let empty = serde_norway::Value::Sequence(Vec::new());
    let mut changes = Vec::new();
    for (_, provider) in V8_PROVIDER_FAMILIES {
        let before = original.get("api-keys").and_then(|value| value.get(provider)).unwrap_or(&empty);
        let after = current.get("api-keys").and_then(|value| value.get(provider)).unwrap_or(&empty);
        if before == after { continue; }
        if flatten_v8_provider_groups(provider, before)? != flatten_v8_provider_groups(provider, after)? {
            return Err("Provider configuration changed during restoration".into());
        }
        changes.push((provider, before));
    }
    for (provider, groups) in changes {
        put_management_config_value(config, &format!("api-keys/{provider}"), groups).await?;
    }
    Ok(())
}

// Alias editors use a per-key view. Apply only their model changes back to the
// original v8 groups, preserving key overrides, names, and shared configuration.
pub(crate) fn update_v8_provider_group_models(
    provider: &str,
    groups: &serde_norway::Value,
    before: &serde_norway::Value,
    after: &serde_norway::Value,
) -> Result<serde_norway::Value, String> {
    if flatten_v8_provider_groups(provider, groups)? != *before {
        return Err("Provider groups changed. Refresh and try again".into());
    }
    let before = before.as_sequence().ok_or("Provider records must be an array")?;
    let after = after.as_sequence().ok_or("Provider records must be an array")?;
    if before.len() != after.len() {
        return Err("An alias update cannot add or remove provider keys".into());
    }
    for (before, after) in before.iter().zip(after) {
        let mut before = before.as_mapping().cloned().ok_or("Invalid provider record")?;
        let mut after = after.as_mapping().cloned().ok_or("Invalid provider record")?;
        before.remove(yaml_key("models"));
        after.remove(yaml_key("models"));
        if before != after {
            return Err("An alias update cannot change provider connection settings".into());
        }
    }
    let models = |record: &serde_norway::Value| record.get("models").cloned();
    let assign = |mapping: &mut serde_norway::Mapping, value: Option<serde_norway::Value>| {
        if let Some(value) = value { mapping.insert(yaml_key("models"), value); }
        else { mapping.remove(yaml_key("models")); }
    };
    let mut updated = groups.clone();
    let mut offset = 0;
    for group in updated.as_sequence_mut().ok_or("Provider groups must be an array")? {
        let group = group.as_mapping_mut().ok_or("Invalid provider group")?;
        if provider == "openai-compatibility" {
            if models(&before[offset]) != models(&after[offset]) {
                assign(group, models(&after[offset]));
            }
            offset += 1;
            continue;
        }
        let keys = group.get(yaml_key("keys")).and_then(serde_norway::Value::as_sequence)
            .ok_or("Provider keys must be an array")?;
        let inherited: Vec<usize> = keys.iter().enumerate().filter_map(|(index, key)| {
            key.get("models").is_none_or(serde_norway::Value::is_null).then_some(index)
        }).collect();
        let shared_update = inherited.first().copied().filter(|first| {
            models(&before[offset + first]) != models(&after[offset + first])
                && inherited.iter().all(|index| models(&after[offset + index]) == models(&after[offset + first]))
        });
        let count = keys.len();
        if let Some(first) = shared_update {
            assign(group, models(&after[offset + first]));
        }
        let keys = group.get_mut(yaml_key("keys")).and_then(serde_norway::Value::as_sequence_mut)
            .ok_or("Provider keys must be an array")?;
        for (index, key) in keys.iter_mut().enumerate() {
            if models(&before[offset + index]) == models(&after[offset + index])
                || (shared_update.is_some() && inherited.contains(&index)) { continue; }
            assign(key.as_mapping_mut().ok_or("Invalid provider key")?, models(&after[offset + index]));
        }
        offset += count;
    }
    Ok(updated)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(value: &str) -> serde_norway::Value { serde_norway::from_str(value).unwrap() }

    #[test]
    fn alias_updates_preserve_groups_and_per_key_inheritance() {
        let groups = parse(r#"
- name: gateway
  base-url: https://example.test/v1
  models: [{name: original}]
  headers: {X-Group: shared}
  keys:
    - {api-key: first, weight: 2, priority: null}
    - {api-key: second, weight: 5, models: null, headers: {}, excluded-models: [], disable-cooling: false}
    - api-key: third
      models: [{name: private}]
"#);
        let before = flatten_v8_provider_groups("codex", &groups).unwrap();
        let mut after = before.clone();
        after[0]["models"] = parse("[{name: original}, {name: original, alias: fast}]");
        let updated = update_v8_provider_group_models("codex", &groups, &before, &after).unwrap();
        assert_eq!(updated.as_sequence().unwrap().len(), 1);
        assert_eq!(updated[0]["models"], groups[0]["models"]);
        assert_eq!(updated[0]["keys"][0]["models"], after[0]["models"]);
        assert_eq!(updated[0]["keys"][0]["priority"], groups[0]["keys"][0]["priority"]);
        assert_eq!(updated[0]["keys"][1], groups[0]["keys"][1]);
        assert_eq!(updated[0]["keys"][2], groups[0]["keys"][2]);
        assert_eq!(flatten_v8_provider_groups("codex", &updated).unwrap(), after);

        after[1]["models"] = after[0]["models"].clone();
        let updated = update_v8_provider_group_models("codex", &groups, &before, &after).unwrap();
        assert_eq!(updated[0]["models"], after[0]["models"]);
        assert_eq!(updated[0]["keys"], groups[0]["keys"]);
        assert_eq!(flatten_v8_provider_groups("codex", &updated).unwrap(), after);
    }

    #[test]
    fn alias_updates_leave_empty_and_compatible_groups_intact() {
        for provider in ["codex", "openai-compatibility"] {
            let groups = parse("- name: empty\n  keys: []\n- name: active\n  models: [{name: model}]\n  keys: [{api-key: key, proxy-url: direct}]\n");
            let before = flatten_v8_provider_groups(provider, &groups).unwrap();
            let mut after = before.clone();
            let index = after.as_sequence().unwrap().len() - 1;
            after[index]["models"] = parse("[{name: model, alias: alias}]");
            let updated = update_v8_provider_group_models(provider, &groups, &before, &after).unwrap();
            assert_eq!(updated[0], groups[0]);
            assert_eq!(updated[1]["keys"], groups[1]["keys"]);
            assert_eq!(updated[1]["models"], after[index]["models"]);
            after[index]["base-url"] = yaml_key("https://changed.test");
            assert!(update_v8_provider_group_models(provider, &groups, &before, &after).is_err());
        }
    }

    #[test]
    fn alias_updates_reject_changed_groups_before_writing() {
        let groups = parse("[{name: source, models: [{name: model}], keys: [{api-key: key}]}]");
        let before = flatten_v8_provider_groups("codex", &groups).unwrap();
        let mut changed = groups.clone();
        changed[0]["keys"][0]["priority"] = serde_norway::Value::Number(7.into());
        assert!(update_v8_provider_group_models("codex", &changed, &before, &before).is_err());
    }
}
