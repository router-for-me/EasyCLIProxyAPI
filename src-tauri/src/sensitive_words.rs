use crate::*;
use std::collections::BTreeSet;

const DEFAULT_URL: &str = "https://raw.githubusercontent.com/router-for-me/EasyCLIProxyAPI/main/src-tauri/resources/sensitive-words/rules.json";
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

async fn download_catalog(url: &str) -> Result<Catalog, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(url)
        .header("Cache-Control", "no-cache")
        .header("User-Agent", "EasyCLIProxyAPI")
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

#[tauri::command]
pub(crate) async fn fetch_latest_sensitive_word_rules() -> Result<Catalog, String> {
    // Fetch only. The user reviews and saves the merged ordinary settings.
    download_catalog(DEFAULT_URL).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_repository_file_and_normalizes_provider_fields() {
        let catalog =
            parse_catalog(include_bytes!("../resources/sensitive-words/rules.json")).unwrap();
        assert_eq!(catalog.rules.len(), 14);
        assert!(catalog
            .rules
            .iter()
            .any(|r| r.provider == "antigravity" && r.kind == "replace" && r.target == "Codex" && r.replacement == "Assistant"));
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
        assert!(catalog.rules.iter().any(|r| r.target == "Other"
            && r.replacement
                == "  text\nnext  "));
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
