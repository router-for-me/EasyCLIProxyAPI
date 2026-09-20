#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(super) struct TokenValues {
    pub(super) input: u64,
    pub(super) output: u64,
    pub(super) reasoning: u64,
    pub(super) cached: u64,
    pub(super) cache_read: u64,
    pub(super) cache_read_present: bool,
    pub(super) cache_creation: u64,
    pub(super) total: u64,
    pub(super) clamped: ClampedTokenFields,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(super) struct ClampedTokenFields {
    pub(super) input: bool,
    pub(super) output: bool,
    pub(super) reasoning: bool,
    pub(super) cached: bool,
    pub(super) cache_read: bool,
    pub(super) cache_creation: bool,
    pub(super) total: bool,
}

impl ClampedTokenFields {
    fn blocks_parent_contract(self) -> bool {
        self.input || self.output || self.reasoning || self.cache_read || self.cache_creation
    }

    fn blocks_zero_total(self) -> bool {
        self.input || self.output || self.total
    }

    fn blocks_reasoning_evidence(self) -> bool {
        self.blocks_zero_total() || self.reasoning
    }

    fn any(self) -> bool {
        self.blocks_parent_contract() || self.cached || self.total
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TokenHandler {
    Claude,
    Gemini,
    ResponsesInclusive,
    Strict,
    OpenAiCompatibility,
}

pub(super) fn normalize(
    executor_type: &str,
    provider: &str,
    auth_type: &str,
    mut tokens: TokenValues,
) -> TokenValues {
    let (handler, parser_contract) = resolve_handler(executor_type, provider, auth_type);
    let raw_tokens = tokens;
    if handler != TokenHandler::Claude
        && !tokens.clamped.cached
        && !tokens.clamped.cache_read
        && tokens.cache_read == 0
        && tokens.cached > 0
        && (!tokens.cache_read_present || !parser_contract)
    {
        tokens.cache_read = tokens.cached;
    }

    match handler {
        TokenHandler::Claude => normalize_claude(tokens, parser_contract),
        TokenHandler::Gemini => normalize_gemini(tokens, parser_contract),
        TokenHandler::ResponsesInclusive => {
            normalize_responses(tokens, parser_contract, executor_type, raw_tokens)
        }
        TokenHandler::OpenAiCompatibility => normalize_openai_compatibility(tokens),
        TokenHandler::Strict => reconcile_zero_total(tokens),
    }
}

fn resolve_handler(executor_type: &str, provider: &str, auth_type: &str) -> (TokenHandler, bool) {
    let executor = executor_type.trim().to_ascii_lowercase();
    let handler = match executor.as_str() {
        "claudeexecutor" => Some(TokenHandler::Claude),
        "geminiexecutor"
        | "geminivertexexecutor"
        | "geminicliexecutor"
        | "aistudioexecutor"
        | "antigravityexecutor" => Some(TokenHandler::Gemini),
        "codexexecutor"
        | "codexwebsocketsexecutor"
        | "codexautoexecutor"
        | "xaiexecutor"
        | "xaiwebsocketsexecutor"
        | "xaiautoexecutor" => Some(TokenHandler::ResponsesInclusive),
        "kimiexecutor" => Some(TokenHandler::Strict),
        "openaicompatexecutor" => Some(TokenHandler::OpenAiCompatibility),
        _ => None,
    };
    if let Some(handler) = handler {
        return (handler, true);
    }

    if !auth_type.trim().eq_ignore_ascii_case("oauth") {
        return (TokenHandler::Strict, false);
    }
    let identity = provider.trim().to_ascii_lowercase();
    let handler = match identity.as_str() {
        "claude" | "anthropic" => TokenHandler::Claude,
        "gemini"
        | "vertex"
        | "gemini-cli"
        | "gemini-cli-code-assist"
        | "gemini-interactions"
        | "aistudio"
        | "ai-studio"
        | "antigravity" => TokenHandler::Gemini,
        "codex" | "xai" => TokenHandler::ResponsesInclusive,
        "kimi" | "moonshot" => TokenHandler::Strict,
        "openai" | "openai-compatible" | "openai_compatibility" | "openai-compatibility" => {
            TokenHandler::OpenAiCompatibility
        }
        value if value.starts_with("openai-compatible-") => TokenHandler::OpenAiCompatibility,
        _ => TokenHandler::Strict,
    };
    (handler, false)
}

fn normalize_claude(mut tokens: TokenValues, parser_contract: bool) -> TokenValues {
    tokens.cached = tokens.cache_read;
    if tokens.clamped.input || tokens.clamped.cache_read || tokens.clamped.cache_creation {
        return reconcile_zero_total(tokens);
    }
    let raw_input = tokens.input;
    let raw_total = tokens.total;
    let Some(canonical_input) =
        checked_sum(&[tokens.input, tokens.cache_read, tokens.cache_creation])
    else {
        return tokens;
    };
    tokens.input = canonical_input;

    let cache_total = checked_sum(&[tokens.cache_read, tokens.cache_creation]);
    let raw_expected = checked_sum(&[raw_input, tokens.output]);
    let canonical_expected = checked_sum(&[tokens.input, tokens.output]);
    let legacy_missing_cache = !tokens.clamped.blocks_zero_total()
        && cache_total.is_some_and(|value| value > 0)
        && raw_expected == Some(raw_total)
        && canonical_expected.is_some_and(|value| value != raw_total);
    if parser_contract || legacy_missing_cache {
        reconcile_canonical_total(tokens)
    } else {
        reconcile_zero_total(tokens)
    }
}

fn normalize_gemini(mut tokens: TokenValues, parser_contract: bool) -> TokenValues {
    let should_fold = if tokens.clamped.output || tokens.clamped.reasoning {
        false
    } else if parser_contract {
        tokens.reasoning > 0
    } else if tokens.clamped.blocks_reasoning_evidence() || tokens.reasoning == 0 {
        false
    } else if tokens.total == 0 {
        true
    } else if checked_sum(&[tokens.input, tokens.output]) == Some(tokens.total) {
        false
    } else {
        checked_sum(&[tokens.input, tokens.output, tokens.reasoning]) == Some(tokens.total)
    };
    if should_fold {
        let Some(output) = checked_sum(&[tokens.output, tokens.reasoning]) else {
            return tokens;
        };
        tokens.output = output;
    }
    if parser_contract && !tokens.clamped.blocks_parent_contract() {
        reconcile_canonical_total(tokens)
    } else {
        reconcile_zero_total(tokens)
    }
}

fn normalize_responses(
    tokens: TokenValues,
    parser_contract: bool,
    executor_type: &str,
    raw_tokens: TokenValues,
) -> TokenValues {
    let legacy_codex_cached_only = parser_contract
        && executor_type.trim().eq_ignore_ascii_case("CodexExecutor")
        && !raw_tokens.clamped.any()
        && raw_tokens.input == 0
        && raw_tokens.output == 0
        && raw_tokens.reasoning == 0
        && raw_tokens.cached > 0
        && raw_tokens.cache_read == 0
        && raw_tokens.cache_creation == 0
        && raw_tokens.total == raw_tokens.cached;
    if legacy_codex_cached_only {
        return tokens;
    }
    if parser_contract && !tokens.clamped.blocks_parent_contract() {
        reconcile_canonical_total(tokens)
    } else {
        reconcile_zero_total(tokens)
    }
}

fn normalize_openai_compatibility(mut tokens: TokenValues) -> TokenValues {
    if !tokens.clamped.blocks_reasoning_evidence()
        && tokens.reasoning > 0
        && tokens.total > 0
        && checked_sum(&[tokens.input, tokens.output]) != Some(tokens.total)
        && checked_sum(&[tokens.input, tokens.output, tokens.reasoning]) == Some(tokens.total)
    {
        if let Some(output) = checked_sum(&[tokens.output, tokens.reasoning]) {
            tokens.output = output;
        }
    }
    reconcile_zero_total(tokens)
}

fn reconcile_canonical_total(mut tokens: TokenValues) -> TokenValues {
    if tokens.clamped.blocks_parent_contract() || tokens.clamped.total {
        return tokens;
    }
    let Some(cache_total) = checked_sum(&[tokens.cache_read, tokens.cache_creation]) else {
        return reconcile_zero_total(tokens);
    };
    if tokens.input < cache_total || tokens.output < tokens.reasoning {
        return reconcile_zero_total(tokens);
    }
    if let Some(total) = checked_sum(&[tokens.input, tokens.output]) {
        tokens.total = total;
    }
    tokens
}

fn reconcile_zero_total(mut tokens: TokenValues) -> TokenValues {
    if tokens.total != 0 || tokens.clamped.blocks_zero_total() {
        return tokens;
    }
    if let Some(total) = checked_sum(&[tokens.input, tokens.output]) {
        if total > 0 {
            tokens.total = total;
            return tokens;
        }
    }
    if tokens.cache_read > 0 {
        tokens.total = tokens.cache_read;
    }
    tokens
}

fn checked_sum(values: &[u64]) -> Option<u64> {
    values
        .iter()
        .try_fold(0_u64, |total, value| total.checked_add(*value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_executor_folds_cache_into_input_and_reconciles_total() {
        let tokens = normalize(
            "ClaudeExecutor",
            "anthropic",
            "oauth",
            TokenValues {
                input: 100,
                output: 20,
                cached: 10,
                cache_read: 10,
                cache_read_present: true,
                cache_creation: 5,
                total: 120,
                ..TokenValues::default()
            },
        );
        assert_eq!(tokens.input, 115);
        assert_eq!(tokens.cached, 10);
        assert_eq!(tokens.total, 135);
    }

    #[test]
    fn gemini_executor_folds_reasoning_into_output() {
        let tokens = normalize(
            "GeminiExecutor",
            "gemini",
            "oauth",
            TokenValues {
                input: 11,
                output: 7,
                reasoning: 3,
                total: 21,
                ..TokenValues::default()
            },
        );
        assert_eq!(tokens.output, 10);
        assert_eq!(tokens.total, 21);
    }

    #[test]
    fn responses_executor_preserves_inclusive_output() {
        let tokens = normalize(
            "CodexExecutor",
            "codex",
            "oauth",
            TokenValues {
                input: 100,
                output: 20,
                reasoning: 5,
                cache_read: 30,
                cache_read_present: true,
                total: 120,
                ..TokenValues::default()
            },
        );
        assert_eq!(tokens.output, 20);
        assert_eq!(tokens.total, 120);
    }

    #[test]
    fn openai_compatibility_only_folds_proven_separated_reasoning() {
        let tokens = normalize(
            "OpenAICompatExecutor",
            "openai",
            "apikey",
            TokenValues {
                input: 1_000,
                output: 20,
                reasoning: 50,
                total: 1_070,
                ..TokenValues::default()
            },
        );
        assert_eq!(tokens.output, 70);
        assert_eq!(tokens.total, 1_070);
    }

    #[test]
    fn explicit_zero_cache_read_is_not_backfilled_from_legacy_cached() {
        let tokens = normalize(
            "CodexExecutor",
            "codex",
            "oauth",
            TokenValues {
                input: 100,
                output: 20,
                cached: 30,
                cache_read_present: true,
                total: 120,
                ..TokenValues::default()
            },
        );
        assert_eq!(tokens.cache_read, 0);
    }

    #[test]
    fn identity_hint_keeps_keeper_legacy_cache_read_fallback() {
        let tokens = normalize(
            "",
            "codex",
            "oauth",
            TokenValues {
                input: 100,
                output: 20,
                cached: 30,
                cache_read_present: true,
                total: 120,
                ..TokenValues::default()
            },
        );
        assert_eq!(tokens.cache_read, 30);
    }

    #[test]
    fn unknown_identity_does_not_use_fuzzy_provider_matching() {
        let tokens = normalize(
            "",
            "custom-anthropic-proxy",
            "oauth",
            TokenValues {
                input: 100,
                output: 20,
                cache_read: 30,
                cache_read_present: true,
                total: 120,
                ..TokenValues::default()
            },
        );
        assert_eq!(tokens.input, 100);
        assert_eq!(tokens.total, 120);
    }
}
