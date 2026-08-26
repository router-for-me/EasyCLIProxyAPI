use crate::AgentModelOption;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{OnceLock, RwLock};

const MODEL_CATALOG_JSON: &str = include_str!("../resources/codex_models/model-catalog.json");

static CATALOG_STATE: OnceLock<Result<RwLock<CatalogState>, String>> = OnceLock::new();

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexRuntimeModel {
    pub(crate) slug: String,
    display_name: Option<String>,
    description: Option<String>,
    context_window: Option<u64>,
    max_context_window: Option<u64>,
    input_modalities: Option<Vec<String>>,
    supported_reasoning_levels: Option<Vec<String>>,
    default_reasoning_level: Option<String>,
    hidden: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PreparedCodexCatalog {
    pub(crate) models: Vec<AgentModelOption>,
    pub(crate) json: String,
}

#[derive(Clone, Debug)]
struct CatalogSources {
    fallback: Map<String, Value>,
    templates: HashMap<String, Template>,
    max_template_priority: i64,
}

#[derive(Clone, Debug)]
struct CatalogState {
    sources: CatalogSources,
    json: String,
}

#[derive(Clone, Debug)]
struct Template {
    value: Map<String, Value>,
    order: usize,
}

#[derive(Clone, Debug)]
struct CatalogEntry {
    value: Map<String, Value>,
    template_order: Option<usize>,
}

pub(crate) fn validate_embedded_catalog() -> Result<(), String> {
    catalog_state().map(|_| ())
}

pub(crate) fn activate_catalog_json(catalog_json: &str) -> Result<bool, String> {
    let parsed = parse_sources(catalog_json)?;
    let mut state = catalog_state()?
        .write()
        .map_err(|_| "Codex 模型目录内存锁已损坏".to_string())?;
    if state.json == catalog_json {
        return Ok(false);
    }
    state.sources = parsed;
    state.json = catalog_json.to_string();
    Ok(true)
}

pub(crate) fn validate_catalog_json(catalog_json: &str) -> Result<(), String> {
    parse_sources(catalog_json).map(|_| ())
}

pub(crate) fn current_catalog_json() -> Result<String, String> {
    let state = catalog_state()?
        .read()
        .map_err(|_| "Codex 模型目录内存锁已损坏".to_string())?;
    Ok(state.json.clone())
}

pub(crate) fn parse_runtime_models(payload: &Value) -> Result<Vec<CodexRuntimeModel>, String> {
    let values = payload
        .get("models")
        .and_then(Value::as_array)
        .or_else(|| payload.get("data").and_then(Value::as_array))
        .or_else(|| payload.as_array())
        .ok_or_else(|| "Codex 模型列表响应缺少 models 或 data 数组".to_string())?;

    let mut seen = HashSet::with_capacity(values.len());
    let mut models = Vec::with_capacity(values.len());
    for value in values {
        let slug = if let Some(value) = value.as_str() {
            value.trim()
        } else {
            ["slug", "id", "name", "model", "value"]
                .into_iter()
                .filter_map(|key| value.get(key).and_then(Value::as_str).map(str::trim))
                .find(|value| !value.is_empty())
                .unwrap_or_default()
        };
        if slug.is_empty() {
            continue;
        }

        let display_name = optional_string(value, &["display_name", "displayName"]);
        let model_alias =
            optional_string(value, &["alias"]).filter(|alias| !alias.eq_ignore_ascii_case(slug));
        let keep_original = value.get("fork").and_then(Value::as_bool).unwrap_or(false);
        let description = optional_string(value, &["description"]);
        let context_window = positive_u64_field(
            value,
            &[
                "context_window",
                "contextWindow",
                "context_length",
                "contextLength",
            ],
        );
        let max_context_window =
            positive_u64_field(value, &["max_context_window", "maxContextWindow"]);
        let input_modalities = parse_modalities(value);
        let supported_reasoning_levels = parse_reasoning_levels(value);
        let default_reasoning_level =
            optional_string(value, &["default_reasoning_level", "defaultReasoningLevel"])
                .map(|value| value.to_ascii_lowercase())
                .filter(|value| is_allowed_reasoning_level(value));
        let hidden = optional_string(value, &["visibility"])
            .is_some_and(|value| value.eq_ignore_ascii_case("hide"));

        let make_runtime_model = |slug: &str, display_name: Option<String>| CodexRuntimeModel {
            slug: slug.to_string(),
            display_name,
            description: description.clone(),
            context_window,
            max_context_window,
            input_modalities: input_modalities.clone(),
            supported_reasoning_levels: supported_reasoning_levels.clone(),
            default_reasoning_level: default_reasoning_level.clone(),
            hidden,
        };

        if let Some(model_alias) = model_alias {
            if keep_original && seen.insert(normalize_id(slug)) {
                models.push(make_runtime_model(slug, display_name));
            }
            if seen.insert(normalize_id(&model_alias)) {
                models.push(make_runtime_model(&model_alias, None));
            }
        } else if seen.insert(normalize_id(slug)) {
            models.push(make_runtime_model(slug, display_name));
        }
    }
    Ok(models)
}

pub(crate) fn merge_runtime_context_windows(
    models: &mut [AgentModelOption],
    runtime_models: &[CodexRuntimeModel],
) {
    for model in models {
        let Some(runtime_model) = runtime_models
            .iter()
            .find(|runtime_model| runtime_model.slug.eq_ignore_ascii_case(&model.name))
        else {
            continue;
        };
        if let Some(context_window) = runtime_model
            .context_window
            .or(runtime_model.max_context_window)
        {
            model.context_window = Some(context_window);
        }
    }
}

pub(crate) fn prepare_catalog(
    runtime_models: &[CodexRuntimeModel],
) -> Result<PreparedCodexCatalog, String> {
    let state = catalog_state()?
        .read()
        .map_err(|_| "Codex 模型目录内存锁已损坏".to_string())?;
    prepare_catalog_with_sources(runtime_models, &state.sources)
}

fn catalog_state() -> Result<&'static RwLock<CatalogState>, String> {
    CATALOG_STATE
        .get_or_init(|| {
            parse_sources(MODEL_CATALOG_JSON).map(|sources| {
                RwLock::new(CatalogState {
                    sources,
                    json: MODEL_CATALOG_JSON.to_string(),
                })
            })
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn parse_sources(catalog_json: &str) -> Result<CatalogSources, String> {
    let root: Value = serde_json::from_str(catalog_json)
        .map_err(|error| format!("解析内置 model-catalog.json 失败: {error}"))?;
    let root = root
        .as_object()
        .ok_or_else(|| "内置 model-catalog.json 根节点必须是对象".to_string())?;

    let fallback = root
        .get("fallback_model")
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| "内置 model-catalog.json 缺少 fallback_model 对象".to_string())?;
    validate_model(&fallback, "fallback_model", false)?;

    let values = root
        .get("models")
        .and_then(Value::as_array)
        .filter(|models| !models.is_empty())
        .ok_or_else(|| "内置 model-catalog.json 必须包含非空 models 数组".to_string())?;
    let mut templates = HashMap::with_capacity(values.len());
    let mut max_template_priority = 0;
    for (order, value) in values.iter().enumerate() {
        let model = value
            .as_object()
            .cloned()
            .ok_or_else(|| format!("内置 model-catalog.json 第 {} 个模型必须是对象", order + 1))?;
        validate_model(&model, &format!("第 {} 个正式模板", order + 1), true)?;
        let slug = string_value(&model, "slug");
        let key = normalize_id(&slug);
        if templates.contains_key(&key) {
            return Err(format!(
                "内置 model-catalog.json 模型 slug 大小写重复: {slug}"
            ));
        }
        max_template_priority = max_template_priority.max(priority_value(&model));
        templates.insert(
            key,
            Template {
                value: model,
                order,
            },
        );
    }

    Ok(CatalogSources {
        fallback,
        templates,
        max_template_priority,
    })
}

fn validate_model(
    model: &Map<String, Value>,
    label: &str,
    require_slug: bool,
) -> Result<(), String> {
    if require_slug && string_value(model, "slug").is_empty() {
        return Err(format!("内置 model-catalog.json {label} 的 slug 不能为空"));
    }
    if string_value(model, "base_instructions").is_empty() {
        return Err(format!(
            "内置 model-catalog.json {label} 的 base_instructions 不能为空"
        ));
    }
    validate_required_codex_fields(model, label)?;
    let context_window = positive_u64_value(model.get("context_window"))
        .ok_or_else(|| format!("内置 model-catalog.json {label} 的 context_window 必须为正数"))?;
    let max_context_window =
        positive_u64_value(model.get("max_context_window")).ok_or_else(|| {
            format!("内置 model-catalog.json {label} 的 max_context_window 必须为正数")
        })?;
    if max_context_window < context_window {
        return Err(format!(
            "内置 model-catalog.json {label} 的 max_context_window 不能小于 context_window"
        ));
    }
    Ok(())
}

fn validate_required_codex_fields(model: &Map<String, Value>, label: &str) -> Result<(), String> {
    for field in ["display_name", "shell_type", "visibility"] {
        if string_value(model, field).is_empty() {
            return Err(format!(
                "Codex 模型 {label} 的必填字段 {field} 必须是非空字符串"
            ));
        }
    }
    for field in ["supported_reasoning_levels", "experimental_supported_tools"] {
        if !model.get(field).is_some_and(Value::is_array) {
            return Err(format!("Codex 模型 {label} 的必填字段 {field} 必须是数组"));
        }
    }
    for field in [
        "supported_in_api",
        "support_verbosity",
        "supports_parallel_tool_calls",
    ] {
        if !model.get(field).is_some_and(Value::is_boolean) {
            return Err(format!(
                "Codex 模型 {label} 的必填字段 {field} 必须是布尔值"
            ));
        }
    }
    if !model
        .get("priority")
        .is_some_and(|value| value.as_i64().is_some() || value.as_u64().is_some())
    {
        return Err(format!("Codex 模型 {label} 的必填字段 priority 必须是整数"));
    }
    if !model
        .get("default_reasoning_summary")
        .is_some_and(Value::is_string)
    {
        return Err(format!(
            "Codex 模型 {label} 的必填字段 default_reasoning_summary 必须是字符串"
        ));
    }
    let truncation = model
        .get("truncation_policy")
        .and_then(Value::as_object)
        .ok_or_else(|| format!("Codex 模型 {label} 缺少 truncation_policy 对象"))?;
    if string_value(truncation, "mode").is_empty()
        || !truncation
            .get("limit")
            .is_some_and(|value| value.as_i64().is_some() || value.as_u64().is_some())
    {
        return Err(format!("Codex 模型 {label} 的 truncation_policy 无效"));
    }
    Ok(())
}

fn prepare_catalog_with_sources(
    runtime_models: &[CodexRuntimeModel],
    sources: &CatalogSources,
) -> Result<PreparedCodexCatalog, String> {
    if runtime_models.is_empty() {
        return Err("CPA 当前没有可写入 Codex 的模型".to_string());
    }

    let mut entries = Vec::with_capacity(runtime_models.len());
    for runtime in runtime_models {
        let key = normalize_id(&runtime.slug);
        if key.is_empty() {
            continue;
        }
        if let Some(template) = sources.templates.get(&key) {
            let mut value = template.value.clone();
            value.insert("slug".to_string(), Value::String(runtime.slug.clone()));
            value.insert(
                "display_name".to_string(),
                Value::String(
                    runtime
                        .display_name
                        .clone()
                        .unwrap_or_else(|| runtime.slug.clone()),
                ),
            );
            enable_fast_mode(&mut value);
            entries.push(CatalogEntry {
                value,
                template_order: Some(template.order),
            });
        } else {
            let mut value = sources.fallback.clone();
            apply_runtime_metadata(&mut value, runtime);
            disable_fallback_capabilities(&mut value);
            enable_fast_mode(&mut value);
            entries.push(CatalogEntry {
                value,
                template_order: None,
            });
        }
    }
    if entries.is_empty() {
        return Err("CPA 当前没有有效的 Codex 模型 ID".to_string());
    }

    for entry in &entries {
        let slug = string_value(&entry.value, "slug");
        validate_required_codex_fields(&entry.value, &slug)?;
    }

    let mut fallback_indexes = entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| entry.template_order.is_none())
        .map(|(index, entry)| {
            (
                index,
                string_value(&entry.value, "display_name").to_ascii_lowercase(),
                string_value(&entry.value, "slug").to_ascii_lowercase(),
            )
        })
        .collect::<Vec<_>>();
    fallback_indexes.sort_by(|left, right| left.1.cmp(&right.1).then_with(|| left.2.cmp(&right.2)));
    for (rank, (index, _, _)) in fallback_indexes.into_iter().enumerate() {
        entries[index].value.insert(
            "priority".to_string(),
            Value::Number((sources.max_template_priority + 100 * (rank as i64 + 1)).into()),
        );
    }

    entries.sort_by(
        |left, right| match (left.template_order, right.template_order) {
            (Some(left_order), Some(right_order)) => priority_value(&left.value)
                .cmp(&priority_value(&right.value))
                .then_with(|| left_order.cmp(&right_order)),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => priority_value(&left.value).cmp(&priority_value(&right.value)),
        },
    );

    let models = entries
        .iter()
        .map(|entry| AgentModelOption {
            name: string_value(&entry.value, "slug"),
            alias: optional_map_string(&entry.value, "display_name").filter(|display| {
                !display.eq_ignore_ascii_case(&string_value(&entry.value, "slug"))
            }),
            is_alias: false,
            context_window: positive_u64_value(entry.value.get("context_window")),
        })
        .collect::<Vec<_>>();
    let values = entries
        .into_iter()
        .map(|entry| Value::Object(entry.value))
        .collect::<Vec<_>>();
    let mut json = serde_json::to_string_pretty(&serde_json::json!({ "models": values }))
        .map_err(|error| format!("生成 Codex 模型目录失败: {error}"))?;
    json.push('\n');
    Ok(PreparedCodexCatalog { models, json })
}

fn apply_runtime_metadata(model: &mut Map<String, Value>, runtime: &CodexRuntimeModel) {
    model.insert("slug".to_string(), Value::String(runtime.slug.clone()));
    model.insert(
        "display_name".to_string(),
        Value::String(
            runtime
                .display_name
                .clone()
                .unwrap_or_else(|| runtime.slug.clone()),
        ),
    );
    model.insert("visibility".to_string(), Value::String("list".to_string()));
    if let Some(description) = runtime.description.as_ref() {
        model.insert(
            "description".to_string(),
            Value::String(description.clone()),
        );
    }

    if let Some(context_window) = runtime.context_window {
        let max_context_window = runtime
            .max_context_window
            .unwrap_or(context_window)
            .max(context_window);
        model.insert(
            "context_window".to_string(),
            Value::Number(context_window.into()),
        );
        model.insert(
            "max_context_window".to_string(),
            Value::Number(max_context_window.into()),
        );
    } else if let Some(max_context_window) = runtime.max_context_window {
        let context_window = positive_u64_value(model.get("context_window")).unwrap_or(128_000);
        model.insert(
            "max_context_window".to_string(),
            Value::Number(max_context_window.max(context_window).into()),
        );
    }

    if let Some(modalities) = runtime.input_modalities.as_ref() {
        model.insert(
            "input_modalities".to_string(),
            Value::Array(modalities.iter().cloned().map(Value::String).collect()),
        );
        model.insert(
            "supports_image_detail_original".to_string(),
            Value::Bool(modalities.iter().any(|value| value == "image")),
        );
    }

    apply_runtime_reasoning(model, runtime);
    if runtime.hidden {
        model.insert("visibility".to_string(), Value::String("hide".to_string()));
    }
}

fn apply_runtime_reasoning(model: &mut Map<String, Value>, runtime: &CodexRuntimeModel) {
    let Some(levels) = runtime.supported_reasoning_levels.as_ref() else {
        if let Some(default) = runtime.default_reasoning_level.as_ref() {
            let fallback_levels = reasoning_efforts(model);
            if fallback_levels.contains(default) {
                model.insert(
                    "default_reasoning_level".to_string(),
                    Value::String(default.clone()),
                );
            }
        }
        return;
    };
    let fallback_default = optional_map_string(model, "default_reasoning_level")
        .map(|value| value.to_ascii_lowercase());
    let default = runtime
        .default_reasoning_level
        .as_ref()
        .filter(|default| levels.contains(default))
        .cloned()
        .or_else(|| fallback_default.filter(|default| levels.contains(default)));
    let Some(default) = default else {
        return;
    };
    model.insert(
        "supported_reasoning_levels".to_string(),
        Value::Array(
            levels
                .iter()
                .map(|effort| {
                    serde_json::json!({
                        "effort": effort,
                        "description": reasoning_description(effort),
                    })
                })
                .collect(),
        ),
    );
    model.insert(
        "default_reasoning_level".to_string(),
        Value::String(default),
    );
}

fn disable_fallback_capabilities(model: &mut Map<String, Value>) {
    model.insert("prefer_websockets".to_string(), Value::Bool(false));
    model.insert("supports_search_tool".to_string(), Value::Bool(false));
    model.insert(
        "web_search_tool_type".to_string(),
        Value::String("text".to_string()),
    );
    model.insert("default_service_tier".to_string(), Value::Null);
    model.insert("upgrade".to_string(), Value::Null);
    model.insert("availability_nux".to_string(), Value::Null);
    model.remove("minimal_client_version");
}

fn enable_fast_mode(model: &mut Map<String, Value>) {
    model.insert(
        "service_tiers".to_string(),
        serde_json::json!([{
            "id": "priority",
            "name": "Fast",
            "description": "1.5x speed, increased usage"
        }]),
    );
    model.insert(
        "additional_speed_tiers".to_string(),
        serde_json::json!(["fast"]),
    );
}

fn parse_modalities(value: &Value) -> Option<Vec<String>> {
    let raw = value
        .get("input_modalities")
        .or_else(|| value.get("inputModalities"))
        .or_else(|| value.get("supported_input_modalities"))
        .and_then(Value::as_array)?;
    let mut seen = HashSet::new();
    let modalities = raw
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .filter(|value| matches!(value.as_str(), "text" | "image"))
        .filter(|value| seen.insert(value.clone()))
        .collect::<Vec<_>>();
    (!modalities.is_empty()).then_some(modalities)
}

fn parse_reasoning_levels(value: &Value) -> Option<Vec<String>> {
    let raw = value
        .get("supported_reasoning_levels")
        .or_else(|| value.get("supportedReasoningLevels"))
        .and_then(Value::as_array)
        .or_else(|| {
            value
                .get("thinking")
                .and_then(|thinking| thinking.get("levels"))
                .and_then(Value::as_array)
        })?;
    let mut seen = HashSet::new();
    let levels = raw
        .iter()
        .filter_map(|level| {
            level
                .as_str()
                .or_else(|| level.get("effort").and_then(Value::as_str))
        })
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .filter(|level| is_allowed_reasoning_level(level))
        .filter(|level| seen.insert(level.clone()))
        .collect::<Vec<_>>();
    (!levels.is_empty()).then_some(levels)
}

fn reasoning_efforts(model: &Map<String, Value>) -> Vec<String> {
    model
        .get("supported_reasoning_levels")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|level| level.get("effort").and_then(Value::as_str))
        .map(str::to_ascii_lowercase)
        .collect()
}

fn optional_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .filter_map(|key| value.get(*key).and_then(Value::as_str).map(str::trim))
        .find(|value| !value.is_empty())
        .map(str::to_string)
}

fn positive_u64_field(value: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| positive_u64_value(value.get(*key)))
}

fn positive_u64_value(value: Option<&Value>) -> Option<u64> {
    value
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_str()?.trim().parse().ok())
        })
        .filter(|value| *value > 0)
}

fn optional_map_string(model: &Map<String, Value>, key: &str) -> Option<String> {
    model
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn string_value(model: &Map<String, Value>, key: &str) -> String {
    optional_map_string(model, key).unwrap_or_default()
}

fn priority_value(model: &Map<String, Value>) -> i64 {
    model
        .get("priority")
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_u64().map(|value| value as i64))
        })
        .unwrap_or(100)
}

fn normalize_id(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn is_allowed_reasoning_level(level: &str) -> bool {
    matches!(
        level,
        "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
    )
}

fn reasoning_description(level: &str) -> &'static str {
    match level {
        "none" => "No reasoning",
        "minimal" => "Minimal reasoning",
        "low" => "Fast responses with lighter reasoning",
        "medium" => "Balances speed and reasoning depth for everyday tasks",
        "high" => "Greater reasoning depth for complex problems",
        "xhigh" => "Extra high reasoning depth for complex problems",
        "max" => "Maximum available reasoning depth for complex problems",
        "ultra" => "Highest available reasoning depth",
        _ => "Model-supported reasoning level",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_sources() -> CatalogSources {
        parse_sources(
            r#"{
              "fallback_model": {
                "base_instructions": "You are Codex, a model-neutral coding agent.",
                "display_name": "Compatible Model",
                "description": "Conservative fallback",
                "context_window": 128000,
                "max_context_window": 128000,
                "input_modalities": ["text"],
                "default_reasoning_level": "medium",
                "supported_reasoning_levels": [
                  {"effort":"low","description":"Low"},
                  {"effort":"medium","description":"Medium"},
                  {"effort":"high","description":"High"}
                ],
                "shell_type": "shell_command",
                "supported_in_api": true,
                "default_reasoning_summary": "none",
                "support_verbosity": false,
                "truncation_policy": {"mode":"tokens","limit":10000},
                "prefer_websockets": false,
                "supports_search_tool": false,
                "supports_parallel_tool_calls": true,
                "experimental_supported_tools": [],
                "service_tiers": [],
                "additional_speed_tiers": [],
                "visibility": "list",
                "priority": 100
              },
              "models": [
                {
                  "slug":"A",
                  "display_name":"Known A",
                  "base_instructions":"Known A",
                  "context_window":200000,
                  "max_context_window":200000,
                  "priority":10,
                  "supported_reasoning_levels":[],
                  "shell_type":"shell_command",
                  "visibility":"list",
                  "supported_in_api":true,
                  "default_reasoning_summary":"none",
                  "support_verbosity":false,
                  "truncation_policy":{"mode":"tokens","limit":10000},
                  "supports_parallel_tool_calls":true,
                  "experimental_supported_tools":[],
                  "service_tiers":[{"id":"priority"}],
                  "additional_speed_tiers":["fast"],
                  "nested":{"unknown":true}
                },
                {
                  "slug":"B",
                  "display_name":"Known B",
                  "base_instructions":"Known B",
                  "context_window":300000,
                  "max_context_window":300000,
                  "priority":20,
                  "supported_reasoning_levels":[],
                  "shell_type":"shell_command",
                  "visibility":"list",
                  "supported_in_api":true,
                  "default_reasoning_summary":"none",
                  "support_verbosity":false,
                  "truncation_policy":{"mode":"tokens","limit":10000},
                  "supports_parallel_tool_calls":true,
                  "experimental_supported_tools":[]
                }
              ]
            }"#,
        )
        .unwrap()
    }

    fn runtime(payload: Value) -> Vec<CodexRuntimeModel> {
        parse_runtime_models(&payload).unwrap()
    }

    fn output_models(catalog: &PreparedCodexCatalog) -> Vec<Map<String, Value>> {
        let root = serde_json::from_str::<Value>(&catalog.json).unwrap();
        assert!(root.get("fallback_model").is_none());
        root["models"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_object().unwrap().clone())
            .collect()
    }

    #[test]
    fn embedded_catalog_is_valid() {
        validate_embedded_catalog().unwrap();
        let state = catalog_state().unwrap().read().unwrap();
        let sources = &state.sources;
        assert_eq!(sources.templates.len(), 10);
        let fallback_prompt = string_value(&sources.fallback, "base_instructions");
        assert!(fallback_prompt.starts_with(
            "You are a coding agent running in the Codex CLI, a terminal-based coding assistant."
        ));
        assert!(!fallback_prompt.contains("GPT-5"));
        assert_eq!(sources.fallback["context_window"], 272_000);
        assert_eq!(sources.fallback["max_context_window"], 272_000);
        assert_eq!(
            sources.fallback["input_modalities"],
            serde_json::json!(["text", "image"])
        );
        assert_eq!(sources.fallback["default_reasoning_level"], Value::Null);
        assert!(reasoning_efforts(&sources.fallback).is_empty());
        assert_eq!(sources.fallback["shell_type"], "default");
        assert_eq!(sources.fallback["visibility"], "none");
        assert_eq!(sources.fallback["default_reasoning_summary"], "auto");
        assert_eq!(sources.fallback["supports_parallel_tool_calls"], false);
        assert_eq!(sources.fallback["truncation_policy"]["mode"], "bytes");

        let gpt = &sources.templates["gpt-5.6-sol"].value;
        let gpt_prompt = string_value(gpt, "base_instructions");
        let gpt_prompt_body = gpt_prompt.split_once("\n\n").unwrap().1;
        let gpt_messages = gpt["model_messages"].as_object().unwrap();
        let gpt_message_prompt = gpt_messages["instructions_template"].as_str().unwrap();
        let gpt_message_prompt_body = gpt_message_prompt.split_once("\n\n").unwrap().1;

        for slug in ["deepseek-v4-flash", "deepseek-v4-pro"] {
            let model = &sources.templates[slug].value;
            assert_eq!(model["context_window"], 1_000_000);
            assert_eq!(model["max_context_window"], 1_000_000);
            assert_eq!(model["default_reasoning_level"], "high");
            assert_eq!(reasoning_efforts(model), ["low", "high", "max"]);
            assert_eq!(model["input_modalities"], serde_json::json!(["text"]));
            assert_eq!(model["supports_parallel_tool_calls"], false);
            assert_eq!(model["supports_search_tool"], false);
            assert_eq!(model["service_tiers"], serde_json::json!([]));
            assert_eq!(model["additional_speed_tiers"], serde_json::json!([]));

            let prompt = string_value(model, "base_instructions");
            assert!(
                prompt.starts_with("You are Codex, a coding agent powered by a DeepSeek model.")
            );
            assert_eq!(prompt.split_once("\n\n").unwrap().1, gpt_prompt_body);

            let mut normalized_messages = model["model_messages"].as_object().unwrap().clone();
            let message_prompt = normalized_messages["instructions_template"]
                .as_str()
                .unwrap();
            assert!(message_prompt
                .starts_with("You are Codex, a coding agent powered by a DeepSeek model."));
            assert_eq!(
                message_prompt.split_once("\n\n").unwrap().1,
                gpt_message_prompt_body
            );
            normalized_messages.insert(
                "instructions_template".to_string(),
                Value::String(gpt_message_prompt.to_string()),
            );
            assert_eq!(&normalized_messages, gpt_messages);
        }
    }

    #[test]
    fn runtime_parser_prefers_models_and_keeps_first_duplicate() {
        let models = runtime(serde_json::json!({
            "models": [
                {"slug":"Model-A","context_window":"200000"},
                {"id":"model-a","context_window":1},
                {"slug":"  ","id":"Model-B"},
                {"id":""}
            ],
            "data": [{"id":"ignored"}]
        }));
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].slug, "Model-A");
        assert_eq!(models[0].context_window, Some(200_000));
        assert_eq!(models[1].slug, "Model-B");
    }

    #[test]
    fn runtime_parser_exposes_model_alias_as_a_runtime_slug() {
        let models = runtime(serde_json::json!({
            "models": [
                {
                    "id": "gpt-5.5",
                    "alias": "gpt-5.5-xhigh",
                    "fork": true,
                    "context_window": 200000
                },
                {"id": "hidden-source", "alias": "visible-alias"}
            ]
        }));

        assert_eq!(
            models
                .iter()
                .map(|model| model.slug.as_str())
                .collect::<Vec<_>>(),
            vec!["gpt-5.5", "gpt-5.5-xhigh", "visible-alias"]
        );
        assert_eq!(models[1].display_name, None);
        assert_eq!(models[1].context_window, Some(200_000));
        assert_eq!(models[2].display_name, None);

        let catalog = prepare_catalog_with_sources(&models, &test_sources()).unwrap();
        assert_eq!(
            catalog
                .models
                .iter()
                .map(|model| model.name.as_str())
                .collect::<Vec<_>>(),
            vec!["gpt-5.5", "gpt-5.5-xhigh", "visible-alias"]
        );
        assert_eq!(catalog.models[1].alias, None);
    }

    #[test]
    fn runtime_context_windows_override_generic_model_metadata() {
        let mut models = vec![
            AgentModelOption {
                name: "GPT-Test".to_string(),
                alias: None,
                is_alias: false,
                context_window: Some(200_000),
            },
            AgentModelOption {
                name: "unmatched".to_string(),
                alias: None,
                is_alias: false,
                context_window: Some(128_000),
            },
            AgentModelOption {
                name: "max-only".to_string(),
                alias: None,
                is_alias: false,
                context_window: None,
            },
        ];
        let runtime_models = runtime(serde_json::json!({"models":[
            {"id":"gpt-test","context_window":372000},
            {"id":"max-only","max_context_window":272000}
        ]}));

        merge_runtime_context_windows(&mut models, &runtime_models);

        assert_eq!(models[0].context_window, Some(372_000));
        assert_eq!(models[1].context_window, Some(128_000));
        assert_eq!(models[2].context_window, Some(272_000));
    }

    #[test]
    fn all_runtime_models_advertise_fast_capabilities() {
        let runtime = runtime(serde_json::json!({"models":[
            {"id":"B"},
            {"id":"remote-model-alias"}
        ]}));

        let catalog = prepare_catalog_with_sources(&runtime, &test_sources()).unwrap();
        for model in output_models(&catalog) {
            assert_eq!(
                model["service_tiers"],
                serde_json::json!([{
                    "id": "priority",
                    "name": "Fast",
                    "description": "1.5x speed, increased usage"
                }])
            );
            assert_eq!(model["additional_speed_tiers"], serde_json::json!(["fast"]));
        }
    }

    #[test]
    fn known_and_unknown_models_are_composed_from_the_correct_sources() {
        let runtime = runtime(serde_json::json!({"models":[
            {"id":"b","display_name":"Runtime B","context_window":1},
            {"id":"C","display_name":"Runtime C","context_window":200000}
        ]}));
        let catalog = prepare_catalog_with_sources(&runtime, &test_sources()).unwrap();
        let models = output_models(&catalog);
        assert_eq!(
            models
                .iter()
                .map(|model| string_value(model, "slug"))
                .collect::<Vec<_>>(),
            ["b", "C"]
        );
        assert_eq!(models[0]["base_instructions"], "Known B");
        assert_eq!(models[0]["context_window"], 300_000);
        assert_eq!(
            models[1]["base_instructions"],
            "You are Codex, a model-neutral coding agent."
        );
        assert_eq!(models[1]["context_window"], 200_000);
        assert_eq!(models[1]["max_context_window"], 200_000);
        assert!(models[1]["priority"].as_i64().unwrap() > 20);
    }

    #[test]
    fn known_template_is_preserved_except_for_runtime_identity() {
        let sources = test_sources();
        let runtime = runtime(serde_json::json!({"data":[{
            "id":"a",
            "display_name":"Overwrite",
            "context_window":1,
            "service_tiers":[]
        }]}));
        let catalog = prepare_catalog_with_sources(&runtime, &sources).unwrap();
        let model = &output_models(&catalog)[0];
        let template = &sources.templates["a"].value;
        for (key, expected) in template {
            if !matches!(
                key.as_str(),
                "slug" | "display_name" | "service_tiers" | "additional_speed_tiers"
            ) {
                assert_eq!(model.get(key), Some(expected), "changed field {key}");
            }
        }
        assert_eq!(model["slug"], "a");
        assert_eq!(model["display_name"], "Overwrite");
        assert_eq!(model["nested"]["unknown"], true);
        assert_eq!(
            model["service_tiers"],
            serde_json::json!([{
                "id": "priority",
                "name": "Fast",
                "description": "1.5x speed, increased usage"
            }])
        );
        assert_eq!(model["additional_speed_tiers"], serde_json::json!(["fast"]));
    }

    #[test]
    fn known_template_uses_runtime_slug_when_display_name_is_missing() {
        let runtime = runtime(serde_json::json!({"models":[{"id":"A"}]}));
        let catalog = prepare_catalog_with_sources(&runtime, &test_sources()).unwrap();
        let model = &output_models(&catalog)[0];

        assert_eq!(model["slug"], "A");
        assert_eq!(model["display_name"], "A");
    }

    #[test]
    fn fallback_accepts_only_safe_valid_metadata() {
        let runtime = runtime(serde_json::json!({"models":[{
            "id":"C",
            "display_name":"Third Party",
            "description":"Detailed",
            "context_window":200000,
            "max_context_window":100000,
            "input_modalities":["image","IMAGE","audio"],
            "supported_reasoning_levels":["low", {"effort":"high"}],
            "default_reasoning_level":"high",
            "visibility":"hide",
            "base_instructions":"unsafe",
            "supports_search_tool":true,
            "service_tiers":[{"id":"priority"}]
        }]}));
        let catalog = prepare_catalog_with_sources(&runtime, &test_sources()).unwrap();
        let model = &output_models(&catalog)[0];
        assert_eq!(model["display_name"], "Third Party");
        assert_eq!(model["context_window"], 200_000);
        assert_eq!(model["max_context_window"], 200_000);
        assert_eq!(model["input_modalities"], serde_json::json!(["image"]));
        assert_eq!(model["default_reasoning_level"], "high");
        assert_eq!(model["visibility"], "hide");
        assert_eq!(
            model["base_instructions"],
            "You are Codex, a model-neutral coding agent."
        );
        assert_eq!(model["supports_search_tool"], false);
        assert_eq!(
            model["service_tiers"],
            serde_json::json!([{
                "id": "priority",
                "name": "Fast",
                "description": "1.5x speed, increased usage"
            }])
        );
        assert_eq!(model["additional_speed_tiers"], serde_json::json!(["fast"]));
    }

    #[test]
    fn invalid_reasoning_combination_keeps_fallback_and_missing_context_uses_128k() {
        let runtime = runtime(serde_json::json!({"models":[{
            "id":"C",
            "supported_reasoning_levels":["xhigh"],
            "default_reasoning_level":"invalid"
        }]}));
        let catalog = prepare_catalog_with_sources(&runtime, &test_sources()).unwrap();
        let model = &output_models(&catalog)[0];
        assert_eq!(model["context_window"], 128_000);
        assert_eq!(model["max_context_window"], 128_000);
        assert_eq!(model["display_name"], "C");
        assert_eq!(model["visibility"], "list");
        assert_eq!(model["web_search_tool_type"], "text");
        assert_eq!(model["availability_nux"], Value::Null);
        assert_eq!(model["upgrade"], Value::Null);
        assert_eq!(model["default_reasoning_level"], "medium");
        assert_eq!(reasoning_efforts(model), ["low", "medium", "high"]);
    }

    #[test]
    fn invalid_catalogs_and_empty_runtime_are_rejected() {
        let mut invalid_fallback = test_sources().fallback;
        invalid_fallback.remove("experimental_supported_tools");
        assert!(validate_model(&invalid_fallback, "fallback_model", false).is_err());
        assert!(parse_sources(r#"{"fallback_model":{},"models":[]}"#).is_err());
        assert!(parse_sources(
            r#"{
              "fallback_model":{"base_instructions":"x","context_window":2,"max_context_window":1},
              "models":[{"slug":"A","base_instructions":"A","context_window":1,"max_context_window":1}]
            }"#
        )
        .is_err());
        assert!(parse_sources(
            r#"{
            "fallback_model":{"base_instructions":"x","context_window":1,"max_context_window":1},
            "models":[
              {"slug":"A","context_window":1,"max_context_window":1},
              {"slug":"a","context_window":1,"max_context_window":1}
            ]
        }"#
        )
        .is_err());
        assert!(prepare_catalog_with_sources(&[], &test_sources()).is_err());
    }
}
