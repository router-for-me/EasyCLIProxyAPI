use super::*;

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
    fn codex_client_context_defaults_are_preserved_in_editor_and_generated_catalog() {
        let runtime = parse_runtime_models(&serde_json::json!({"models":[
            {"slug":"gpt-5.6-sol","context_window":272000,"max_context_window":872000},
            {"slug":"fast-alias","context_window":128000,"max_context_window":256000},
            {"slug":"missing-context"}
        ]}))
        .unwrap();
        let sources = parse_sources(MODEL_CATALOG_JSON).unwrap();
        let state = CatalogState {
            sources,
            json: MODEL_CATALOG_JSON.to_string(),
            customizations: Default::default(),
        };
        let snapshot = customizations::snapshot_for_state(&runtime, &state).unwrap();
        let snapshot = serde_json::to_value(snapshot).unwrap();
        let prepared =
            prepare_catalog_with_customizations(&runtime, &state.sources, &state.customizations)
                .unwrap();
        let catalog: Value = serde_json::from_str(&prepared.json).unwrap();
        for (slug, context, maximum, source) in [
            ("gpt-5.6-sol", 272_000, 872_000, "client"),
            ("fast-alias", 128_000, 256_000, "client"),
            ("missing-context", 272_000, 272_000, "template"),
        ] {
            let model = snapshot["models"]
                .as_array()
                .unwrap()
                .iter()
                .find(|model| model["slug"] == slug)
                .unwrap();
            for field in ["configuration", "defaults"] {
                assert_eq!(model[field]["context_window"], context);
                assert_eq!(model[field]["max_context_window"], maximum);
            }
            assert_eq!(model["contextSource"], source);
            let generated = catalog["models"]
                .as_array()
                .unwrap()
                .iter()
                .find(|model| model["slug"] == slug)
                .unwrap();
            assert_eq!(generated["context_window"], context);
            assert_eq!(generated["max_context_window"], maximum);
        }
    }

    #[test]
    fn core_configured_context_limit_takes_precedence_over_client_defaults() {
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
