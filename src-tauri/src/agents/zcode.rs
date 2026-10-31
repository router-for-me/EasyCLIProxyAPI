
pub(crate) fn infer_zcode_model_knowledge(model_id: &str) -> (Option<u64>, Option<u64>, bool, bool, Vec<String>) {
    let lower = model_id.to_ascii_lowercase();

    // 1. Gemini: 1M context, 128K output, vision, pdf
    if lower.contains("gemini") {
        return (Some(1_048_576), Some(128_000), true, true, vec!["disabled".into(), "enabled".into(), "high".into()]);
    }

    // 2. GLM 5.x / 4.x
    if lower.contains("glm-5") || lower.contains("xopglm5") {
        return (Some(1_000_000), Some(128_000), true, false, vec!["disabled".into(), "enabled".into(), "low".into(), "medium".into(), "high".into(), "max".into()]);
    }
    if lower.contains("glm-4-flash") {
        return (Some(128_000), Some(16_384), true, false, vec!["disabled".into()]);
    }
    if lower.contains("glm-4") {
        return (Some(200_000), Some(131_072), true, false, vec!["disabled".into()]);
    }

    // 3. Kimi / Moonshot
    if lower.contains("kimi-k3") || lower.contains("k3-1") {
        return (Some(1_048_576), Some(131_072), true, false, vec!["disabled".into(), "enabled".into(), "low".into(), "medium".into(), "high".into(), "max".into()]);
    }
    if lower.contains("kimi-k2") {
        return (Some(262_144), Some(98_304), true, false, vec!["disabled".into()]);
    }
    if lower.contains("moonshot") {
        return (Some(131_072), Some(32_000), true, false, vec!["disabled".into()]);
    }

    // 4. Qwen
    if lower.contains("qwen3.8") || lower.contains("qwen3.7") {
        return (Some(1_000_000), Some(131_072), true, false, vec!["disabled".into(), "enabled".into(), "low".into(), "medium".into(), "high".into()]);
    }
    if lower.contains("qwen3") {
        return (Some(262_144), Some(65_536), true, false, vec!["disabled".into(), "enabled".into()]);
    }
    if lower.contains("qwen") {
        return (Some(131_072), Some(32_768), true, false, vec!["disabled".into()]);
    }

    // 5. DeepSeek
    if lower.contains("deepseek-v4") || lower.contains("xopdeepseekv4") {
        return (Some(1_000_000), Some(384_000), true, false, vec!["disabled".into(), "enabled".into(), "low".into(), "medium".into(), "high".into()]);
    }
    if lower.contains("deepseek") {
        return (Some(128_000), Some(64_000), true, false, vec!["disabled".into(), "enabled".into(), "low".into(), "high".into()]);
    }

    // 6. Step
    if lower.contains("step-5") || lower.contains("step-3.7") {
        return (Some(1_000_000), Some(128_000), true, false, vec!["disabled".into(), "enabled".into(), "low".into(), "medium".into(), "high".into(), "max".into()]);
    }
    if lower.contains("step") {
        return (Some(128_000), Some(64_000), true, false, vec!["disabled".into()]);
    }

    // 7. Spark (Spark X2.6 / 4.0 Ultra supports 1M context)
    if lower.contains("spark") {
        return (Some(1_000_000), Some(128_000), true, false, vec!["disabled".into(), "enabled".into()]);
    }

    // 8. MiniMax
    if lower.contains("minimax-m3") || lower.contains("minimax-3") {
        return (Some(1_000_000), Some(128_000), true, false, vec!["disabled".into(), "enabled".into(), "low".into(), "medium".into(), "high".into()]);
    }
    if lower.contains("minimax") {
        return (Some(204_800), Some(32_000), true, false, vec!["disabled".into()]);
    }

    // 9. Claude
    if lower.contains("claude-3") {
        return (Some(200_000), Some(64_000), true, true, vec!["disabled".into(), "enabled".into(), "low".into(), "medium".into(), "high".into()]);
    }

    // 10. OpenAI / GPT
    if lower.contains("o1") || lower.contains("o3") {
        return (Some(200_000), Some(64_000), true, false, vec!["low".into(), "medium".into(), "high".into()]);
    }
    if lower.contains("gpt-4") || lower.contains("gpt-5") {
        return (Some(128_000), Some(16_384), true, false, vec!["disabled".into()]);
    }

    (Some(128_000), Some(32_000), true, false, vec!["disabled".into()])
}

use std::fs;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use super::*;
use crate::GuiConfigState;

pub(crate) const ZCODE_CPA_REASONING_MAP: &str = "reasoningLevel == \"none\" ? {\"thinking\": {\"type\": \"disabled\"}} : {\"thinking\": {\"type\": \"adaptive\"}, \"output_config\": {\"effort\": reasoningLevel}}";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ZCodeModelConfig {
    pub context_window: Option<u64>,
    pub max_output_tokens: Option<u64>,
    pub supports_image: bool,
    pub supports_pdf: bool,
    pub supports_video: bool,
    pub supports_json_schema_output: bool,
    pub supports_native_web_search: bool,
    pub supports_mid_conversation_system: bool,
    pub reasoning_levels: Vec<String>,
    pub reasoning_map: Option<String>,
    pub is_manual: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ZCodeCatalogEditorModel {
    pub id: String,
    pub enabled: bool,
    pub configuration: ZCodeModelConfig,
    pub defaults: ZCodeModelConfig,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ZCodeCatalogEditorSnapshot {
    pub models: Vec<ZCodeCatalogEditorModel>,
    pub model_order: Vec<String>,
    pub default_model: Option<String>,
    pub configured: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ZCodeCatalogEditorSaveRequest {
    pub models: Vec<ZCodeCatalogEditorModel>,
    pub model_order: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ZCodeSubagentItem {
    pub name: String,
    pub description: String,
    pub file_path: String,
    pub model: Option<String>,
    pub thought_level: Option<String>,
    pub tools: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ZCodeSubagentConfigSnapshot {
    pub default_subagent_model: Option<String>,
    pub default_thought_level: Option<String>,
    pub subagents: Vec<ZCodeSubagentItem>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ZCodeSubagentConfigSaveRequest {
    pub default_subagent_model: Option<String>,
    pub default_thought_level: Option<String>,
    pub subagents: Vec<ZCodeSubagentItem>,
}

fn parse_zcode_rule_properties(rule: &Value) -> (Option<u64>, Option<u64>, bool, bool, bool, bool, bool, bool) {
    let properties = rule.get("config").and_then(|c| c.get("properties"));
    let context_window = properties.and_then(|p| p.get("contextWindow")).and_then(Value::as_u64);
    let max_output_tokens = properties.and_then(|p| p.get("maxOutputTokens"))
        .and_then(|m| m.get("max")).and_then(Value::as_u64)
        .or_else(|| properties.and_then(|p| p.get("maxOutputTokens")).and_then(Value::as_u64));
    let input_format = properties.and_then(|p| p.get("inputFormat"));
    let supports_image = input_format.and_then(|f| f.get("supportsImage")).and_then(Value::as_bool).unwrap_or(true);
    let supports_pdf = input_format.and_then(|f| f.get("supportsPdf")).and_then(Value::as_bool).unwrap_or(false);
    let supports_video = input_format.and_then(|f| f.get("supportsVideo")).and_then(Value::as_bool).unwrap_or(false);
    let supports_json = properties.and_then(|p| p.get("supportsJsonSchemaOutput")).and_then(Value::as_bool).unwrap_or(true);
    let supports_search = properties.and_then(|p| p.get("supportsNativeWebSearch")).and_then(Value::as_bool).unwrap_or(true);
    let supports_system = properties.and_then(|p| p.get("supportsMidConversationSystem")).and_then(Value::as_bool).unwrap_or(true);
    (context_window, max_output_tokens, supports_image, supports_pdf, supports_video, supports_json, supports_search, supports_system)
}

fn parse_zcode_rule_reasoning(rule: &Value) -> (Vec<String>, Option<String>) {
    let option_specs = rule.get("config").and_then(|c| c.get("optionSpecs"));
    let reasoning = option_specs.and_then(|o| o.get("reasoningLevel"));
    let values = reasoning.and_then(|r| r.get("values")).and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(Value::as_str).map(String::from).collect())
        .unwrap_or_default();
    let map = reasoning.and_then(|r| r.get("map")).and_then(Value::as_str).map(String::from);
    (values, map)
}

fn build_zcode_rule_object(model_id: &str, config: &ZCodeModelConfig) -> Value {
    let mut properties = Map::new();
    if let Some(cw) = config.context_window {
        properties.insert("contextWindow".into(), serde_json::json!(cw));
    }
    properties.insert("inputFormat".into(), serde_json::json!({
        "supportsImage": config.supports_image,
        "supportsPdf": config.supports_pdf,
        "supportsVideo": config.supports_video,
    }));
    properties.insert("supportsJsonSchemaOutput".into(), serde_json::json!(config.supports_json_schema_output));
    properties.insert("supportsNativeWebSearch".into(), serde_json::json!(config.supports_native_web_search));
    properties.insert("supportsMidConversationSystem".into(), serde_json::json!(config.supports_mid_conversation_system));

    let mut option_specs = Map::new();
    let mot = config.max_output_tokens.unwrap_or(128_000);
    option_specs.insert("maxOutputTokens".into(), serde_json::json!({ "max": mot }));
    if !config.reasoning_levels.is_empty() {
        let mut rl = Map::new();
        rl.insert("values".into(), serde_json::json!(config.reasoning_levels));
        if let Some(ref m) = config.reasoning_map {
            rl.insert("map".into(), serde_json::json!(m));
        } else {
            rl.insert("map".into(), serde_json::json!(ZCODE_CPA_REASONING_MAP));
        }
        option_specs.insert("reasoningLevel".into(), Value::Object(rl));
    }

    let mut cfg = Map::new();
    cfg.insert("properties".into(), Value::Object(properties));
    if !option_specs.is_empty() {
        cfg.insert("optionSpecs".into(), Value::Object(option_specs));
    }
    if config.is_manual {
        cfg.insert("enabled".into(), serde_json::json!(true));
    }

    serde_json::json!({
        "providerId": MANAGED_AGENT_PROVIDER_ID,
        "modelId": model_id,
        "config": cfg,
    })
}

pub(crate) fn zcode_editor_snapshot(
    home: &Path,
    available_models: &[AgentModelOption],
) -> Result<ZCodeCatalogEditorSnapshot, String> {
    let config_dir = zcode_config_directory(home);
    let path = config_dir.join(ZCODE_PROVIDER_CONFIG_FILE);

    let (root_opt, configured) = if path.is_file() {
        let text = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read ZCode provider configuration: {e}"))?;
        let root = parse_agent_json_object(Some(&text), "ZCode provider_config.json")?;
        let is_configured = root.get("config")
            .and_then(|c| c.get("providerConfigRules"))
            .and_then(|r| r.get("providerRules"))
            .and_then(Value::as_array)
            .map(|arr| arr.iter().any(|p| p.get("providerId").and_then(Value::as_str) == Some(MANAGED_AGENT_PROVIDER_ID)))
            .unwrap_or(false);
        (Some(root), is_configured)
    } else {
        (None, false)
    };

    let mut personal_model_ids: Vec<String> = Vec::new();
    let mut model_order: Vec<String> = Vec::new();
    let mut default_model: Option<String> = None;
    let mut manual_rules: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    let mut provider_rules: std::collections::HashMap<String, Value> = std::collections::HashMap::new();

    if let Some(ref root) = root_opt {
        if let Some(cfg) = root.get("config") {
            if let Some(dm) = cfg.get("defaultModelSelection").and_then(|d| d.get("modelId")).and_then(Value::as_str) {
                default_model = Some(dm.to_string());
            }
            if let Some(rules) = cfg.get("providerConfigRules").and_then(|p| p.get("providerRules")).and_then(Value::as_array) {
                if let Some(managed) = rules.iter().find(|p| p.get("providerId").and_then(Value::as_str) == Some(MANAGED_AGENT_PROVIDER_ID)) {
                    if let Some(pcfg) = managed.get("config") {
                        if let Some(pids) = pcfg.get("personalModelIds").and_then(Value::as_array) {
                            personal_model_ids = pids.iter().filter_map(Value::as_str).map(String::from).collect();
                        }
                        if let Some(morder) = pcfg.get("modelOrder").and_then(Value::as_array) {
                            model_order = morder.iter().filter_map(Value::as_str).map(String::from).collect();
                        }
                    }
                }
            }
            if let Some(mrules) = cfg.get("modelConfigRules") {
                if let Some(arr) = mrules.get("manualProviderModelRules").and_then(Value::as_array) {
                    for r in arr {
                        if r.get("providerId").and_then(Value::as_str) == Some(MANAGED_AGENT_PROVIDER_ID) {
                            if let Some(mid) = r.get("modelId").and_then(Value::as_str) {
                                manual_rules.insert(mid.to_string(), r.clone());
                            }
                        }
                    }
                }
                if let Some(arr) = mrules.get("providerModelRules").and_then(Value::as_array) {
                    for r in arr {
                        if r.get("providerId").and_then(Value::as_str) == Some(MANAGED_AGENT_PROVIDER_ID) {
                            if let Some(mid) = r.get("modelId").and_then(Value::as_str) {
                                provider_rules.insert(mid.to_string(), r.clone());
                            }
                        }
                    }
                }
            }
        }
    }

    let mut editor_models = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();

    for option in available_models {
        seen_ids.insert(option.name.clone());
        let (inferred_cw, inferred_mot, inferred_img, inferred_pdf, inferred_rl) = infer_zcode_model_knowledge(&option.name);

        let default_config = ZCodeModelConfig {
            context_window: option.context_window.or(inferred_cw),
            max_output_tokens: inferred_mot,
            supports_image: inferred_img,
            supports_pdf: inferred_pdf,
            supports_video: false,
            supports_json_schema_output: true,
            supports_native_web_search: true,
            supports_mid_conversation_system: true,
            reasoning_levels: if option.reasoning_levels.is_empty() { inferred_rl } else { option.reasoning_levels.clone() },
            reasoning_map: Some(ZCODE_CPA_REASONING_MAP.to_string()),
            is_manual: false,
        };

        let configuration = if let Some(manual_rule) = manual_rules.get(&option.name) {
            let (cw, mot, img, pdf, vid, json_out, search, sys) = parse_zcode_rule_properties(manual_rule);
            let (rl, map) = parse_zcode_rule_reasoning(manual_rule);
            let effective_cw = if cw == Some(500000) { default_config.context_window } else { cw.or(default_config.context_window) };
            ZCodeModelConfig {
                context_window: effective_cw,
                max_output_tokens: mot.or(default_config.max_output_tokens),
                supports_image: img,
                supports_pdf: pdf,
                supports_video: vid,
                supports_json_schema_output: json_out,
                supports_native_web_search: search,
                supports_mid_conversation_system: sys,
                reasoning_levels: if rl.is_empty() { default_config.reasoning_levels.clone() } else { rl },
                reasoning_map: map.or_else(|| default_config.reasoning_map.clone()),
                is_manual: true,
            }
        } else if let Some(prov_rule) = provider_rules.get(&option.name) {
            let (cw, mot, img, pdf, vid, json_out, search, sys) = parse_zcode_rule_properties(prov_rule);
            let (rl, map) = parse_zcode_rule_reasoning(prov_rule);
            let effective_cw = if cw == Some(500000) { default_config.context_window } else { cw.or(default_config.context_window) };
            ZCodeModelConfig {
                context_window: effective_cw,
                max_output_tokens: mot.or(default_config.max_output_tokens),
                supports_image: img,
                supports_pdf: pdf,
                supports_video: vid,
                supports_json_schema_output: json_out,
                supports_native_web_search: search,
                supports_mid_conversation_system: sys,
                reasoning_levels: if rl.is_empty() { default_config.reasoning_levels.clone() } else { rl },
                reasoning_map: map.or_else(|| default_config.reasoning_map.clone()),
                is_manual: false,
            }
        } else {
            default_config.clone()
        };

        let enabled = if personal_model_ids.is_empty() {
            true
        } else {
            personal_model_ids.contains(&option.name)
        };

        editor_models.push(ZCodeCatalogEditorModel {
            id: option.name.clone(),
            enabled,
            configuration,
            defaults: default_config,
        });
    }

    for (mid, manual_rule) in &manual_rules {
        if !seen_ids.contains(mid) {
            let (cw, mot, img, pdf, vid, json_out, search, sys) = parse_zcode_rule_properties(manual_rule);
            let (rl, map) = parse_zcode_rule_reasoning(manual_rule);
            let cfg = ZCodeModelConfig {
                context_window: cw,
                max_output_tokens: mot,
                supports_image: img,
                supports_pdf: pdf,
                supports_video: vid,
                supports_json_schema_output: json_out,
                supports_native_web_search: search,
                supports_mid_conversation_system: sys,
                reasoning_levels: rl.clone(),
                reasoning_map: map.clone(),
                is_manual: true,
            };
            let enabled = personal_model_ids.contains(mid);
            editor_models.push(ZCodeCatalogEditorModel {
                id: mid.clone(),
                enabled,
                configuration: cfg.clone(),
                defaults: cfg,
            });
        }
    }

    if !model_order.is_empty() {
        let order_map: std::collections::HashMap<&str, usize> = model_order
            .iter()
            .enumerate()
            .map(|(i, name)| (name.as_str(), i))
            .collect();
        editor_models.sort_by_key(|m| order_map.get(m.id.as_str()).copied().unwrap_or(usize::MAX));
    }

    let final_model_order = if model_order.is_empty() {
        editor_models.iter().map(|m| m.id.clone()).collect()
    } else {
        let mut order = model_order;
        for m in &editor_models {
            if !order.contains(&m.id) {
                order.push(m.id.clone());
            }
        }
        order
    };

    Ok(ZCodeCatalogEditorSnapshot {
        models: editor_models,
        model_order: final_model_order,
        default_model,
        configured,
    })
}

pub(crate) fn save_zcode_editor(
    home: &Path,
    available_models: &[AgentModelOption],
    request: ZCodeCatalogEditorSaveRequest,
) -> Result<ZCodeCatalogEditorSnapshot, String> {
    let config_dir = zcode_config_directory(home);
    fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create ZCode config directory: {e}"))?;
    let path = config_dir.join(ZCODE_PROVIDER_CONFIG_FILE);

    let mut root = if path.is_file() {
        let text = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read ZCode provider configuration: {e}"))?;
        parse_agent_json_object(Some(&text), "ZCode provider_config.json")?
    } else {
        let mut base = Map::new();
        base.insert("schemaVersion".into(), serde_json::json!(1));
        base.insert("config".into(), serde_json::json!({
            "providerOrder": [MANAGED_AGENT_PROVIDER_ID],
            "providerConfigRules": {
                "providerRules": []
            },
            "modelConfigRules": {
                "providerModelRules": [],
                "manualProviderModelRules": []
            }
        }));
        base
    };

    let config = ensure_json_object_entry(&mut root, "config");
    let provider_rules_sec = ensure_json_object_entry(config, "providerConfigRules");
    let rules = provider_rules_sec
        .entry("providerRules")
        .or_insert_with(|| serde_json::json!([]))
        .as_array_mut()
        .ok_or("ZCode providerRules must be an array")?;

    let managed_index = rules.iter().position(|r| r.get("providerId").and_then(Value::as_str) == Some(MANAGED_AGENT_PROVIDER_ID));
    let mut managed = managed_index.and_then(|idx| rules.get(idx)).cloned().unwrap_or_else(|| serde_json::json!({
        "providerId": MANAGED_AGENT_PROVIDER_ID,
        "providerName": "EasyCLIProxyAPI",
        "enabled": true,
        "config": {
            "group": "standard-personal",
            "access": { "type": "api-key", "apiKey": "" },
            "api": { "type": "anthropic-messages", "baseUrl": "" }
        }
    }));
    let managed_obj = managed.as_object_mut().ok_or("ZCode managed provider must be an object")?;
    let provider_cfg = ensure_json_object_entry(managed_obj, "config");

    let enabled_ids: Vec<Value> = request.models.iter().filter(|m| m.enabled).map(|m| serde_json::json!(m.id)).collect();
    provider_cfg.insert("personalModelIds".into(), Value::Array(enabled_ids));
    let order_ids: Vec<Value> = request.model_order.iter().map(|id| serde_json::json!(id)).collect();
    provider_cfg.insert("modelOrder".into(), Value::Array(order_ids));

    if let Some(idx) = managed_index {
        rules[idx] = managed;
    } else {
        rules.push(managed);
    }

    let mut new_provider_rules = Vec::new();
    let mut new_manual_rules = Vec::new();
    for model in &request.models {
        let rule_obj = build_zcode_rule_object(&model.id, &model.configuration);
        if model.configuration.is_manual {
            new_manual_rules.push(rule_obj);
        } else {
            new_provider_rules.push(rule_obj);
        }
    }

    let model_rules_sec = ensure_json_object_entry(config, "modelConfigRules");
    {
        let provider_model_rules = model_rules_sec
            .entry("providerModelRules")
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut()
            .ok_or("providerModelRules must be an array")?;
        provider_model_rules.retain(|r| r.get("providerId").and_then(Value::as_str) != Some(MANAGED_AGENT_PROVIDER_ID));
        provider_model_rules.extend(new_provider_rules);
    }
    {
        let manual_model_rules = model_rules_sec
            .entry("manualProviderModelRules")
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut()
            .ok_or("manualProviderModelRules must be an array")?;
        manual_model_rules.retain(|r| r.get("providerId").and_then(Value::as_str) != Some(MANAGED_AGENT_PROVIDER_ID));
        manual_model_rules.extend(new_manual_rules);
    }

    let rendered = render_agent_json(root, "ZCode provider configuration")?;
    fs::write(&path, rendered)
        .map_err(|e| format!("Failed to save ZCode provider configuration: {e}"))?;

    zcode_editor_snapshot(home, available_models)
}

fn parse_subagent_markdown(file_path: &Path) -> Option<ZCodeSubagentItem> {
    let content = fs::read_to_string(file_path).ok()?;
    if !content.starts_with("---\n") && !content.starts_with("---\r\n") {
        return None;
    }
    let rest = &content[4..];
    let end_idx = rest.find("\n---").or_else(|| rest.find("\r\n---"))?;
    let frontmatter = &rest[..end_idx];

    let mut name = file_path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
    let mut description = String::new();
    let mut model: Option<String> = None;
    let mut thought_level: Option<String> = None;
    let mut tools: Vec<String> = Vec::new();

    for line in frontmatter.lines() {
        let trimmed = line.trim();
        if let Some(val) = trimmed.strip_prefix("name:") {
            let v = val.trim().trim_matches('"').trim_matches('\'');
            if !v.is_empty() { name = v.to_string(); }
        } else if let Some(val) = trimmed.strip_prefix("description:") {
            let v = val.trim().trim_matches('"').trim_matches('\'');
            description = v.to_string();
        } else if let Some(val) = trimmed.strip_prefix("model:") {
            let v = val.trim().trim_matches('"').trim_matches('\'');
            if !v.is_empty() && v != "inherit" { model = Some(v.to_string()); }
        } else if let Some(val) = trimmed.strip_prefix("thoughtLevel:") {
            let v = val.trim().trim_matches('"').trim_matches('\'');
            if !v.is_empty() && v != "inherit" { thought_level = Some(v.to_string()); }
        } else if let Some(val) = trimmed.strip_prefix("tools:") {
            let v = val.trim().trim_matches('[').trim_matches(']');
            tools = v.split(',').map(|s| s.trim().trim_matches('"').trim_matches('\'').to_string()).filter(|s| !s.is_empty()).collect();
        }
    }

    Some(ZCodeSubagentItem {
        name,
        description,
        file_path: file_path.to_string_lossy().to_string(),
        model,
        thought_level,
        tools,
    })
}

pub(crate) fn zcode_subagent_snapshot(home: &Path) -> Result<ZCodeSubagentConfigSnapshot, String> {
    let config_dir = zcode_config_directory(home);
    let settings_path = config_dir.join("setting.json");

    let mut default_subagent_model = None;
    let mut default_thought_level = None;

    if settings_path.is_file() {
        if let Ok(content) = fs::read_to_string(&settings_path) {
            if let Ok(val) = serde_json::from_str::<Value>(&content) {
                if let Some(m) = val.get("defaultSubagentModel").and_then(Value::as_str) {
                    if !m.is_empty() { default_subagent_model = Some(m.to_string()); }
                }
                if let Some(tl) = val.get("defaultThoughtLevel").and_then(Value::as_str) {
                    if !tl.is_empty() { default_thought_level = Some(tl.to_string()); }
                }
            }
        }
    }

    let mut subagents = Vec::new();
    let mut seen_paths = std::collections::HashSet::new();

    let mut candidate_dirs = Vec::new();
    if let Some(base) = zcode_data_base_dir(home) {
        candidate_dirs.push(base.join(".zcode/agents"));
        candidate_dirs.push(base.join(".zcode/cli/plugins/cache"));
        candidate_dirs.push(base.join(".zcode/skills"));
    }
    candidate_dirs.push(home.join(".zcode/agents"));
    candidate_dirs.push(home.join(".zcode/cli/plugins/cache"));
    candidate_dirs.push(home.join(".zcode/skills"));

    for dir in candidate_dirs {
        if !dir.is_dir() { continue; }
        if dir.ends_with("cache") || dir.ends_with("skills") {
            collect_subagents_from_cache(&dir, &mut subagents, &mut seen_paths);
        } else {
            if let Ok(entries) = fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.extension().and_then(|s| s.to_str()) == Some("md") {
                        if seen_paths.insert(p.clone()) {
                            if let Some(item) = parse_subagent_markdown(&p) {
                                subagents.push(item);
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(ZCodeSubagentConfigSnapshot {
        default_subagent_model,
        default_thought_level,
        subagents,
    })
}

fn collect_subagents_from_cache(
    dir: &Path,
    subagents: &mut Vec<ZCodeSubagentItem>,
    seen_paths: &mut std::collections::HashSet<PathBuf>,
) {
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        if let Ok(entries) = fs::read_dir(&current) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    if p.file_name().and_then(|s| s.to_str()) == Some("agents") {
                        if let Ok(agent_entries) = fs::read_dir(&p) {
                            for agent_entry in agent_entries.flatten() {
                                let ap = agent_entry.path();
                                if ap.extension().and_then(|s| s.to_str()) == Some("md") {
                                    if seen_paths.insert(ap.clone()) {
                                        if let Some(item) = parse_subagent_markdown(&ap) {
                                            subagents.push(item);
                                        }
                                    }
                                }
                            }
                        }
                    } else {
                        stack.push(p);
                    }
                }
            }
        }
    }
}

pub(crate) fn save_zcode_subagent_config_inner(
    home: &Path,
    request: ZCodeSubagentConfigSaveRequest,
) -> Result<ZCodeSubagentConfigSnapshot, String> {
    let config_dir = zcode_config_directory(home);
    let settings_path = config_dir.join("setting.json");

    if settings_path.is_file() {
        if let Ok(content) = fs::read_to_string(&settings_path) {
            if let Ok(mut val) = serde_json::from_str::<Value>(&content) {
                if let Some(obj) = val.as_object_mut() {
                    if let Some(ref m) = request.default_subagent_model {
                        obj.insert("defaultSubagentModel".into(), serde_json::json!(m));
                    } else {
                        obj.remove("defaultSubagentModel");
                    }
                    if let Some(ref tl) = request.default_thought_level {
                        obj.insert("defaultThoughtLevel".into(), serde_json::json!(tl));
                    } else {
                        obj.remove("defaultThoughtLevel");
                    }
                    if let Ok(rendered) = serde_json::to_string_pretty(&val) {
                        let _ = fs::write(&settings_path, rendered);
                    }
                }
            }
        }
    }

    for sub in &request.subagents {
        let p = Path::new(&sub.file_path);
        if !p.is_file() { continue; }
        if let Ok(content) = fs::read_to_string(p) {
            if let Some(updated) = update_subagent_frontmatter(&content, sub.model.as_deref(), sub.thought_level.as_deref()) {
                let _ = fs::write(p, updated);
            }
        }
    }

    zcode_subagent_snapshot(home)
}

fn update_subagent_frontmatter(content: &str, model: Option<&str>, thought_level: Option<&str>) -> Option<String> {
    if !content.starts_with("---\n") && !content.starts_with("---\r\n") {
        return None;
    }
    let rest = &content[4..];
    let end_idx = rest.find("\n---").or_else(|| rest.find("\r\n---"))?;
    let frontmatter = &rest[..end_idx];
    let body = &rest[end_idx..];

    let mut lines: Vec<String> = frontmatter.lines().map(String::from).collect();
    let mut has_model = false;
    let mut has_thought = false;

    for line in lines.iter_mut() {
        let trimmed = line.trim();
        if trimmed.starts_with("model:") {
            has_model = true;
            if let Some(m) = model.filter(|s| !s.trim().is_empty()) {
                *line = format!("model: {m}");
            } else {
                *line = "model: inherit".into();
            }
        } else if trimmed.starts_with("thoughtLevel:") {
            has_thought = true;
            if let Some(tl) = thought_level.filter(|s| !s.trim().is_empty()) {
                *line = format!("thoughtLevel: {tl}");
            } else {
                *line = "thoughtLevel: inherit".into();
            }
        }
    }

    if !has_model {
        if let Some(m) = model.filter(|s| !s.trim().is_empty()) {
            lines.push(format!("model: {m}"));
        }
    }
    if !has_thought {
        if let Some(tl) = thought_level.filter(|s| !s.trim().is_empty()) {
            lines.push(format!("thoughtLevel: {tl}"));
        }
    }

    Some(format!("---\n{}{}", lines.join("\n"), body))
}

#[tauri::command]
pub(crate) async fn get_zcode_model_catalog_editor(
    app: tauri::AppHandle,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<ZCodeCatalogEditorSnapshot, String> {
    let config = gui_config_state.snapshot()?;
    let models = fetch_prepared_agent_models(AgentClient::ZCode, &config).await?;
    let home = app.path().home_dir().map_err(|_| "Failed to get user directory")?;
    let _guard = crate::AGENT_CONFIG_FILE_LOCK
        .lock()
        .map_err(|_| "Agent configuration file lock is poisoned")?;
    zcode_editor_snapshot(&home, &models.models)
}

#[tauri::command]
pub(crate) async fn save_zcode_model_catalog_editor(
    app: tauri::AppHandle,
    gui_config_state: tauri::State<'_, GuiConfigState>,
    request: ZCodeCatalogEditorSaveRequest,
) -> Result<ZCodeCatalogEditorSnapshot, String> {
    let config = gui_config_state.snapshot()?;
    let models = fetch_prepared_agent_models(AgentClient::ZCode, &config).await?;
    let home = app.path().home_dir().map_err(|_| "Failed to get user directory")?;
    let _guard = crate::AGENT_CONFIG_FILE_LOCK
        .lock()
        .map_err(|_| "Agent configuration file lock is poisoned")?;
    save_zcode_editor(&home, &models.models, request)
}

#[tauri::command]
pub(crate) async fn get_zcode_subagent_config(
    app: tauri::AppHandle,
) -> Result<ZCodeSubagentConfigSnapshot, String> {
    let home = app.path().home_dir().map_err(|_| "Failed to get user directory")?;
    let _guard = crate::AGENT_CONFIG_FILE_LOCK
        .lock()
        .map_err(|_| "Agent configuration file lock is poisoned")?;
    zcode_subagent_snapshot(&home)
}

#[tauri::command]
pub(crate) async fn save_zcode_subagent_config(
    app: tauri::AppHandle,
    request: ZCodeSubagentConfigSaveRequest,
) -> Result<ZCodeSubagentConfigSnapshot, String> {
    let home = app.path().home_dir().map_err(|_| "Failed to get user directory")?;
    let _guard = crate::AGENT_CONFIG_FILE_LOCK
        .lock()
        .map_err(|_| "Agent configuration file lock is poisoned")?;
    save_zcode_subagent_config_inner(&home, request)
}
