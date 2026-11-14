use crate::*;
use std::collections::BTreeSet;

const DEFAULT_URL: &str = "https://raw.githubusercontent.com/router-for-me/EasyCLIProxyAPI/main/src-tauri/resources/sensitive-words/rules.json";
const API_URL: &str = "https://api.github.com/repos/router-for-me/EasyCLIProxyAPI/contents/src-tauri/resources/sensitive-words/rules.json?ref=main";
const MAX_BYTES: usize = 1024 * 1024;

// The repository file is organized for people editing it on GitHub.
// Only the command response uses the flat editor representation.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AntigravityRules {
    #[serde(default)]
    word_replacements: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    words_to_obfuscate: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DevinRules {
    #[serde(default)]
    word_replacements: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    system_prompt_line_filters: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RuleFile {
    antigravity: Option<AntigravityRules>,
    devin: Option<DevinRules>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Rule {
    provider: String,
    kind: String,
    target: String,
    replacement: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct Catalog {
    rules: Vec<Rule>,
}

fn parse_catalog(content: &[u8]) -> Result<Catalog, String> {
    if content.len() > MAX_BYTES {
        return Err("Cloud rule file exceeds 1 MiB".into());
    }
    let file: RuleFile =
        serde_json::from_slice(content).map_err(|error| format!("Invalid rule JSON: {error}"))?;
    if file.antigravity.is_none() && file.devin.is_none() {
        return Err("Rule file must contain antigravity or devin".into());
    }
    let mut rules = Vec::new();
    let mut append = |provider: &str,
                      field: &str,
                      kind: &str,
                      target: String,
                      replacement: String|
     -> Result<(), String> {
        let target = target.trim().to_string();
        if target.is_empty()
            || target.len() > 16384
            || replacement.len() > 65536
            || (kind == "obfuscate" && target.chars().count() < 2)
        {
            return Err(format!(
                "{provider}.{field}: invalid text length for {target:?}"
            ));
        }
        rules.push(Rule {
            provider: provider.into(),
            kind: kind.into(),
            target,
            replacement,
        });
        if rules.len() > 2000 {
            return Err("Rule file may contain at most 2000 entries".into());
        }
        Ok(())
    };
    if let Some(section) = file.antigravity {
        for (target, replacement) in section.word_replacements {
            append(
                "antigravity",
                "wordReplacements",
                "replace",
                target,
                replacement,
            )?;
        }
        for target in section.words_to_obfuscate {
            append(
                "antigravity",
                "wordsToObfuscate",
                "obfuscate",
                target,
                String::new(),
            )?;
        }
    }
    if let Some(section) = file.devin {
        for (target, replacement) in section.word_replacements {
            append("devin", "wordReplacements", "replace", target, replacement)?;
        }
        for target in section.system_prompt_line_filters {
            append(
                "devin",
                "systemPromptLineFilters",
                "obfuscate",
                target,
                String::new(),
            )?;
        }
    }
    let mut seen = BTreeSet::new();
    for rule in &rules {
        if !seen.insert((&rule.provider, rule.target.to_lowercase())) {
            return Err(format!(
                "{}: duplicate original text {:?} (case-insensitive)",
                rule.provider, rule.target
            ));
        }
    }
    Ok(Catalog { rules })
}

fn configured_token(document: &serde_norway::Value, environment: Option<String>) -> Option<String> {
    let value = document
        .as_mapping()
        .and_then(|root| {
            nested_yaml_value(root, &["server", "github-token"])
                .or_else(|| nested_yaml_value(root, &["github-token"]))
        })
        .and_then(serde_norway::Value::as_str);
    crate::plugins::plugin_github_token(&serde_json::json!({"github-token": value}), environment)
}

fn github_token() -> Option<String> {
    let environment = std::env::var("GITHUB_TOKEN").ok();
    let document = lock_core_config_file().ok().and_then(|_guard| {
        read_core_config_document()
            .ok()
            .map(|(_, document)| document.get().clone())
    });
    configured_token(
        document.as_ref().unwrap_or(&serde_norway::Value::Null),
        environment,
    )
}

fn catalog_request(
    client: &reqwest::Client,
    api: bool,
    token: Option<&str>,
) -> reqwest::RequestBuilder {
    let request = client
        .get(if api { API_URL } else { DEFAULT_URL })
        .header("Cache-Control", "no-cache")
        .header("User-Agent", "EasyCLIProxyAPI");
    if api {
        let request = request
            .header("Accept", "application/vnd.github.raw+json")
            .header("X-GitHub-Api-Version", "2022-11-28");
        if let Some(token) = token {
            return request.bearer_auth(token);
        }
        request
    } else {
        // Never forward the configured token to Raw, mirrors, or redirects.
        request
    }
}

async fn read_catalog_request(request: reqwest::RequestBuilder) -> Result<Catalog, String> {
    let mut response = request
        .send()
        .await
        .map_err(|e| format!("Cloud sync failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Cloud sync failed: {e}"))?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Err("Cloud rule file exceeds 1 MiB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    parse_catalog(&bytes)
}

async fn download_catalog(proxy_url: &str, token: Option<&str>) -> Result<Catalog, String> {
    let client = build_http_client_with_proxy(
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none()),
        proxy_url,
        "Failed to create cloud rules client",
    )?;
    match read_catalog_request(catalog_request(&client, true, token)).await {
        Ok(catalog) => Ok(catalog),
        Err(api_error) => read_catalog_request(catalog_request(&client, false, None))
            .await
            .map_err(|raw_error| format!("GitHub API: {api_error}; Raw fallback: {raw_error}")),
    }
}

#[tauri::command]
pub(crate) async fn fetch_latest_sensitive_word_rules(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<Catalog, String> {
    // Fetch only. The user reviews and saves the merged ordinary settings.
    let config = gui_config_state.snapshot()?;
    let token = github_token();
    download_catalog(&config.proxy_url, token.as_deref()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cloud_requests_authenticate_only_the_github_api() {
        let client = reqwest::Client::new();
        let api = catalog_request(&client, true, Some("fixture-token"))
            .build()
            .unwrap();
        assert_eq!(api.url().host_str(), Some("api.github.com"));
        assert_eq!(api.url().path(), "/repos/router-for-me/EasyCLIProxyAPI/contents/src-tauri/resources/sensitive-words/rules.json");
        assert_eq!(api.url().query(), Some("ref=main"));
        assert_eq!(api.headers()["authorization"], "Bearer fixture-token");
        assert_eq!(api.headers()["accept"], "application/vnd.github.raw+json");
        assert!(!catalog_request(&client, true, None)
            .build()
            .unwrap()
            .headers()
            .contains_key("authorization"));
        let raw = catalog_request(&client, false, Some("fixture-token"))
            .build()
            .unwrap();
        assert_eq!(raw.url().host_str(), Some("raw.githubusercontent.com"));
        assert!(!raw.headers().contains_key("authorization"));
    }
    #[test]
    fn configured_github_token_precedes_environment_and_supports_both_layouts() {
        for yaml in [
            "server: {github-token: ' configured '}",
            "github-token: ' configured '",
        ] {
            let document = serde_norway::from_str(yaml).unwrap();
            assert_eq!(
                configured_token(&document, Some("environment".into())).as_deref(),
                Some("configured")
            );
        }
        let document = serde_norway::from_str("server: {github-token: ' '}").unwrap();
        assert_eq!(
            configured_token(&document, Some(" environment ".into())).as_deref(),
            Some("environment")
        );
        assert_eq!(configured_token(&serde_norway::Value::Null, None), None);
    }
    #[test]
    fn reads_repository_file_and_normalizes_provider_fields() {
        let catalog =
            parse_catalog(include_bytes!("../resources/sensitive-words/rules.json")).unwrap();
        assert_eq!(catalog.rules.len(), 14);
        assert!(catalog.rules.iter().any(|r| r.provider == "antigravity"
            && r.kind == "replace"
            && r.target == "Codex"
            && r.replacement == "Assistant"));
        assert!(catalog
            .rules
            .iter()
            .any(|r| r.provider == "devin" && r.kind == "obfuscate" && r.target == "OpenClaw"));
    }
    #[test]
    fn preserves_empty_and_multiline_replacements() {
        let catalog = parse_catalog(
            br#"{"devin":{"wordReplacements":{" phrase ":"","Other":"  text\nnext  "}}}"#,
        )
        .unwrap();
        assert_eq!(catalog.rules.len(), 2);
        assert!(catalog
            .rules
            .iter()
            .any(|r| r.target == "phrase" && r.replacement.is_empty()));
        assert!(catalog
            .rules
            .iter()
            .any(|r| r.target == "Other" && r.replacement == "  text\nnext  "));
        assert!(catalog.rules.iter().all(|r| r.kind == "replace"));
    }
    #[test]
    fn allows_empty_and_omitted_optional_collections() {
        assert!(parse_catalog(br#"{"antigravity":{}}"#)
            .unwrap()
            .rules
            .is_empty());
        assert!(parse_catalog(
            br#"{"devin":{"wordReplacements":{},"systemPromptLineFilters":[]}}"#
        )
        .unwrap()
        .rules
        .is_empty());
    }
    #[test]
    fn rejects_invalid_fields_types_duplicates_and_limits() {
        for value in [
            r#"{}"#,
            r#"{"antigravity":{"wordReplacement":{}}}"#,
            r#"{"antigravity":{"systemPromptLineFilters":[]}}"#,
            r#"{"devin":{"wordsToObfuscate":[]}}"#,
            r#"{"devin":{"wordReplacements":{"text":null}}}"#,
            r#"{"antigravity":{"wordsToObfuscate":["A"]}}"#,
            r#"{"devin":{"wordReplacements":{"Text":"a"," TEXT ":"b"}}}"#,
            r#"{"antigravity":{"wordReplacements":{"Codex":"a"},"wordsToObfuscate":["codex"]}}"#,
        ] {
            assert!(parse_catalog(value.as_bytes()).is_err(), "{value}");
        }
        assert!(parse_catalog(&vec![b' '; MAX_BYTES + 1]).is_err());
        let file = serde_json::json!({"devin":{"systemPromptLineFilters":(0..2001).map(|i|format!("word-{i}")).collect::<Vec<_>>()}});
        assert!(parse_catalog(&serde_json::to_vec(&file).unwrap()).is_err());
    }
}
