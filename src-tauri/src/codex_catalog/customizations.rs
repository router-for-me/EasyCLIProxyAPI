use super::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::Path;

pub(super) type ModelCustomizations = BTreeMap<String, Map<String, Value>>;

const EDITABLE_FIELDS: [&str; 11] = [
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
];

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedCustomizations {
    version: u32,
    models: ModelCustomizations,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CatalogEditorSnapshot {
    revision: String,
    models: Vec<CatalogEditorModel>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogEditorModel {
    slug: String,
    has_official_template: bool,
    customized: bool,
    configuration: Map<String, Value>,
    defaults: Map<String, Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CatalogEditorRequest {
    revision: String,
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
                model.get(*field).cloned().unwrap_or(Value::Null),
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

pub(super) fn apply_customizations(
    model: &mut Map<String, Value>,
    customizations: &ModelCustomizations,
) -> Result<(), String> {
    let slug = string_value(model, "slug");
    if let Some(customization) = customizations.get(&normalize_id(&slug)) {
        model.extend(customization.clone());
        validate_configuration(&editable_configuration(model))
            .map_err(|error| format!("模型 {slug} 的自定义配置无效: {error}"))?;
        enable_fast_mode(model);
    }
    Ok(())
}

fn snapshot_for_state(
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
        let defaults = editable_configuration(&model);
        apply_customizations(&mut model, &state.customizations)?;
        models.push(CatalogEditorModel {
            slug,
            has_official_template: state.sources.templates.contains_key(&key),
            customized: state.customizations.contains_key(&key),
            configuration: editable_configuration(&model),
            defaults,
        });
    }
    let mut digest = Sha256::new();
    digest.update(baseline.as_bytes());
    digest.update(serde_json::to_vec(&state.customizations).map_err(|error| error.to_string())?);
    Ok(CatalogEditorSnapshot {
        revision: format!("{:x}", digest.finalize()),
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
    Ok(customizations)
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
    let mut normalized = BTreeMap::new();
    for (slug, model) in saved.models {
        let key = normalize_id(&slug);
        if key.is_empty() || normalized.contains_key(&key) {
            return Err("自定义模型 ID 为空或重复".to_string());
        }
        validate_configuration(&model)?;
        normalized.insert(key, model);
    }
    Ok(normalized)
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
        models: customizations,
    };
    let content = serde_json::to_vec_pretty(&saved).map_err(|error| error.to_string())?;
    if content.len() > crate::MAX_CODEX_MODEL_CATALOG_BYTES {
        return Err("Codex 自定义模型配置超过大小限制".to_string());
    }
    crate::write_bytes_atomically(path, &content)?;
    state.customizations = saved.models;
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
                models: vec![CatalogEditorModelRequest {
                    slug: "third-party-model".to_string(),
                    configuration: saved.models[0].defaults.clone(),
                }],
            },
            &mut state,
        )
        .unwrap();
        assert!(!restored.models[0].customized);
        assert!(state.customizations.is_empty());
        let persisted: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(persisted["models"], serde_json::json!({}));

        let _ = std::fs::remove_file(path);
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
                models: vec![CatalogEditorModelRequest {
                    slug: "third-party-model".to_string(),
                    configuration: snapshot.models[0].configuration.clone(),
                }],
            },
            &mut state,
        )
        .unwrap_err();

        assert_eq!(error, "CODEX_MODEL_CATALOG_CHANGED");
        assert!(state.customizations.is_empty());
        assert!(!path.exists());
    }
}
