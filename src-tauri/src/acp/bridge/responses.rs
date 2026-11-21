//! Native HTTP Responses codec. The loopback bearer check happens before decoding.
use super::*;

pub(super) fn previous(value: &Value) -> Result<Option<&str>, String> {
    match value.get("previous_response_id") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(id)) if !id.is_empty() => Ok(Some(id)),
        _ => Err("previous_response_id must be a nonempty string".into()),
    }
}

fn identifier(v: &Value) -> Result<&str, String> {
    v.as_str()
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 64
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
        })
        .ok_or_else(|| "Invalid Responses tool name or namespace".into())
}

fn internal_name(namespace: &str, name: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("{namespace}\0{name}"));
    format!(
        "ns_{}_{:x}",
        &name[..name.len().min(20)],
        u128::from_be_bytes(digest[..16].try_into().unwrap())
    )
}

fn function(value: &Value, namespace: Option<&str>) -> Result<Value, String> {
    let mut def = value
        .as_object()
        .cloned()
        .ok_or("Invalid Responses function")?;
    if def.remove("type").as_ref() != Some(&json!("function")) {
        return Err(
            "ACP Responses supports only function declarations within a tool namespace".into(),
        );
    }
    if def
        .keys()
        .any(|key| !["name", "description", "parameters", "strict"].contains(&key.as_str()))
    {
        return Err("Unsupported Responses function field".into());
    }
    def.retain(|_, value| !value.is_null());
    let name = identifier(def.get("name").unwrap_or(&Value::Null))?.to_owned();
    if def.get("strict").is_some_and(|v| !v.is_boolean())
        || def.get("description").is_some_and(|v| !v.is_string())
    {
        return Err("Invalid Responses function description or strict setting".into());
    }
    if let Some(namespace) = namespace {
        let description = def
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default();
        def.insert(
            "description".into(),
            json!(format!("{namespace}.{name}: {description}")),
        );
        def.insert("wire_name".into(), json!(name));
        def.insert("wire_namespace".into(), json!(namespace));
        def.insert("name".into(), json!(internal_name(namespace, &name)));
    }
    Ok(json!({"type":"function","function":def}))
}

fn tools(value: &Value) -> Result<Vec<Value>, String> {
    let array = value.as_array().ok_or("tools must be an array")?;
    let mut tools = Vec::new();
    let mut namespaces = std::collections::BTreeSet::new();
    let mut names = std::collections::BTreeSet::new();
    for item in array {
        match item["type"].as_str() {
            Some("function") => tools.push(function(item, None)?),
            Some("namespace") => {
                let ns = identifier(&item["name"])?;
                if !namespaces.insert(ns) {
                    return Err("Duplicate Responses tool namespace".into());
                }
                let object = item.as_object().ok_or("Invalid tool namespace")?;
                if object
                    .keys()
                    .any(|key| !["type", "name", "description", "tools"].contains(&key.as_str()))
                    || object
                        .get("description")
                        .is_some_and(|v| !v.is_null() && !v.is_string())
                {
                    return Err("Unsupported Responses tool namespace field".into());
                }
                for tool in item["tools"]
                    .as_array()
                    .filter(|v| !v.is_empty())
                    .ok_or("Tool namespace requires a nonempty tools array")?
                {
                    tools.push(function(tool, Some(ns))?);
                }
            }
            _ => {
                return Err(
                    "ACP Responses supports function tools and namespaces of functions only".into(),
                )
            }
        }
    }
    if tools.len() > 128
        || tools
            .iter()
            .any(|tool| !names.insert(tool["function"]["name"].as_str().unwrap()))
    {
        return Err("Too many or colliding Responses function names".into());
    }
    Ok(tools)
}

pub(in crate::acp) fn label_calls(calls: &mut [Value], tools: &[Value]) {
    for call in calls {
        if let Some(tool) = tools
            .iter()
            .map(|t| &t["function"])
            .find(|t| t["name"] == call["function"]["name"] && t.get("wire_namespace").is_some())
        {
            call["function"]["wire_name"] = tool["wire_name"].clone();
            call["function"]["wire_namespace"] = tool["wire_namespace"].clone();
        }
    }
}

#[cfg(test)]
pub(super) fn parse(
    value: &Value,
    models: &[AcpModel],
    context: Option<&agent::Context>,
) -> Result<Completion, String> {
    parse_with_profile(value, models, context, PromptProfile::Append)
}

pub(super) fn parse_with_profile(
    value: &Value,
    models: &[AcpModel],
    context: Option<&agent::Context>,
    policy: PromptProfile,
) -> Result<Completion, String> {
    let mut chat = serde_json::Map::new();
    let mut messages = Vec::new();
    for (key, value) in value.as_object().ok_or("Request body must be an object")? {
        match key.as_str() {
            "model"
            | "stream"
            | "tool_choice"
            | "parallel_tool_calls"
            | "store"
            | "temperature"
            | "top_p"
            | "metadata"
            | "prompt_cache_key"
            | "safety_identifier" => {
                chat.insert(key.clone(), value.clone());
            }
            "max_output_tokens" => {
                chat.insert("max_completion_tokens".into(), value.clone());
            }
            "previous_response_id" | "input" | "instructions" => {}
            "background" if *value == false => {}
            "tools" => {
                chat.insert("tools".into(), json!(tools(value)?));
            }
            "client_metadata" => {
                if !value.as_object().is_some_and(|fields| {
                    fields.len() <= 32
                        && fields.iter().all(|(k, v)| {
                            k.len() <= 128 && v.as_str().is_some_and(|s| s.len() <= 8192)
                        })
                }) || value.to_string().len() > 32768
                {
                    return Err("client_metadata must be a bounded string map".into());
                }
            }
            "reasoning" if value.is_object() => {
                if value
                    .as_object()
                    .unwrap()
                    .keys()
                    .any(|key| key != "effort" && key != "summary")
                    || value
                        .get("summary")
                        .is_some_and(|v| !v.is_null() && v != "auto" && v != "none")
                {
                    return Err("ACP does not return reasoning summaries".into());
                }
                if let Some(effort) = value.get("effort").filter(|v| !v.is_null()) {
                    chat.insert("reasoning_effort".into(), effort.clone());
                }
            }
            "text" if value == &json!({"format":{"type":"text"}}) => {}
            "include"
                if value == &json!([]) || value == &json!(["reasoning.encrypted_content"]) => {}
            _ => return Err(format!("ACP Responses does not support parameter '{key}'")),
        }
    }
    let supplied = match value.get("instructions") {
        None => None,
        Some(Value::Null) => Some(""),
        Some(v) => Some(v.as_str().ok_or("instructions must be a string")?),
    };
    let (instructions, instructions_bytes) = if let Some(context) = context {
        let identity = &context.identity;
        if supplied
            .is_some_and(|text| identity.system.get(..identity.instructions_bytes) != Some(text))
        {
            return Err("Cannot change top-level instructions on a live ACP session; start a new response without previous_response_id".into());
        }
        (identity.system.as_str(), identity.instructions_bytes)
    } else {
        let text = supplied.unwrap_or_default();
        (text, text.len())
    };
    if !instructions.is_empty() {
        messages.push(json!({"role":"system","content":instructions}));
    }
    if let Some(context) = context {
        if !chat.contains_key("tools") {
            chat.insert("tools".into(), json!(context.identity.tools));
        }
        if let Some(pending) = &context.pending {
            messages.push(pending.clone());
        }
    }
    let input = match &value["input"] {
        Value::String(text) => vec![json!({"type":"message","role":"user","content":text})],
        Value::Array(items) => items.clone(),
        _ => return Err("input must be text or an array of items".into()),
    };
    let pending = context.is_some_and(|context| context.pending.is_some());
    for item in input {
        let kind = match item.get("type") {
            Some(Value::String(kind)) => kind.as_str(),
            None if item.is_object() => "message",
            _ => return Err("Invalid Responses input item".into()),
        };
        if context.is_some()
            && (if pending {
                kind != "function_call_output"
            } else {
                kind != "message" || item["role"] != "user"
            })
        {
            return Err("With previous_response_id, send only new user input or all pending function outputs; do not replay history".into());
        }
        match kind {
            "message" => {
                let role = item["role"]
                    .as_str()
                    .ok_or("Missing Responses message role")?;
                if !["user", "assistant", "system", "developer"].contains(&role) {
                    return Err("Unsupported Responses message role".into());
                }
                let content = if let Some(parts) = item["content"].as_array() {
                    let mut content = Vec::with_capacity(parts.len());
                    for part in parts {
                        content.push(match part["type"].as_str() {
                            Some("input_text" | "output_text") => json!({"type":"text","text":part["text"]}),
                            Some("input_image") => json!({"type":"image_url","image_url":{"url":part["image_url"],"detail":part["detail"]}}),
                            _ => return Err("ACP Responses accepts text and inline user images only".into()),
                        });
                    }
                    json!(content)
                } else {
                    item["content"].clone()
                };
                messages.push(json!({"role":role,"content":content}));
            }
            "function_call" => {
                let name = identifier(&item["name"])?;
                if item
                    .get("encrypted_function_args")
                    .is_some_and(|v| !v.is_null() && v != &json!([]))
                {
                    return Err("Encrypted function arguments are unsupported".into());
                }
                let mut function = json!({"name":name,"arguments":item["arguments"]});
                if let Some(ns) = item.get("namespace").filter(|v| !v.is_null()) {
                    let ns = identifier(ns)?;
                    function["name"] = json!(internal_name(ns, name));
                    function["wire_name"] = json!(name);
                    function["wire_namespace"] = json!(ns);
                }
                let call = json!({"id":item["call_id"],"type":"function","function":function});
                match messages.last_mut().filter(|m| m["role"] == "assistant") {
                    Some(last) => last
                        .as_object_mut()
                        .unwrap()
                        .entry("tool_calls")
                        .or_insert_with(|| json!([]))
                        .as_array_mut()
                        .unwrap()
                        .push(call),
                    None => messages
                        .push(json!({"role":"assistant","content":null,"tool_calls":[call]})),
                }
            }
            "function_call_output" => {
                let raw = &item["output"];
                let output = if raw.is_string() {
                    raw.clone()
                } else if let Some(parts) = raw.as_array() {
                    if parts
                        .iter()
                        .any(|part| part["type"] != "input_text" || !part["text"].is_string())
                    {
                        return Err("ACP function output supports text only".into());
                    }
                    json!(parts
                        .iter()
                        .map(|part| part["text"].as_str().unwrap())
                        .collect::<Vec<_>>()
                        .join(""))
                } else {
                    return Err("ACP function output must be text".into());
                };
                messages
                    .push(json!({"role":"tool","tool_call_id":item["call_id"],"content":output}));
            }
            _ => return Err(format!("Unsupported Responses input item '{kind}'")),
        }
    }
    chat.insert("messages".into(), json!(messages));
    let mut completion = super::parse_with_profile(&Value::Object(chat), models, policy)?;
    completion.instructions_bytes = instructions_bytes;
    Ok(completion)
}

pub(super) fn text_item(id: &str, text: Option<&str>) -> Value {
    json!({"type":"message","id":format!("msg_{id}"),"role":"assistant","status":if text.is_some(){"completed"}else{"in_progress"},"content":text.map(|text|vec![text_part(text)]).unwrap_or_default()})
}

pub(super) fn text_part(text: &str) -> Value {
    json!({"type":"output_text","text":text,"annotations":[],"logprobs":[]})
}

pub(super) fn output_items(id: &str, output: &Output) -> Vec<Value> {
    let mut items = Vec::new();
    if !output.text.is_empty() {
        items.push(text_item(id, Some(&output.text)));
    }
    for call in &output.calls {
        let function = &call["function"];
        let mut item = json!({"type":"function_call","id":format!("fc_{}",call["id"].as_str().unwrap_or_default()),"call_id":call["id"],"name":function["name"],"arguments":function["arguments"],"status":"completed"});
        if let Some(namespace) = function.get("wire_namespace") {
            item["namespace"] = namespace.clone();
            item["name"] = function["wire_name"].clone();
            item["encrypted_function_args"] = json!([]);
        }
        items.push(item);
    }
    items
}

pub(super) fn envelope(
    id: &str,
    model: &str,
    created: u64,
    previous: Option<&str>,
    output: Option<&Output>,
) -> Value {
    json!({"id":id,"object":"response","created_at":created,"model":model,"previous_response_id":previous,
        "status":if output.is_some(){"completed"}else{"in_progress"},"output":output.map(|o|output_items(id,o)).unwrap_or_default(),
        "error":null,"incomplete_details":null,"usage":null,"metadata":{},"store":false})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namespace_names_do_not_collide_and_wire_names_are_restored() {
        let defs = tools(&json!([
            {"type":"function","name":"run"},
            {"type":"namespace","name":"first","tools":[{"type":"function","name":"run"}]},
            {"type":"namespace","name":"second","tools":[{"type":"function","name":"run"}]}
        ]))
        .unwrap();
        let first = defs[1]["function"]["name"].as_str().unwrap();
        assert_ne!(first, "run");
        assert_ne!(first, defs[2]["function"]["name"]);
        assert!(tools(&json!([
            {"type":"function","name":first},
            {"type":"namespace","name":"first","tools":[{"type":"function","name":"run"}]}
        ]))
        .is_err());
        assert!(tools(
            &json!([{"type":"namespace","name":"first","tools":[{"type":"custom","name":"run"}]}])
        )
        .is_err());
        let mut calls = vec![
            json!({"id":"call_example","type":"function","function":{"name":first,"arguments":"{}"}}),
        ];
        label_calls(&mut calls, &defs);
        let items = output_items(
            "example",
            &Output {
                text: String::new(),
                calls,
            },
        );
        assert_eq!(items[0]["name"], "run");
        assert_eq!(items[0]["namespace"], "first");
        assert_eq!(items[0]["call_id"], "call_example");
        assert_eq!(items[0]["encrypted_function_args"], json!([]));
    }
}
