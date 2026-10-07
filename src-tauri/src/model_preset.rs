use serde::{Deserialize, Serialize};
use tauri_plugin_dialog::DialogExt;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ModelEntry { model: String, alias: String, context1m: bool }
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ModelPreset { format: String, version: u32, client: String, models: Vec<ModelEntry> }

fn export_content(content: &str) -> Result<String, String> {
    if content.len() > 256 * 1024 { return Err("Model preset is too large".into()); }
    let preset: ModelPreset = serde_json::from_str(content).map_err(|_| "Invalid model preset")?;
    if preset.format != "tim-ai-hub.desktop-models" || preset.version != 1 || preset.client != "claude-desktop"
        || preset.models.is_empty() || preset.models.len() > 100 {
        return Err("Unsupported model preset".into());
    }
    serde_json::to_string_pretty(&preset).map_err(|_| "Could not serialize model preset".into())
}

#[tauri::command]
pub(crate) async fn export_desktop_model_preset(app: tauri::AppHandle, content: String) -> Result<bool, String> {
    let content = export_content(&content)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app.dialog().file().add_filter("JSON", &["json"])
            .set_file_name("claude-desktop-models.json").blocking_save_file() else { return Ok(false); };
        let path = file.into_path().map_err(|_| "Invalid export path".to_string())?;
        std::fs::write(path, content).map_err(|_| "Could not save model preset".to_string())?;
        Ok(true)
    }).await.map_err(|_| "Export task failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preset_export_rejects_credential_fields_and_unknown_versions() {
        let valid = r#"{"format":"tim-ai-hub.desktop-models","version":1,"client":"claude-desktop","models":[{"model":"claude-sonnet-5","alias":"","context1m":false}]}"#;
        assert!(export_content(valid).is_ok());
        assert!(export_content(&valid.replace("\"version\":1", "\"version\":2")).is_err());
        assert!(export_content(&valid.replace("\"context1m\":false", "\"context1m\":false,\"apiKey\":\"secret\"")).is_err());
    }
}
