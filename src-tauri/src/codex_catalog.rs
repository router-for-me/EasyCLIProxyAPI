use crate::AgentModelOption;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{OnceLock, RwLock};

mod customizations;
pub(crate) use customizations::{
    editor_snapshot, load_customizations, save_customizations, CatalogEditorRequest,
    CatalogEditorSnapshot,
};

const MODEL_CATALOG_JSON: &str = include_str!("../resources/codex_models/model-catalog.json");
const FALLBACK_MODEL_JSON: &str = include_str!("../resources/codex_models/fallback-model.json");

static CATALOG_STATE: OnceLock<Result<RwLock<CatalogState>, String>> = OnceLock::new();

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexRuntimeModel {
    pub(crate) slug: String,
    display_name: Option<String>,
    description: Option<String>,
    context_window: Option<u64>,
    max_context_window: Option<u64>,
    input_modalities: Option<Vec<String>>,
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
    revision: u64,
    fallback: Map<String, Value>,
    templates: HashMap<String, Template>,
    max_template_priority: i64,
}

#[derive(Clone, Debug)]
struct CatalogState {
    sources: CatalogSources,
    json: String,
    customizations: customizations::ModelCustomizations,
}

impl CatalogState {
    fn activate(&mut self, catalog_json: &str, sources: CatalogSources) -> bool {
        if sources.revision < self.sources.revision || self.json == catalog_json {
            return false;
        }
        self.sources = sources;
        self.json = catalog_json.to_string();
        true
    }
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
    Ok(state.activate(catalog_json, parsed))
}

pub(crate) fn validate_catalog_json(catalog_json: &str) -> Result<u64, String> {
    parse_sources(catalog_json).map(|sources| sources.revision)
}

pub(crate) fn current_catalog_revision() -> Result<u64, String> {
    let state = catalog_state()?
        .read()
        .map_err(|_| "Codex 模型目录内存锁已损坏".to_string())?;
    Ok(state.sources.revision)
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
    if !values.is_empty() && models.is_empty() {
        return Err("Codex 模型列表响应未包含有效的模型 ID".to_string());
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
    prepare_catalog_with_customizations(runtime_models, &state.sources, &state.customizations)
}

fn catalog_state() -> Result<&'static RwLock<CatalogState>, String> {
    CATALOG_STATE
        .get_or_init(|| {
            parse_sources(MODEL_CATALOG_JSON).map(|sources| {
                RwLock::new(CatalogState {
                    sources,
                    json: MODEL_CATALOG_JSON.to_string(),
                    customizations: Default::default(),
                })
            })
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn parse_sources(catalog_json: &str) -> Result<CatalogSources, String> {
    let fallback = parse_fallback_model(FALLBACK_MODEL_JSON)?;
    parse_catalog_sources(catalog_json, fallback)
}

fn parse_fallback_model(fallback_json: &str) -> Result<Map<String, Value>, String> {
    let fallback: Value = serde_json::from_str(fallback_json)
        .map_err(|error| format!("解析内置 fallback-model.json 失败: {error}"))?;
    let fallback = fallback
        .as_object()
        .cloned()
        .ok_or_else(|| "内置 fallback-model.json 根节点必须是对象".to_string())?;
    validate_model(&fallback, "fallback-model.json", false)?;
    Ok(fallback)
}

fn parse_catalog_sources(
    catalog_json: &str,
    fallback: Map<String, Value>,
) -> Result<CatalogSources, String> {
    let root: Value = serde_json::from_str(catalog_json)
        .map_err(|error| format!("解析内置 model-catalog.json 失败: {error}"))?;
    let root = root
        .as_object()
        .ok_or_else(|| "内置 model-catalog.json 根节点必须是对象".to_string())?;

    let revision = match root.get("catalog_revision") {
        Some(value) => value
            .as_u64()
            .ok_or_else(|| "Codex 模型目录 catalog_revision 必须为非负整数".to_string())?,
        None => 0,
    };

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
        revision,
        fallback,
        templates,
        max_template_priority,
    })
}

#[cfg(test)]
fn parse_combined_sources_for_test(catalog_json: &str) -> Result<CatalogSources, String> {
    let mut root: Value = serde_json::from_str(catalog_json)
        .map_err(|error| format!("解析测试 model-catalog.json 失败: {error}"))?;
    let fallback = root
        .as_object_mut()
        .and_then(|root| root.remove("fallback_model"))
        .and_then(|fallback| fallback.as_object().cloned())
        .ok_or_else(|| "测试 model-catalog.json 缺少 fallback_model 对象".to_string())?;
    validate_model(&fallback, "测试 fallback_model", false)?;
    parse_catalog_sources(&root.to_string(), fallback)
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

#[cfg(test)]
fn prepare_catalog_with_sources(
    runtime_models: &[CodexRuntimeModel],
    sources: &CatalogSources,
) -> Result<PreparedCodexCatalog, String> {
    prepare_catalog_with_customizations(runtime_models, sources, &Default::default())
}

fn prepare_catalog_with_customizations(
    runtime_models: &[CodexRuntimeModel],
    sources: &CatalogSources,
    customizations: &customizations::ModelCustomizations,
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
                Value::String(runtime.slug.clone()),
            );
            enable_fast_mode(&mut value);
            entries.push(CatalogEntry {
                value,
                template_order: Some(template.order),
            });
        } else {
            let mut value = sources.fallback.clone();
            normalize_fallback_model(&mut value);
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

    for entry in &mut entries {
        customizations::apply_customizations(&mut entry.value, customizations)?;
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

fn normalize_fallback_model(model: &mut Map<String, Value>) {
    if matches!(
        string_value(model, "shell_type").as_str(),
        "default" | "local" | "shell_command"
    ) {
        model.insert(
            "shell_type".to_string(),
            Value::String("unified_exec".to_string()),
        );
    }
    for field in [
        "include_skills_usage_instructions",
        "include_plugin_usage_instructions",
        "include_apps_usage_instructions",
        "node_repl_auto_review_required",
        "node_repl_disabled",
        "supports_image_detail_original",
    ] {
        model.entry(field.to_string()).or_insert(Value::Bool(false));
    }
    for field in [
        "guardian",
        "auto_review_model_override",
        "model_specialty",
        "tool_mode",
        "multi_agent_version",
        "multi_agent_reasoning_effort",
    ] {
        model.entry(field.to_string()).or_insert(Value::Null);
    }
    let base_instructions = model
        .get("base_instructions")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let messages = model
        .entry("model_messages".to_string())
        .or_insert(Value::Null);
    if !messages.is_object() {
        *messages = Value::Object(Map::new());
    }
    if let Some(messages) = messages.as_object_mut() {
        if !messages
            .get("instructions_template")
            .is_some_and(Value::is_string)
        {
            messages.insert(
                "instructions_template".to_string(),
                Value::String(base_instructions),
            );
        }
        for field in [
            "persistent_instructions",
            "tools",
            "instructions_variables",
            "approvals",
            "collaboration_modes",
            "auto_review",
            "permissions",
            "multi_agent",
            "token_budget",
            "confirmation_policies",
            "guardian_v2",
        ] {
            messages.entry(field.to_string()).or_insert(Value::Null);
        }
    }
}

fn apply_runtime_metadata(model: &mut Map<String, Value>, runtime: &CodexRuntimeModel) {
    model.insert("slug".to_string(), Value::String(runtime.slug.clone()));
    model.insert(
        "display_name".to_string(),
        Value::String(runtime.slug.clone()),
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
    }

    if runtime.hidden {
        model.insert("visibility".to_string(), Value::String("hide".to_string()));
    }
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

#[cfg(test)]
mod tests {
    use super::*;

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

    fn test_sources() -> CatalogSources {
        parse_combined_sources_for_test(
            r#"{
              "fallback_model": {
                "base_instructions": "You are Codex, a model-neutral coding agent.",
                "display_name": "Compatible Model",
                "description": "Conservative fallback",
                "context_window": 128000,
                "max_context_window": 128000,
                "input_modalities": ["text"],
                "default_reasoning_level": null,
                "supported_reasoning_levels": [],
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
        assert_eq!(sources.templates.len(), 11);
        assert_eq!(sources.revision, 3);
        let embedded: Value = serde_json::from_str(MODEL_CATALOG_JSON).unwrap();
        assert!(embedded.get("fallback_model").is_none());
        assert_eq!(
            embedded["upstream_codex_commit"],
            "ddf04ad26789d040f9ef6a96736f76602e35a6cc"
        );
        let fallback: Value = serde_json::from_str(FALLBACK_MODEL_JSON).unwrap();
        assert!(fallback.get("fallback_model").is_none());
        assert_eq!(fallback.as_object(), Some(&sources.fallback));
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
        assert_eq!(sources.fallback["default_reasoning_level"], "medium");
        assert_eq!(
            reasoning_efforts(&sources.fallback),
            ["low", "medium", "high", "xhigh", "max", "ultra"]
        );
        assert_eq!(sources.fallback["shell_type"], "unified_exec");
        assert_eq!(sources.fallback["visibility"], "none");
        assert_eq!(sources.fallback["default_reasoning_summary"], "auto");
        assert_eq!(sources.fallback["supports_parallel_tool_calls"], false);
        assert_eq!(sources.fallback["truncation_policy"]["mode"], "bytes");

        let official_slugs = [
            "gpt-6-astra",
            "gpt-5.6-sol",
            "gpt-5.6-terra",
            "gpt-5.6-luna",
            "gpt-daybreak-blue-latest",
            "gpt-daybreak-red-latest",
            "gpt-5.5",
            "gpt-5.4",
            "gpt-5.4-mini",
            "gpt-5.2",
            "codex-auto-review",
        ];
        assert!(official_slugs
            .iter()
            .all(|slug| sources.templates.contains_key(*slug)));
        let astra = &sources.templates["gpt-6-astra"].value;
        assert_eq!(astra["context_window"], 272_000);
        assert_eq!(astra["max_context_window"], 872_000);
        assert_eq!(astra["default_reasoning_level"], "low");
        assert_eq!(
            reasoning_efforts(astra),
            ["low", "medium", "high", "xhigh", "max", "ultra"]
        );
        assert!(astra["model_messages"]["instructions_template"]
            .as_str()
            .is_some_and(|prompt| prompt.starts_with("You are Codex, an agent based on GPT-6.")));
        assert_eq!(
            astra["base_instructions"],
            astra["model_messages"]["instructions_template"]
                .as_str()
                .unwrap()
                .replace("{{ personality }}", "")
        );

        for slug in [
            "gpt-5.3-codex-spark",
            "deepseek-v4-flash",
            "deepseek-v4-pro",
        ] {
            assert!(!sources.templates.contains_key(slug));
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
    fn catalog_state_rejects_older_revisions_but_accepts_same_revision_updates() {
        let mut current = test_sources();
        current.revision = 2;
        let mut state = CatalogState {
            sources: current,
            json: "revision-two".to_string(),
            customizations: Default::default(),
        };

        let mut older = test_sources();
        older.revision = 1;
        assert!(!state.activate("older", older));
        assert_eq!(state.json, "revision-two");
        assert_eq!(state.sources.revision, 2);

        let mut replacement = test_sources();
        replacement.revision = 2;
        assert!(state.activate("replacement", replacement));
        assert_eq!(state.json, "replacement");
        assert_eq!(state.sources.revision, 2);
        assert!(!state.activate("replacement", test_sources()));
    }

    #[test]
    fn catalog_revision_must_be_a_non_negative_integer() {
        assert_eq!(test_sources().revision, 0);
        for revision in [
            serde_json::json!(-1),
            serde_json::json!(1.5),
            serde_json::json!("1"),
        ] {
            let mut value: Value = serde_json::from_str(MODEL_CATALOG_JSON).unwrap();
            value["catalog_revision"] = revision;
            assert!(parse_sources(&value.to_string()).is_err());
        }
    }

    #[test]
    fn catalog_payload_cannot_override_the_managed_fallback_model() {
        let mut catalog: Value = serde_json::from_str(MODEL_CATALOG_JSON).unwrap();
        catalog["fallback_model"] = serde_json::json!({
            "base_instructions": "Untrusted remote fallback",
            "context_window": 1,
            "max_context_window": 1
        });

        let sources = parse_sources(&catalog.to_string()).unwrap();
        assert_ne!(
            sources.fallback["base_instructions"],
            "Untrusted remote fallback"
        );
        assert_eq!(sources.fallback["context_window"], 272_000);
        assert_eq!(sources.fallback["max_context_window"], 272_000);
    }

    #[test]
    fn runtime_parser_distinguishes_empty_lists_from_invalid_model_entries() {
        for payload in [
            serde_json::json!({"models": []}),
            serde_json::json!({"data": []}),
            serde_json::json!([]),
        ] {
            assert!(parse_runtime_models(&payload).unwrap().is_empty());
        }
        for payload in [
            serde_json::json!({"error": "unavailable"}),
            serde_json::json!({"models": null}),
            serde_json::json!({"models": [null, {}, {"id": " "}]}),
        ] {
            assert!(parse_runtime_models(&payload).is_err());
        }
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
    fn known_template_preserves_unrelated_capabilities() {
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
        assert_eq!(model["display_name"], "a");
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
    fn known_template_uses_runtime_slug_as_display_name() {
        let runtime = runtime(serde_json::json!({"models":[{
            "id":"A",
            "display_name":"Friendly A"
        }]}));
        let catalog = prepare_catalog_with_sources(&runtime, &test_sources()).unwrap();
        let model = &output_models(&catalog)[0];

        assert_eq!(model["slug"], "A");
        assert_eq!(model["display_name"], "A");
    }

    #[test]
    fn known_template_preserves_its_reasoning_levels_and_default() {
        let mut sources = test_sources();
        let template = &mut sources.templates.get_mut("a").unwrap().value;
        template.insert(
            "default_reasoning_level".to_string(),
            Value::String("medium".to_string()),
        );
        template.insert(
            "supported_reasoning_levels".to_string(),
            serde_json::json!([
                {"effort":"low","description":"Low"},
                {"effort":"medium","description":"Medium"},
                {"effort":"max","description":"Max"}
            ]),
        );
        let runtime = runtime(serde_json::json!({"models":[{
            "id":"A",
            "default_reasoning_level":"high",
            "supported_reasoning_levels":["low", "high"]
        }]}));
        let catalog = prepare_catalog_with_sources(&runtime, &sources).unwrap();
        let model = &output_models(&catalog)[0];

        assert_eq!(model["default_reasoning_level"], "medium");
        assert_eq!(reasoning_efforts(model), ["low", "medium", "max"]);
    }

    #[test]
    fn gpt_6_astra_generation_uses_official_template_and_optional_fast_mode() {
        let sources = parse_sources(MODEL_CATALOG_JSON).unwrap();
        let runtime = runtime(serde_json::json!({"models":[{
            "id":"gpt-6-astra",
            "context_window":1048576,
            "max_context_window":1048576,
            "default_reasoning_level":"high"
        }]}));
        let catalog = prepare_catalog_with_sources(&runtime, &sources).unwrap();
        let model = &output_models(&catalog)[0];

        assert_eq!(model["context_window"], 272_000);
        assert_eq!(model["max_context_window"], 872_000);
        assert_eq!(model["default_reasoning_level"], "low");
        assert_eq!(
            reasoning_efforts(model),
            ["low", "medium", "high", "xhigh", "max", "ultra"]
        );
        assert_eq!(model["default_service_tier"], Value::Null);
        assert_eq!(model["additional_speed_tiers"], serde_json::json!(["fast"]));
        assert_eq!(
            model["service_tiers"],
            serde_json::json!([{
                "id": "priority",
                "name": "Fast",
                "description": "1.5x speed, increased usage"
            }])
        );
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
        assert_eq!(model["display_name"], "C");
        assert!(reasoning_efforts(model).is_empty());
        assert_eq!(model["context_window"], 200_000);
        assert_eq!(model["max_context_window"], 200_000);
        assert_eq!(model["input_modalities"], serde_json::json!(["image"]));
        assert_eq!(model["supports_image_detail_original"], false);
        assert_eq!(model["default_reasoning_level"], Value::Null);
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
    fn generated_fallback_uses_official_defaults_with_reasoning_and_fast_available() {
        let sources = parse_sources(MODEL_CATALOG_JSON).unwrap();
        let runtime = runtime(serde_json::json!({"models":[{"id":"unknown-model"}]}));
        let catalog = prepare_catalog_with_sources(&runtime, &sources).unwrap();
        let model = &output_models(&catalog)[0];
        let expected: Value = serde_json::from_str(
            r#"{
            "slug": "unknown-model",
            "display_name": "unknown-model",
            "description": null,
            "context_window": 272000,
            "max_context_window": 272000,
            "auto_compact_token_limit": null,
            "comp_hash": null,
            "effective_context_window_percent": 95,
            "default_reasoning_level": "medium",
            "supported_reasoning_levels": [
                {"effort": "low", "description": "Low reasoning effort"},
                {"effort": "medium", "description": "Medium reasoning effort"},
                {"effort": "high", "description": "High reasoning effort"},
                {"effort": "xhigh", "description": "Extra high reasoning effort"},
                {"effort": "max", "description": "Maximum reasoning effort"},
                {"effort": "ultra", "description": "Ultra reasoning effort"}
            ],
            "shell_type": "unified_exec",
            "input_modalities": ["text", "image"],
            "supports_image_detail_original": false,
            "supports_reasoning_summary_parameter": true,
            "default_reasoning_summary": "auto",
            "support_verbosity": false,
            "default_verbosity": null,
            "apply_patch_tool_type": null,
            "web_search_tool_type": "text",
            "truncation_policy": {"mode": "bytes", "limit": 10000},
            "experimental_supported_tools": [],
            "supported_in_api": true,
            "include_skills_usage_instructions": false,
            "include_plugin_usage_instructions": false,
            "include_apps_usage_instructions": false,
            "supports_search_tool": false,
            "use_responses_lite": false,
            "guardian": null,
            "node_repl_auto_review_required": false,
            "node_repl_disabled": false,
            "auto_review_model_override": null,
            "model_specialty": null,
            "tool_mode": null,
            "multi_agent_version": null,
            "multi_agent_reasoning_effort": null,
            "availability_nux": null,
            "upgrade": null,
            "default_service_tier": null,
            "visibility": "list",
            "additional_speed_tiers": ["fast"],
            "service_tiers": [{
                "id": "priority",
                "name": "Fast",
                "description": "1.5x speed, increased usage"
            }]
        }"#,
        )
        .unwrap();
        for (field, value) in expected.as_object().unwrap() {
            assert_eq!(model.get(field), Some(value), "field: {field}");
        }
        assert_eq!(
            model["model_messages"]["instructions_template"],
            sources.fallback["base_instructions"]
        );
        let messages = model["model_messages"].as_object().unwrap();
        assert_eq!(messages.len(), 12);
        assert!(messages
            .iter()
            .all(|(field, value)| field == "instructions_template" || value.is_null()));
    }

    #[test]
    fn legacy_fallback_templates_receive_official_message_and_capability_defaults() {
        let sources = test_sources();
        let runtime = runtime(serde_json::json!({"models":[{"id":"C"}]}));
        let catalog = prepare_catalog_with_sources(&runtime, &sources).unwrap();
        let model = &output_models(&catalog)[0];

        assert_eq!(model["shell_type"], "unified_exec");
        assert_eq!(model["include_apps_usage_instructions"], false);
        assert_eq!(model["include_plugin_usage_instructions"], false);
        assert_eq!(model["node_repl_disabled"], false);
        assert_eq!(model["default_reasoning_level"], Value::Null);
        assert!(reasoning_efforts(model).is_empty());
        assert_eq!(
            model["model_messages"]["instructions_template"],
            sources.fallback["base_instructions"]
        );
        assert_eq!(model["default_service_tier"], Value::Null);
        assert_eq!(model["additional_speed_tiers"], serde_json::json!(["fast"]));
    }

    #[test]
    fn fallback_preserves_explicit_template_reasoning_and_structured_instructions() {
        let mut sources = test_sources();
        sources.fallback.insert(
            "model_messages".to_string(),
            serde_json::json!({
                "instructions_template": "Custom {{ personality }} instructions",
                "instructions_variables": {"personality_default": "pragmatic"},
                "tools": {"custom": "Keep this"}
            }),
        );
        sources.fallback.insert(
            "default_reasoning_level".to_string(),
            serde_json::json!("low"),
        );
        sources.fallback.insert(
            "supported_reasoning_levels".to_string(),
            serde_json::json!([{"effort": "low", "description": "Low"}]),
        );
        sources.fallback.insert(
            "supports_image_detail_original".to_string(),
            Value::Bool(true),
        );
        let runtime = runtime(serde_json::json!({"models":[{
            "id":"C",
            "default_reasoning_level":"high",
            "model_messages":{"instructions_template":"Untrusted instructions"}
        }]}));
        let catalog = prepare_catalog_with_sources(&runtime, &sources).unwrap();
        let model = &output_models(&catalog)[0];

        assert_eq!(model["default_reasoning_level"], "low");
        assert_eq!(reasoning_efforts(model), ["low"]);
        assert_eq!(model["supports_image_detail_original"], true);
        for field in ["instructions_template", "instructions_variables", "tools"] {
            assert_eq!(
                model["model_messages"][field],
                sources.fallback["model_messages"][field]
            );
        }
    }

    #[test]
    fn fallback_display_name_matches_requested_model_slug() {
        let runtime = runtime(serde_json::json!({"models":[{
            "id":"gpt-5.6-sol-fast",
            "display_name":"gpt-5.6-sol"
        }]}));
        let catalog = prepare_catalog_with_sources(&runtime, &test_sources()).unwrap();
        let model = &output_models(&catalog)[0];

        assert_eq!(model["slug"], "gpt-5.6-sol-fast");
        assert_eq!(model["display_name"], "gpt-5.6-sol-fast");
        assert_eq!(catalog.models[0].name, "gpt-5.6-sol-fast");
        assert_eq!(catalog.models[0].alias, None);
    }

    #[test]
    fn fallback_does_not_invent_reasoning_capabilities_from_runtime_metadata() {
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
        assert_eq!(model["default_reasoning_level"], Value::Null);
        assert!(reasoning_efforts(model).is_empty());
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
