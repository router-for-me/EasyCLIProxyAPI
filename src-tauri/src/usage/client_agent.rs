use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// A client header is self-reported telemetry, never an authentication identity.
/// Only stable product identifiers leave the usage store; no header text does.
pub(super) fn identify(value: &str) -> Option<&'static str> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let lower = value
        .chars()
        .take(4096)
        .collect::<String>()
        .to_ascii_lowercase();
    let mut outside = String::with_capacity(lower.len().min(4096));
    let mut depth = 0_u32;
    for ch in lower.chars().take(4096) {
        match ch {
            '(' => {
                depth = depth.saturating_add(1);
                outside.push(' ');
            }
            ')' => {
                depth = depth.saturating_sub(1);
                outside.push(' ');
            }
            _ if depth == 0 => outside.push(ch),
            _ => {}
        }
    }
    let products: Vec<&str> = outside.split_ascii_whitespace().collect();
    // A forwarding client can explicitly name its originating product.
    for token in &products {
        if let Some(("agent" | "ai-agent", tail)) = token.split_once('/') {
            if let Some(id) = canonical_product(tail.split('/').next().unwrap_or_default()) {
                return Some(id);
            }
        }
    }
    let first = products.first().copied().unwrap_or_default();
    let (head, version) = first.split_once('/').unwrap_or((first, ""));
    let versioned = version.as_bytes().first().is_some_and(u8::is_ascii_digit);
    if head == "claude-cli" && versioned {
        // Desktop's embedded coding client shares the CLI product token.
        let desktop = lower
            .split_once('(')
            .and_then(|(_, tail)| tail.split_once(')'))
            .is_some_and(|(comment, _)| {
                comment
                    .split([',', ';'])
                    .map(str::trim)
                    .any(|field| matches!(field, "claude-desktop" | "claude-desktop-3p"))
            });
        if desktop {
            return Some("claude-desktop");
        }
        if version.starts_with("1.") || version.starts_with("2.") {
            return Some("claude-code");
        }
        return Some("other");
    }
    if matches!(head, "codex_cli_rs" | "openai" | "asyncopenai")
        && comment_field(&lower, "hermes agent")
    {
        return Some("hermes");
    }
    if head == "codex"
        && products
            .get(1)
            .is_some_and(|token| token.starts_with("desktop/"))
    {
        return Some("codex");
    }
    if head == "mozilla" && versioned {
        let has = |name: &str| {
            products.iter().any(|token| {
                token
                    .strip_prefix(name)
                    .and_then(|tail| tail.strip_prefix('/'))
                    .and_then(|tail| tail.as_bytes().first())
                    .is_some_and(u8::is_ascii_digit)
            })
        };
        if has("claude") && has("electron") {
            return Some("claude-desktop");
        }
        return Some("other");
    }
    if versioned || (version.is_empty() && !short_product(head)) {
        if let Some(id) = canonical_product(head) {
            return Some(id);
        }
    }
    // A library may precede an explicit client product. Ignore comments and
    // require a version for secondary tokens; generic short words are not enough.
    for token in products.iter().skip(1) {
        if let Some((product, release)) = token.split_once('/') {
            if !short_product(product) && release.as_bytes().first().is_some_and(u8::is_ascii_digit)
            {
                if let Some(id) = canonical_product(product) {
                    return Some(id);
                }
            }
        }
    }
    Some("other")
}

fn comment_field(value: &str, expected: &str) -> bool {
    value
        .split('(')
        .skip(1)
        .filter_map(|tail| tail.split_once(')'))
        .any(|(comment, _)| {
            comment
                .split([',', ';'])
                .map(str::trim)
                .any(|field| field == expected)
        })
}

fn short_product(product: &str) -> bool {
    matches!(product, "pi" | "omp" | "dsh" | "hermes" | "copilot" | "agy")
}

fn canonical_product(product: &str) -> Option<&'static str> {
    match product {
        "claude-code" => Some("claude-code"),
        "claude-desktop" => Some("claude-desktop"),
        "codex" | "codex_cli_rs" | "codex-tui" | "codex-cli" | "codex_exec" | "codex-desktop" => {
            Some("codex")
        }
        "gemini-cli" | "geminicli" | "geminicli-tui" => Some("gemini-cli"),
        "opencode" => Some("opencode"),
        "openclaw" | "openclaw-gateway" => Some("openclaw"),
        "hermes" | "hermesagent" | "hermes-agent" | "hermes-cli" => Some("hermes"),
        "deepseek-harness" | "deepseek_harness" | "dsh" => Some("deepseek-harness"),
        "zcode" | "zcode-cli" => Some("zcode"),
        "workbuddy" | "workbuddy-ai" => Some("workbuddy"),
        "antigravity-cli" | "agy" => Some("antigravity-cli"),
        "copilot-cli" | "github-copilot-cli" | "copilot" => Some("copilot-cli"),
        "vscode-copilot" | "githubcopilotchat" => Some("vscode-copilot"),
        "kimi-code" | "kimi-code-cli" | "kimi-code-desktop" | "kimi-cli" | "kimicli" => {
            Some("kimi-code")
        }
        "grok-build" | "grok-shell" | "grok-pager" => Some("grok-build"),
        "omp" | "oh-my-pi" | "oh_my_pi" => Some("omp"),
        "pi" | "pi-coding-agent" => Some("pi"),
        "other" => Some("other"),
        _ => None,
    }
}

/// Safe exported ids are distinct from short raw request product words.
/// Preserve those ids on import without weakening live request-UA recognition.
pub(super) fn deserialize<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    let value = Option::<String>::deserialize(deserializer)?;
    Ok(value.map(|value| match value.as_str() {
        "hermes" | "omp" | "pi" => format!("Agent/{value}"),
        _ => value,
    }))
}

pub(super) fn serialize<S: Serializer>(
    value: &Option<String>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    value.as_deref().and_then(identify).serialize(serializer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_agent_known_products_and_desktop_precedence() {
        for (ua, id) in [
            ("claude-cli/2.1.280 (external, cli)", "claude-code"),
            ("claude-cli/1.0.20 (external, cli)", "claude-code"),
            (
                "claude-cli/2.1.280 (external, path=/home/claude-desktop)",
                "claude-code",
            ),
            (
                "claude-cli/2.1.295 (external, claude-desktop-3p, agent-sdk/0.3)",
                "claude-desktop",
            ),
            (
                "Mozilla/5.0 (Macintosh) Claude/2.7032.0 Chrome/140.0 Electron/37.2 Safari/537.36",
                "claude-desktop",
            ),
            ("codex_cli_rs/0.47.0 (Mac OS 15.1; arm64)", "codex"),
            ("codex-tui/0.154.0", "codex"),
            ("Codex Desktop/26.820.60940 (Mac OS; arm64)", "codex"),
            ("GeminiCLI/0.66.0/gemini-test (linux; x64)", "gemini-cli"),
            ("GeminiCLI-tui/0.66.0/gemini-test", "gemini-cli"),
            ("opencode/0.15.8", "opencode"),
            ("OpenClaw/2026.11.19", "openclaw"),
            ("python-httpx/0.28 Agent/OpenClaw/2026.11.19", "openclaw"),
        ] {
            assert_eq!(identify(ua), Some(id), "signature must map to its product");
        }
    }

    #[test]
    fn client_agent_does_not_promote_libraries_models_or_substrings() {
        for ua in [
            "curl/8.1",
            "python-httpx/0.28",
            "OpenAI/Python 1.0",
            "@anthropic-ai/sdk/0.7",
            "Mozilla/5.0 (Macintosh)",
            "google-api-nodejs-client/10",
            "claude/4.5",
            "gemini/3",
            "not-opencode/1",
            "my-openclaw/1",
            "codex_cli_rs_tools/1",
            "GeminiCLI-malware/1",
            "curl/8.1 (claude-cli/2.1.280)",
            "unknown (/home/opencode/token)",
            "claude-cli/0.1.5 (external, cli)",
            "opencode/private-token",
            "person@example.test/1",
        ] {
            assert_eq!(
                identify(ua),
                Some("other"),
                "unrecognized traffic must remain other"
            );
        }
        assert_eq!(identify(" \t "), None);
    }

    #[test]
    fn client_agent_only_exports_stable_product_ids() {
        #[derive(serde::Serialize)]
        struct Projection {
            #[serde(serialize_with = "super::serialize")]
            client_agent: Option<String>,
        }
        let json = serde_json::to_string(&Projection {
            client_agent: Some(
                "OpenClaw/2026.11.19 (/home/private; person@example.test; token=not-for-ui)"
                    .to_string(),
            ),
        })
        .unwrap();
        assert_eq!(json, r#"{"client_agent":"openclaw"}"#);
    }

    #[test]
    fn client_agent_project_product_fixture_matches_and_serializes_without_header_details() {
        let rows: Vec<serde_json::Value> = serde_json::from_str(include_str!(
            "../../../tests/fixtures/usageClientAgents.json"
        ))
        .unwrap();
        #[derive(serde::Serialize, serde::Deserialize)]
        struct Projection {
            #[serde(
                serialize_with = "super::serialize",
                deserialize_with = "super::deserialize"
            )]
            client_agent: Option<String>,
        }
        for row in rows {
            let id = row["id"].as_str().unwrap();
            for header in row["headers"].as_array().unwrap() {
                let header = header.as_str().unwrap();
                assert_eq!(
                    identify(header),
                    Some(id),
                    "product header must match its stable id"
                );
                let encoded = serde_json::to_value(Projection {
                    client_agent: Some(format!(
                        "{header} (/home/private; person@example.test; token=secret)"
                    )),
                })
                .unwrap();
                assert_eq!(encoded["client_agent"], id);
                assert!(!encoded.to_string().contains("person@example.test"));
                let decoded: Projection = serde_json::from_value(encoded).unwrap();
                assert_eq!(serde_json::to_value(decoded).unwrap()["client_agent"], id);
            }
            let marker = format!("python-httpx/0.28 Agent/{id}/1.0");
            assert_eq!(identify(&marker), Some(id));
            let ai_marker = format!("Mozilla/5.0 AI-Agent/{id}/1.0");
            assert_eq!(identify(&ai_marker), Some(id));
            for collision in row["collisions"].as_array().unwrap() {
                assert_eq!(
                    identify(collision.as_str().unwrap()),
                    Some("other"),
                    "unrelated product cannot claim the client"
                );
            }
        }
    }
}
