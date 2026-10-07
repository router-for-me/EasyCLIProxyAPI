use std::time::Duration;

use super::{
    effective_agent_api_key, managed_core_loopback_origin, managed_core_tls_enabled,
    truncate_for_error, GuiConfigState, USER_AGENT,
};

// The prompt carries a trimmed store catalog; these caps keep a malformed
// caller from sending an unbounded request through the user's accounts.
const MAX_SYSTEM_CHARS: usize = 120_000;
const MAX_QUESTION_CHARS: usize = 2_000;

fn validate_finder_input(model: &str, system: &str, question: &str) -> Result<(), String> {
    if model.trim().is_empty() {
        return Err("No model is available for the plugin finder".to_string());
    }
    if question.trim().is_empty() {
        return Err("Describe what you want a plugin to do".to_string());
    }
    if question.chars().count() > MAX_QUESTION_CHARS {
        return Err(format!("Keep the request under {MAX_QUESTION_CHARS} characters"));
    }
    if system.chars().count() > MAX_SYSTEM_CHARS {
        return Err("The plugin catalog is too large to search".to_string());
    }
    Ok(())
}

fn finder_answer_text(payload: &serde_json::Value) -> Option<String> {
    let content = payload.pointer("/choices/0/message/content")?;
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    // Some upstreams return content parts instead of a plain string.
    let parts = content.as_array()?;
    let text: String = parts
        .iter()
        .filter_map(|part| part.get("text").and_then(|value| value.as_str()))
        .collect();
    (!text.is_empty()).then_some(text)
}

/// Sends one chat request through the local proxy using the GUI's own client key,
/// so the key never reaches the webview. Returns the model's reply text.
#[tauri::command]
pub(crate) async fn ask_plugin_finder(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    model: String,
    system: String,
    question: String,
) -> Result<String, String> {
    validate_finder_input(&model, &system, &question)?;
    let config = gui_config_state.snapshot()?;
    if config.port == 0 {
        return Err("Invalid kernel port".to_string());
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(90))
        .danger_accept_invalid_certs(managed_core_tls_enabled())
        .build()
        .map_err(|error| format!("Failed to create plugin finder client: {error}"))?;
    let endpoint = format!(
        "{}/v1/chat/completions",
        managed_core_loopback_origin(config.port)
    );
    let body = serde_json::json!({
        "model": model.trim(),
        "max_tokens": 1500,
        "temperature": 0,
        "stream": false,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": question.trim() },
        ],
    });
    let response = client
        .post(&endpoint)
        .bearer_auth(effective_agent_api_key(&config))
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("Plugin finder request failed: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("Failed to read plugin finder reply: {error}"))?;
    if !status.is_success() {
        return Err(format!(
            "Plugin finder request failed ({}): {}",
            status.as_u16(),
            truncate_for_error(&text)
        ));
    }
    let payload = serde_json::from_str::<serde_json::Value>(&text)
        .map_err(|error| format!("Failed to parse plugin finder reply: {error}"))?;
    finder_answer_text(&payload).ok_or_else(|| "The model returned an empty answer".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_and_oversized_input() {
        assert!(validate_finder_input("", "s", "q").is_err());
        assert!(validate_finder_input("m", "s", "  ").is_err());
        assert!(validate_finder_input("m", "s", &"q".repeat(MAX_QUESTION_CHARS + 1)).is_err());
        assert!(validate_finder_input("m", &"s".repeat(MAX_SYSTEM_CHARS + 1), "q").is_err());
        assert!(validate_finder_input("m", "s", "q").is_ok());
    }

    #[test]
    fn reads_string_and_part_content() {
        let plain = serde_json::json!({ "choices": [{ "message": { "content": "hi" } }] });
        assert_eq!(finder_answer_text(&plain).as_deref(), Some("hi"));
        let parts = serde_json::json!({ "choices": [{ "message": { "content": [{ "type": "text", "text": "a" }, { "type": "text", "text": "b" }] } }] });
        assert_eq!(finder_answer_text(&parts).as_deref(), Some("ab"));
        assert_eq!(finder_answer_text(&serde_json::json!({ "choices": [] })), None);
    }
}
