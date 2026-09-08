use super::*;

pub(crate) fn merge_context_definitions(
    runtime_models: &mut [CodexRuntimeModel],
    definitions: &[crate::CodexModelDefinition],
    aliases: &[AgentModelOption],
) {
    for runtime in runtime_models {
        let source = aliases
            .iter()
            .find(|model| model.is_alias && model.name.eq_ignore_ascii_case(&runtime.slug))
            .and_then(|model| model.alias.as_deref())
            .unwrap_or(&runtime.slug);
        // These are core model definitions, not the synthesized Codex client catalog.
        let context = definitions
            .iter()
            .filter(|definition| definition.id.eq_ignore_ascii_case(source))
            .filter_map(|definition| definition.context_window)
            .filter(|value| *value > 0)
            .min();
        if let Some(context) = context {
            runtime.context_window = Some(context);
            runtime.max_context_window =
                Some(runtime.max_context_window.unwrap_or(context).max(context));
            runtime.context_source = "definition";
        }
    }
}

pub(crate) fn apply_configured_context_limits(
    runtime_models: &mut [CodexRuntimeModel],
    content: &str,
) -> Result<(), String> {
    let document: serde_norway::Value = serde_norway::from_str(content)
        .map_err(|error| format!("解析内核模型上下文配置失败: {error}"))?;
    let root = document
        .as_mapping()
        .ok_or("内核配置顶层必须是 YAML 映射")?;
    let mut limits: HashMap<String, u64> = HashMap::new();
    for section in crate::MODEL_ALIAS_CONFIG_SECTIONS {
        let Some(providers) =
            crate::yaml_mapping_value(root, section).and_then(serde_norway::Value::as_sequence)
        else {
            continue;
        };
        for provider in providers {
            let Some(models) = provider
                .as_mapping()
                .and_then(|provider| crate::yaml_mapping_value(provider, "models"))
                .and_then(serde_norway::Value::as_sequence)
            else {
                continue;
            };
            for model in models {
                let Some((_, public_name, _)) = crate::configured_model_identity(model) else {
                    continue;
                };
                let Some(limit) = model
                    .as_mapping()
                    .and_then(|model| crate::yaml_mapping_value(model, "max-context-length"))
                    .and_then(serde_norway::Value::as_u64)
                    .filter(|value| *value > 0)
                else {
                    continue;
                };
                limits
                    .entry(normalize_id(&public_name))
                    .and_modify(|existing| *existing = (*existing).min(limit))
                    .or_insert(limit);
            }
        }
    }
    for runtime in runtime_models {
        if let Some(&limit) = limits.get(&normalize_id(&runtime.slug)) {
            runtime.context_window = Some(limit);
            runtime.max_context_window = Some(limit);
            runtime.context_source = "configuration";
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_core_definitions_replace_synthesized_272k_for_models_and_aliases() {
        let mut runtime = parse_runtime_models(&serde_json::json!({"models":[
            {"slug":"gpt-5.6-sol","context_window":272000,"max_context_window":872000},
            {"slug":"gemini-3.8-flash-high","context_window":272000,"max_context_window":272000},
            {"slug":"fast-alias","context_window":272000,"max_context_window":272000},
            {"slug":"no-definition","context_window":272000,"max_context_window":272000}
        ]}))
        .unwrap();
        let definitions = crate::parse_codex_model_definitions(&serde_json::json!({"models":[
            {"id":"gpt-5.6-sol","context_length":921000},
            {"id":"gemini-3.8-flash-high","context_length":1048576}
        ]}))
        .unwrap();
        let aliases = vec![AgentModelOption {
            name: "fast-alias".to_string(),
            alias: Some("GPT-5.6-SOL".to_string()),
            is_alias: true,
            context_window: None,
        }];
        merge_context_definitions(&mut runtime, &definitions, &aliases);
        assert_eq!(runtime[0].context_window, Some(921_000));
        assert_eq!(runtime[0].max_context_window, Some(921_000));
        assert_eq!(runtime[1].context_window, Some(1_048_576));
        assert_eq!(runtime[2].context_window, Some(921_000));
        assert_eq!(runtime[2].context_source, "definition");
        assert_eq!(runtime[3].context_source, "compatibility");
        let sources = parse_sources(MODEL_CATALOG_JSON).unwrap();
        let state = CatalogState {
            sources,
            json: MODEL_CATALOG_JSON.to_string(),
            customizations: Default::default(),
        };
        let snapshot = customizations::snapshot_for_state(&runtime, &state).unwrap();
        let snapshot = serde_json::to_value(snapshot).unwrap();
        let model = snapshot["models"]
            .as_array()
            .unwrap()
            .iter()
            .find(|model| model["slug"] == "gpt-5.6-sol")
            .unwrap();
        assert_eq!(model["configuration"]["context_window"], 921_000);
        assert_eq!(model["defaults"]["context_window"], 921_000);
        assert_eq!(model["contextSource"], "definition");
    }

    #[test]
    fn core_configured_context_limit_takes_precedence_over_static_definitions() {
        let mut runtime = parse_runtime_models(&serde_json::json!({"models":[
            {"slug":"custom-alias","context_window":921000,"max_context_window":921000},
            {"slug":"unmodified","context_window":128000,"max_context_window":128000}
        ]}))
        .unwrap();
        apply_configured_context_limits(&mut runtime, "codex-api-key:\n  - models:\n      - name: upstream-model\n        alias: custom-alias\n        max-context-length: 64000\n").unwrap();
        assert_eq!(runtime[0].context_window, Some(64_000));
        assert_eq!(runtime[0].max_context_window, Some(64_000));
        assert_eq!(runtime[0].context_source, "configuration");
        assert_eq!(runtime[1].context_window, Some(128_000));
    }
}
