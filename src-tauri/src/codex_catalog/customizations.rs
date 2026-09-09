use super::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub(super) struct ModelCustomizations {
    default_auto_review_model: Option<String>,
    models: BTreeMap<String, Map<String, Value>>,
}

const EDITABLE_FIELDS: [&str; 12] = [
    "display_name",
    "description",
    "context_window",
    "max_context_window",
    "effective_context_window_percent",
    "auto_compact_token_limit",
    "default_reasoning_level",
    "supported_reasoning_levels",
    "input_modalities",
    "visibility",
    "supports_parallel_tool_calls",
    "auto_review_model_override",
];

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedCustomizations {
    version: u32,
    // 老配置没有统一默认值，加载后继续沿用模型模板的审批行为。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    default_auto_review_model: Option<String>,
    models: BTreeMap<String, Map<String, Value>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CatalogEditorSnapshot {
    revision: String,
    default_auto_review_model: Option<String>,
    models: Vec<CatalogEditorModel>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogEditorModel {
    slug: String,
    has_official_template: bool,
    context_source: &'static str,
    customized: bool,
    configuration: Map<String, Value>,
    defaults: Map<String, Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CatalogEditorRequest {
    revision: String,
    default_auto_review_model: Option<String>,
    models: Vec<CatalogEditorModelRequest>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogEditorModelRequest {
    slug: String,
    configuration: Map<String, Value>,
}

fn editable_configuration(model: &Map<String, Value>) -> Map<String, Value> {
    EDITABLE_FIELDS
        .iter()
        .map(|field| {
            (
                field.to_string(),
                model.get(*field).cloned().unwrap_or_else(|| {
                    // Codex defaults this optional field to 95 when it is omitted.
                    // The editor needs the same value to validate and save context changes.
                    if *field == "effective_context_window_percent" {
                        Value::from(95)
                    } else {
                        Value::Null
                    }
                }),
            )
        })
        .collect()
}

fn validate_configuration(model: &Map<String, Value>) -> Result<(), String> {
    for field in model.keys() {
        if !EDITABLE_FIELDS.contains(&field.as_str()) {
            return Err(format!("不允许修改模型字段 {field}"));
        }
    }
    if let Some(value) = model.get("auto_review_model_override") {
        if !value.is_null() {
            validate_review_model(Some(value.as_str().ok_or("审批模型 ID 必须是字符串")?))?;
        }
    }
    for field in [
        "context_window",
        "max_context_window",
        "auto_compact_token_limit",
    ] {
        if let Some(value) = model.get(field) {
            if field == "auto_compact_token_limit" && value.is_null() {
                continue;
            }
            if !value
                .as_u64()
                .is_some_and(|value| (1..=9_007_199_254_740_991).contains(&value))
            {
                return Err(format!("{field} 必须是有效的正整数"));
            }
        }
    }
    if let (Some(context), Some(maximum)) = (
        model.get("context_window").and_then(Value::as_u64),
        model.get("max_context_window").and_then(Value::as_u64),
    ) {
        if maximum < context {
            return Err("最大上下文窗口不能小于上下文窗口".to_string());
        }
        if model
            .get("auto_compact_token_limit")
            .and_then(Value::as_u64)
            .is_some_and(|limit| limit > context)
        {
            return Err("自动压缩阈值不能大于上下文窗口".to_string());
        }
    }
    if let Some(value) = model.get("effective_context_window_percent") {
        if !value
            .as_u64()
            .is_some_and(|value| (1..=100).contains(&value))
        {
            return Err("有效上下文比例必须为 1 到 100 的整数".to_string());
        }
    }
    for field in ["display_name", "description"] {
        if let Some(value) = model.get(field) {
            if field == "description" && value.is_null() {
                continue;
            }
            if !value.as_str().is_some_and(|text| {
                text.len() <= 4_000 && (field == "description" || !text.trim().is_empty())
            }) {
                return Err(format!("{field} 必须是有效的文本"));
            }
        }
    }
    if let Some(value) = model.get("visibility") {
        if !matches!(value.as_str(), Some("list" | "hide" | "none")) {
            return Err("模型显示状态无效".to_string());
        }
    }
    if let Some(value) = model.get("supports_parallel_tool_calls") {
        if !value.is_boolean() {
            return Err("并行工具调用必须为布尔值".to_string());
        }
    }
    if let Some(value) = model.get("input_modalities") {
        let modalities = value.as_array().ok_or("输入类型必须为数组")?;
        let mut seen = HashSet::new();
        if modalities.is_empty()
            || modalities.iter().any(|value| {
                !matches!(value.as_str(), Some("text" | "image")) || !seen.insert(value.as_str())
            })
        {
            return Err("输入类型仅允许不重复的 text 和 image，且至少选择一项".to_string());
        }
    }
    let default = model.get("default_reasoning_level");
    if let Some(value) = default {
        if !value.is_null() && !value.as_str().is_some_and(is_allowed_reasoning_level) {
            return Err("默认思考等级无效".to_string());
        }
    }
    if let Some(value) = model.get("supported_reasoning_levels") {
        let levels = value.as_array().ok_or("思考等级必须为数组")?;
        let mut seen = HashSet::new();
        for level in levels {
            let effort = level
                .get("effort")
                .and_then(Value::as_str)
                .ok_or("思考等级缺少 effort")?;
            if !is_allowed_reasoning_level(effort) || !seen.insert(effort) {
                return Err(format!("思考等级无效或重复: {effort}"));
            }
            if !level
                .get("description")
                .and_then(Value::as_str)
                .is_some_and(|text| text.len() <= 4_000)
            {
                return Err("思考等级说明必须是有效的文本".to_string());
            }
        }
        if default
            .and_then(Value::as_str)
            .is_some_and(|effort| !seen.contains(effort))
        {
            return Err("默认思考等级必须包含在可选等级中".to_string());
        }
    }
    Ok(())
}

fn validate_review_model(model: Option<&str>) -> Result<(), String> {
    // 模型 ID 区分大小写并允许内部空格；只拒绝空值、首尾空白和控制字符，不改写代理别名。
    if model.is_some_and(|id| {
        id.is_empty() || id.len() > 4_000 || id.trim() != id || id.chars().any(char::is_control)
    }) {
        return Err(
            "审批模型 ID 必须是有效文本，不能包含首尾空白或控制字符，且不超过 4000 字节"
                .to_string(),
        );
    }
    Ok(())
}

pub(super) fn apply_customizations(
    model: &mut Map<String, Value>,
    customizations: &ModelCustomizations,
) -> Result<(), String> {
    let slug = string_value(model, "slug");
    let customization = customizations.models.get(&normalize_id(&slug));
    if let Some(customization) = customization {
        model.extend(
            customization
                .iter()
                .filter(|(field, value)| {
                    field.as_str() != "auto_review_model_override" || !value.is_null()
                })
                .map(|(field, value)| (field.clone(), value.clone())),
        );
        validate_configuration(&editable_configuration(model))
            .map_err(|error| format!("模型 {slug} 的自定义配置无效: {error}"))?;
        enable_fast_mode(model);
    }
    // 仅在生成目录时解析继承：单模型覆盖 > 统一默认 > 原模型模板。
    // 不把继承值写回单模型设置，后续更改统一默认时才能同时更新所有继承者。
    if let Some(review_model) = customization
        .and_then(|fields| fields.get("auto_review_model_override"))
        .and_then(Value::as_str)
        .or(customizations.default_auto_review_model.as_deref())
    {
        model.insert(
            "auto_review_model_override".to_string(),
            Value::from(review_model),
        );
    }
    Ok(())
}

pub(super) fn snapshot_for_state(
    runtime_models: &[CodexRuntimeModel],
    state: &CatalogState,
) -> Result<CatalogEditorSnapshot, String> {
    let baseline = if runtime_models.is_empty() {
        "{\"models\":[]}".to_string()
    } else {
        prepare_catalog_with_customizations(runtime_models, &state.sources, &Default::default())?
            .json
    };
    let root: Value = serde_json::from_str(&baseline).map_err(|error| error.to_string())?;
    let mut models = Vec::new();
    for value in root["models"]
        .as_array()
        .ok_or("模型目录缺少 models 数组")?
    {
        let mut model = value.as_object().cloned().ok_or("模型目录条目必须为对象")?;
        let slug = string_value(&model, "slug");
        let key = normalize_id(&slug);
        let mut defaults = editable_configuration(&model);
        defaults.insert("auto_review_model_override".to_string(), Value::Null);
        apply_customizations(&mut model, &state.customizations)?;
        let mut configuration = editable_configuration(&model);
        // 编辑器展示用户的显式选择；null 表示继承，而不是解析后的实际审批模型。
        configuration.insert(
            "auto_review_model_override".to_string(),
            state
                .customizations
                .models
                .get(&key)
                .and_then(|fields| fields.get("auto_review_model_override"))
                .cloned()
                .unwrap_or(Value::Null),
        );
        models.push(CatalogEditorModel {
            slug,
            has_official_template: state.sources.templates.contains_key(&key),
            context_source: runtime_models
                .iter()
                .find(|runtime| normalize_id(&runtime.slug) == key)
                .map_or("template", |runtime| runtime.context_source),
            customized: state.customizations.models.contains_key(&key),
            configuration,
            defaults,
        });
    }
    let mut digest = Sha256::new();
    digest.update(baseline.as_bytes());
    digest.update(serde_json::to_vec(&state.customizations).map_err(|error| error.to_string())?);
    Ok(CatalogEditorSnapshot {
        revision: format!("{:x}", digest.finalize()),
        default_auto_review_model: state.customizations.default_auto_review_model.clone(),
        models,
    })
}

pub(crate) fn editor_snapshot(
    runtime_models: &[CodexRuntimeModel],
) -> Result<CatalogEditorSnapshot, String> {
    let state = catalog_state()?
        .read()
        .map_err(|_| "Codex 模型目录内存锁已损坏")?;
    snapshot_for_state(runtime_models, &state)
}

fn customizations_from_request(
    snapshot: &CatalogEditorSnapshot,
    request: CatalogEditorRequest,
) -> Result<ModelCustomizations, String> {
    if request.revision != snapshot.revision {
        return Err("CODEX_MODEL_CATALOG_CHANGED".to_string());
    }
    if request.models.len() != snapshot.models.len() {
        return Err("模型列表已变化，请重新加载后编辑".to_string());
    }
    validate_review_model(request.default_auto_review_model.as_deref())?;
    let mut seen = HashSet::new();
    let mut customizations = BTreeMap::new();
    for requested in request.models {
        let key = normalize_id(&requested.slug);
        let current = snapshot
            .models
            .iter()
            .find(|model| normalize_id(&model.slug) == key)
            .ok_or_else(|| format!("模型 {} 已不在当前列表中", requested.slug))?;
        if !seen.insert(key.clone()) {
            return Err(format!("模型 {} 重复", requested.slug));
        }
        if requested.configuration.len() != EDITABLE_FIELDS.len() {
            return Err(format!("模型 {} 的配置字段不完整", requested.slug));
        }
        validate_configuration(&requested.configuration)
            .map_err(|error| format!("模型 {}: {error}", requested.slug))?;
        let mut changes: Map<String, Value> = requested
            .configuration
            .iter()
            .filter(|(field, value)| current.defaults.get(*field) != Some(*value))
            .map(|(field, value)| (field.clone(), value.clone()))
            .collect();
        for group in [
            &[
                "context_window",
                "max_context_window",
                "auto_compact_token_limit",
                "effective_context_window_percent",
            ][..],
            &["default_reasoning_level", "supported_reasoning_levels"][..],
        ] {
            if group.iter().any(|field| changes.contains_key(*field)) {
                for field in group {
                    changes.insert(field.to_string(), requested.configuration[*field].clone());
                }
            }
        }
        if !changes.is_empty() {
            customizations.insert(key, changes);
        }
    }
    Ok(ModelCustomizations {
        default_auto_review_model: request.default_auto_review_model,
        models: customizations,
    })
}

fn decode_customizations(content: &[u8]) -> Result<ModelCustomizations, String> {
    if content.len() > crate::MAX_CODEX_MODEL_CATALOG_BYTES {
        return Err("Codex 自定义模型配置超过大小限制".to_string());
    }
    let saved: SavedCustomizations =
        serde_json::from_slice(content).map_err(|error| error.to_string())?;
    if saved.version != 1 {
        return Err("不支持的 Codex 自定义模型配置版本".to_string());
    }
    validate_review_model(saved.default_auto_review_model.as_deref())?;
    let mut normalized = BTreeMap::new();
    for (slug, model) in saved.models {
        let key = normalize_id(&slug);
        if key.is_empty() || normalized.contains_key(&key) {
            return Err("自定义模型 ID 为空或重复".to_string());
        }
        validate_configuration(&model)?;
        normalized.insert(key, model);
    }
    Ok(ModelCustomizations {
        default_auto_review_model: saved.default_auto_review_model,
        models: normalized,
    })
}

pub(crate) fn load_customizations(path: &Path) -> Result<(), String> {
    let content = match std::fs::read(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("读取 Codex 自定义模型配置失败: {error}")),
    };
    let customizations = decode_customizations(&content)?;
    let mut state = catalog_state()?
        .write()
        .map_err(|_| "Codex 模型目录内存锁已损坏")?;
    state.customizations = customizations;
    Ok(())
}

fn save_for_state(
    path: &Path,
    runtime_models: &[CodexRuntimeModel],
    request: CatalogEditorRequest,
    state: &mut CatalogState,
) -> Result<CatalogEditorSnapshot, String> {
    let snapshot = snapshot_for_state(runtime_models, state)?;
    let customizations = customizations_from_request(&snapshot, request)?;
    let saved = SavedCustomizations {
        version: 1,
        default_auto_review_model: customizations.default_auto_review_model.clone(),
        models: customizations.models.clone(),
    };
    let content = serde_json::to_vec_pretty(&saved).map_err(|error| error.to_string())?;
    if content.len() > crate::MAX_CODEX_MODEL_CATALOG_BYTES {
        return Err("Codex 自定义模型配置超过大小限制".to_string());
    }
    crate::write_bytes_atomically(path, &content)?;
    state.customizations = customizations;
    snapshot_for_state(runtime_models, state)
}

pub(crate) fn save_customizations(
    path: &Path,
    runtime_models: &[CodexRuntimeModel],
    request: CatalogEditorRequest,
) -> Result<CatalogEditorSnapshot, String> {
    let mut state = catalog_state()?
        .write()
        .map_err(|_| "Codex 模型目录内存锁已损坏")?;
    save_for_state(path, runtime_models, request, &mut state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn runtime_model(slug: &str) -> CodexRuntimeModel {
        CodexRuntimeModel {
            slug: slug.to_string(),
            display_name: None,
            description: None,
            context_window: None,
            max_context_window: None,
            context_source: "template",
            input_modalities: None,
            default_reasoning_level: None,
            hidden: false,
        }
    }

    fn temporary_path() -> std::path::PathBuf {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "cpa-codex-model-customizations-{}-{}.json",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn approval_models_inherit_override_and_persist_without_materializing_defaults() {
        let mut state = CatalogState {
            sources: parse_sources(MODEL_CATALOG_JSON).unwrap(),
            json: MODEL_CATALOG_JSON.to_string(),
            customizations: Default::default(),
        };
        let mut runtime_models = vec![runtime_model("main-a"), runtime_model("main-b")];
        let path = temporary_path();
        let snapshot = snapshot_for_state(&runtime_models, &state).unwrap();
        let request = CatalogEditorRequest {
            revision: snapshot.revision,
            default_auto_review_model: Some("team/Review Default".to_string()),
            models: snapshot
                .models
                .into_iter()
                .map(|model| {
                    let mut configuration = model.configuration;
                    if model.slug == "main-b" {
                        configuration.insert(
                            "auto_review_model_override".to_string(),
                            Value::from("review-special"),
                        );
                    }
                    CatalogEditorModelRequest {
                        slug: model.slug,
                        configuration,
                    }
                })
                .collect(),
        };
        let saved = save_for_state(&path, &runtime_models, request, &mut state).unwrap();
        assert_eq!(
            saved.default_auto_review_model.as_deref(),
            Some("team/Review Default")
        );
        assert!(!state.customizations.models.contains_key("main-a"));

        // 模拟重启和新增模型；审批目标暂时不在列表中也必须原样保留。
        state.customizations = decode_customizations(&std::fs::read(&path).unwrap()).unwrap();
        runtime_models.push(runtime_model("main-c"));
        let generated = prepare_catalog_with_customizations(
            &runtime_models,
            &state.sources,
            &state.customizations,
        )
        .unwrap();
        let generated: Value = serde_json::from_str(&generated.json).unwrap();
        for model in generated["models"].as_array().unwrap() {
            let expected = if model["slug"] == "main-b" {
                "review-special"
            } else {
                "team/Review Default"
            };
            assert_eq!(model["auto_review_model_override"], expected);
        }

        let snapshot = snapshot_for_state(&runtime_models, &state).unwrap();
        assert!(snapshot
            .models
            .iter()
            .filter(|model| model.slug != "main-b")
            .all(|model| model.configuration["auto_review_model_override"].is_null()));
        let stale_revision = snapshot.revision.clone();
        let request = CatalogEditorRequest {
            revision: snapshot.revision,
            default_auto_review_model: Some("review-next".to_string()),
            models: snapshot
                .models
                .into_iter()
                .map(|model| CatalogEditorModelRequest {
                    slug: model.slug,
                    configuration: model.configuration,
                })
                .collect(),
        };
        let saved = save_for_state(&path, &runtime_models, request, &mut state).unwrap();
        assert_ne!(saved.revision, stale_revision);
        let generated = prepare_catalog_with_customizations(
            &runtime_models,
            &state.sources,
            &state.customizations,
        )
        .unwrap();
        let generated: Value = serde_json::from_str(&generated.json).unwrap();
        for model in generated["models"].as_array().unwrap() {
            assert_eq!(
                model["auto_review_model_override"],
                if model["slug"] == "main-b" {
                    "review-special"
                } else {
                    "review-next"
                }
            );
        }

        // 清除单模型覆盖后恢复继承；编辑器不应把统一默认保存成单模型固定值。
        let request = CatalogEditorRequest {
            revision: saved.revision,
            default_auto_review_model: saved.default_auto_review_model,
            models: saved
                .models
                .into_iter()
                .map(|model| CatalogEditorModelRequest {
                    slug: model.slug,
                    configuration: model.defaults,
                })
                .collect(),
        };
        save_for_state(&path, &runtime_models, request, &mut state).unwrap();
        assert!(state.customizations.models.is_empty());
        let generated = prepare_catalog_with_customizations(
            &runtime_models,
            &state.sources,
            &state.customizations,
        )
        .unwrap();
        let generated: Value = serde_json::from_str(&generated.json).unwrap();
        assert!(generated["models"]
            .as_array()
            .unwrap()
            .iter()
            .all(|model| model["auto_review_model_override"] == "review-next"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn approval_defaults_preserve_templates_and_legacy_settings() {
        let legacy = decode_customizations(br#"{"version":1,"models":{}}"#).unwrap();
        assert_eq!(legacy, ModelCustomizations::default());
        let prepared = prepare_catalog_with_customizations(
            &[runtime_model("main-a")],
            &parse_sources(MODEL_CATALOG_JSON).unwrap(),
            &legacy,
        )
        .unwrap();
        let prepared: Value = serde_json::from_str(&prepared.json).unwrap();
        let mut original = prepared["models"][0].as_object().unwrap().clone();
        original.insert(
            "auto_review_model_override".to_string(),
            Value::from("template-review"),
        );
        let mut model = original.clone();
        apply_customizations(&mut model, &legacy).unwrap();
        assert_eq!(model, original);

        // 未设置统一默认时，null 也表示保留原模板，而非删除模板自带的审批配置。
        let settings = decode_customizations(
            br#"{"version":1,"models":{"main-a":{"auto_review_model_override":null}}}"#,
        )
        .unwrap();
        apply_customizations(&mut model, &settings).unwrap();
        assert_eq!(model["auto_review_model_override"], "template-review");
        assert_eq!(model, original);

        let mut no_template_override = serde_json::json!({"slug":"main-b"})
            .as_object()
            .unwrap()
            .clone();
        apply_customizations(&mut no_template_override, &legacy).unwrap();
        assert!(!no_template_override.contains_key("auto_review_model_override"));
    }

    #[test]
    fn approval_model_ids_are_validated_without_requiring_catalog_membership() {
        for value in [
            serde_json::json!(""),
            serde_json::json!(" review"),
            serde_json::json!("review\n"),
            serde_json::json!(42),
        ] {
            let settings =
                serde_json::json!({"version":1,"default_auto_review_model": value,"models":{}});
            assert!(decode_customizations(&serde_json::to_vec(&settings).unwrap()).is_err());
            let settings = serde_json::json!({"version":1,"models":{"main":{"auto_review_model_override":value}}});
            assert!(decode_customizations(&serde_json::to_vec(&settings).unwrap()).is_err());
        }
        assert!(decode_customizations(
            br#"{"version":1,"default_auto_review_model":"team/Codex Auto Review","models":{}}"#
        )
        .is_ok());
    }

    #[test]
    fn customizations_persist_apply_and_restore_to_the_current_template() {
        let sources = parse_sources(MODEL_CATALOG_JSON).unwrap();
        let mut state = CatalogState {
            sources,
            json: MODEL_CATALOG_JSON.to_string(),
            customizations: Default::default(),
        };
        let runtime_models = vec![runtime_model("third-party-model")];
        let snapshot = snapshot_for_state(&runtime_models, &state).unwrap();
        let mut configuration = snapshot.models[0].configuration.clone();
        configuration.insert("context_window".to_string(), serde_json::json!(131_072));
        configuration.insert("max_context_window".to_string(), serde_json::json!(262_144));
        let path = temporary_path();

        let saved = save_for_state(
            &path,
            &runtime_models,
            CatalogEditorRequest {
                revision: snapshot.revision,
                default_auto_review_model: None,
                models: vec![CatalogEditorModelRequest {
                    slug: "third-party-model".to_string(),
                    configuration,
                }],
            },
            &mut state,
        )
        .unwrap();

        assert!(saved.models[0].customized);
        assert_eq!(saved.models[0].configuration["context_window"], 131_072);
        assert_eq!(saved.models[0].configuration["max_context_window"], 262_144);
        let generated = prepare_catalog_with_customizations(
            &runtime_models,
            &state.sources,
            &state.customizations,
        )
        .unwrap();
        let generated: Value = serde_json::from_str(&generated.json).unwrap();
        assert_eq!(generated["models"][0]["context_window"], 131_072);
        assert_eq!(generated["models"][0]["max_context_window"], 262_144);

        let loaded = decode_customizations(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(loaded, state.customizations);

        let restored = save_for_state(
            &path,
            &runtime_models,
            CatalogEditorRequest {
                revision: saved.revision,
                default_auto_review_model: None,
                models: vec![CatalogEditorModelRequest {
                    slug: "third-party-model".to_string(),
                    configuration: saved.models[0].defaults.clone(),
                }],
            },
            &mut state,
        )
        .unwrap();
        assert!(!restored.models[0].customized);
        assert!(state.customizations.models.is_empty());
        let persisted: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(persisted["models"], serde_json::json!({}));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn editor_context_defaults_follow_api_updates_and_preserve_explicit_overrides() {
        let mut state = CatalogState {
            sources: parse_sources(MODEL_CATALOG_JSON).unwrap(),
            json: MODEL_CATALOG_JSON.to_string(),
            customizations: Default::default(),
        };
        let mut runtime = runtime_model("gpt-6-astra");
        runtime.context_window = Some(128_000);
        runtime.max_context_window = Some(256_000);
        let snapshot = snapshot_for_state(&[runtime.clone()], &state).unwrap();
        assert_eq!(snapshot.models[0].configuration["context_window"], 128_000);
        assert_eq!(snapshot.models[0].defaults["max_context_window"], 256_000);
        assert_eq!(
            snapshot.models[0].defaults["effective_context_window_percent"],
            95
        );
        let mut configuration = snapshot.models[0].configuration.clone();
        configuration.insert("context_window".to_string(), serde_json::json!(192_000));
        state.customizations = customizations_from_request(
            &snapshot,
            CatalogEditorRequest {
                revision: snapshot.revision.clone(),
                default_auto_review_model: None,
                models: vec![CatalogEditorModelRequest {
                    slug: runtime.slug.clone(),
                    configuration,
                }],
            },
        )
        .unwrap();

        runtime.context_window = Some(512_000);
        runtime.max_context_window = Some(1_000_000);
        let updated = snapshot_for_state(&[runtime.clone()], &state).unwrap();
        assert_ne!(updated.revision, snapshot.revision);
        assert_eq!(updated.models[0].defaults["context_window"], 512_000);
        assert_eq!(updated.models[0].defaults["max_context_window"], 1_000_000);
        assert_eq!(updated.models[0].configuration["context_window"], 192_000);
        assert_eq!(
            updated.models[0].configuration["max_context_window"],
            256_000
        );

        // Restoring defaults drops the saved override and follows the current API response.
        state.customizations = customizations_from_request(
            &updated,
            CatalogEditorRequest {
                revision: updated.revision.clone(),
                default_auto_review_model: None,
                models: vec![CatalogEditorModelRequest {
                    slug: runtime.slug.clone(),
                    configuration: updated.models[0].defaults.clone(),
                }],
            },
        )
        .unwrap();
        assert!(state.customizations.models.is_empty());
        let generated =
            prepare_catalog_with_customizations(&[runtime], &state.sources, &state.customizations)
                .unwrap();
        let model: Value = serde_json::from_str(&generated.json).unwrap();
        assert_eq!(model["models"][0]["context_window"], 512_000);
        assert_eq!(model["models"][0]["max_context_window"], 1_000_000);
    }

    #[test]
    fn stale_editor_revision_is_rejected_without_changing_state() {
        let sources = parse_sources(MODEL_CATALOG_JSON).unwrap();
        let mut state = CatalogState {
            sources,
            json: MODEL_CATALOG_JSON.to_string(),
            customizations: Default::default(),
        };
        let runtime_models = vec![runtime_model("third-party-model")];
        let snapshot = snapshot_for_state(&runtime_models, &state).unwrap();
        let path = temporary_path();
        let error = save_for_state(
            &path,
            &runtime_models,
            CatalogEditorRequest {
                revision: "stale".to_string(),
                default_auto_review_model: None,
                models: vec![CatalogEditorModelRequest {
                    slug: "third-party-model".to_string(),
                    configuration: snapshot.models[0].configuration.clone(),
                }],
            },
            &mut state,
        )
        .unwrap_err();

        assert_eq!(error, "CODEX_MODEL_CATALOG_CHANGED");
        assert!(state.customizations.models.is_empty());
        assert!(!path.exists());
    }
}
