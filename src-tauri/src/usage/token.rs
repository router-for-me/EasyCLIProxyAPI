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

/// The schema-v2 token split from the core record, carried next to the flat
/// `tokens` fields. Its buckets do not overlap, whereas the vendor counts beside
/// them do, which is why this split is used whenever the core declared it usable.
///
/// The fields follow the core's own partition: `input.uncached` stays because
/// the bucket sums must be checkable, and `unclassified` holds tokens no bucket
/// accounted for.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(super) struct TokenBreakdownValues {
    pub(super) input_total: u64,
    pub(super) uncached: u64,
    pub(super) cache_read: u64,
    pub(super) cache_write: u64,
    pub(super) output_total: u64,
    pub(super) non_reasoning: u64,
    pub(super) reasoning: u64,
    pub(super) total: u64,
    pub(super) unclassified: u64,
    /// `quality` as reported, lowercased. Only `complete` is taken at face
    /// value; `unclassified` still yields correct totals but its split is
    /// acknowledged to be partial.
    pub(super) quality: TokenQuality,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(super) enum TokenQuality {
    Complete,
    /// Not every token could be attributed, so the buckets do not add up to the
    /// record total.
    Unclassified,
    /// Missing or unrecognized, as with records written before schema v2 or a
    /// value this version does not handle.
    #[default]
    Unknown,
}

impl TokenQuality {
    pub(super) fn parse(value: Option<&str>) -> Self {
        match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            Some("complete") => TokenQuality::Complete,
            Some("unclassified") => TokenQuality::Unclassified,
            _ => TokenQuality::Unknown,
        }
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
    breakdown: Option<TokenBreakdownValues>,
    mut tokens: TokenValues,
) -> TokenValues {
    if let Some(breakdown) = breakdown {
        if let Some(normalized) = normalize_from_breakdown(breakdown) {
            return normalized;
        }
    }
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

/// Converts a core-normalized `token_breakdown` into the usage page convention:
/// input includes cache reads and cache writes, output includes reasoning.
///
/// The breakdown is only accepted when it is a verifiable partition. A record
/// whose buckets do not sum is exactly the case this function exists to avoid
/// guessing at, so it is rejected and the caller falls back to the legacy
/// per-executor heuristics rather than trusting a malformed split.
fn normalize_from_breakdown(breakdown: TokenBreakdownValues) -> Option<TokenValues> {
    if breakdown.quality == TokenQuality::Unknown {
        return None;
    }
    if breakdown.quality == TokenQuality::Unclassified && breakdown.unclassified == 0 {
        return None;
    }
    // Partition identities: each parent must equal the sum of its own buckets,
    // and the grand total must cover input + output + unclassified.
    if !is_token_sum(
        breakdown.input_total,
        &[breakdown.uncached, breakdown.cache_read, breakdown.cache_write],
    ) {
        return None;
    }
    if !is_token_sum(
        breakdown.output_total,
        &[breakdown.non_reasoning, breakdown.reasoning],
    ) {
        return None;
    }
    if !is_token_sum(
        breakdown.total,
        &[breakdown.input_total, breakdown.output_total, breakdown.unclassified],
    ) {
        return None;
    }
    // A complete partition attributes every token; an unclassified one must not
    // claim it does.
    if breakdown.quality == TokenQuality::Complete && breakdown.unclassified != 0 {
        return None;
    }
    if breakdown.input_total == 0 && breakdown.output_total == 0 && breakdown.total == 0 {
        return None;
    }
    Some(TokenValues {
        input: breakdown.input_total,
        output: breakdown.output_total,
        reasoning: breakdown.reasoning,
        cached: checked_sum(&[breakdown.cache_read, breakdown.cache_write])?,
        cache_read: breakdown.cache_read,
        cache_read_present: true,
        cache_creation: breakdown.cache_write,
        total: breakdown.total,
        clamped: ClampedTokenFields::default(),
    })
}

fn is_token_sum(total: u64, parts: &[u64]) -> bool {
    parts
        .iter()
        .try_fold(0_u64, |sum, part| sum.checked_add(*part))
        .is_some_and(|sum| sum == total)
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
            None,
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
            None,
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
            None,
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
            None,
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
            None,
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
            None,
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
            None,
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
    // Issue #652: a plugin executor reports the Claude protocol, but its records
    // carry `executor_type: "executorAdapter"`, which has no dedicated handler.
    // The flat fields keep the upstream (exclusive) convention while the core
    // supplies the authoritative normalized `token_breakdown`.
    #[test]
    fn plugin_executor_claude_breakdown_drives_input_and_cache() {
        let tokens = normalize(
            "executorAdapter",
            "example-plugin",
            "oauth",
            Some(TokenBreakdownValues {
                input_total: 1015,
                uncached: 15,
                cache_read: 0,
                cache_write: 1000,
                output_total: 4,
                non_reasoning: 4,
                reasoning: 0,
                total: 1019,
                unclassified: 0,
                quality: TokenQuality::Complete,
            }),
            TokenValues {
                input: 15,
                output: 4,
                cached: 1000,
                cache_read: 0,
                cache_read_present: true,
                cache_creation: 1000,
                total: 1019,
                ..TokenValues::default()
            },
        );
        assert_eq!(tokens.input, 1015, "input must include cache writes");
        assert_eq!(
            tokens.cache_read, 0,
            "a write-only request has no cache read"
        );
        assert_eq!(tokens.cache_creation, 1000);
        assert_eq!(tokens.output, 4);
        assert_eq!(tokens.total, 1019);
        let uncached_input = tokens
            .input
            .saturating_sub(tokens.cache_read)
            .saturating_sub(tokens.cache_creation);
        assert_eq!(uncached_input, 15, "uncached input must stay billable");
    }

    #[test]
    fn plugin_executor_gemini_breakdown_folds_thinking_into_output() {
        let tokens = normalize(
            "executorAdapter",
            "example-plugin",
            "oauth",
            Some(TokenBreakdownValues {
                input_total: 100,
                uncached: 100,
                cache_read: 0,
                cache_write: 0,
                output_total: 520,
                non_reasoning: 20,
                reasoning: 500,
                total: 620,
                unclassified: 0,
                quality: TokenQuality::Complete,
            }),
            TokenValues {
                input: 100,
                output: 20,
                reasoning: 500,
                cache_read_present: true,
                total: 620,
                ..TokenValues::default()
            },
        );
        assert_eq!(tokens.output, 520, "thinking tokens belong in output");
        assert_eq!(tokens.reasoning, 500);
        assert_eq!(tokens.total, 620);
    }

    #[test]
    fn plugin_executor_openai_breakdown_matches_legacy_fallback() {
        let tokens = normalize(
            "executorAdapter",
            "example-plugin",
            "oauth",
            Some(TokenBreakdownValues {
                input_total: 100,
                uncached: 100,
                cache_read: 0,
                cache_write: 0,
                output_total: 20,
                non_reasoning: 15,
                reasoning: 5,
                total: 120,
                unclassified: 0,
                quality: TokenQuality::Complete,
            }),
            TokenValues {
                input: 100,
                output: 20,
                reasoning: 5,
                cache_read_present: true,
                total: 120,
                ..TokenValues::default()
            },
        );
        assert_eq!(tokens.input, 100);
        assert_eq!(tokens.output, 20);
        assert_eq!(tokens.total, 120);
    }

    #[test]
    fn inconsistent_breakdown_falls_back_to_executor_heuristics() {
        // cache read exceeds total input: not trustworthy, so the Claude handler runs.
        let tokens = normalize(
            "ClaudeExecutor",
            "anthropic",
            "oauth",
            Some(TokenBreakdownValues {
                input_total: 10,
                uncached: 0,
                cache_read: 50,
                cache_write: 0,
                output_total: 4,
                non_reasoning: 4,
                reasoning: 0,
                total: 64,
                unclassified: 0,
                quality: TokenQuality::Complete,
            }),
            TokenValues {
                input: 100,
                output: 20,
                cache_read: 10,
                cache_read_present: true,
                cache_creation: 5,
                total: 120,
                ..TokenValues::default()
            },
        );
        assert_eq!(tokens.input, 115, "legacy Claude fold still applies");
    }

    #[test]
    fn incomplete_partition_is_rejected() {
        // input total does not equal uncached + read + write.
        let tokens = normalize(
            "ClaudeExecutor",
            "anthropic",
            "oauth",
            Some(TokenBreakdownValues {
                input_total: 1015,
                uncached: 15,
                cache_read: 0,
                cache_write: 990,
                output_total: 4,
                non_reasoning: 4,
                reasoning: 0,
                total: 1019,
                unclassified: 0,
                quality: TokenQuality::Complete,
            }),
            TokenValues {
                input: 15,
                output: 4,
                cache_read: 0,
                cache_read_present: true,
                cache_creation: 1000,
                total: 1019,
                ..TokenValues::default()
            },
        );
        // Falls back to the Claude handler: 15 + 0 + 1000.
        assert_eq!(tokens.input, 1015);
        assert_eq!(tokens.cache_creation, 1000);
    }

    #[test]
    fn complete_partition_carrying_unclassified_tokens_is_rejected() {
        let tokens = normalize(
            "GeminiExecutor",
            "gemini",
            "oauth",
            Some(TokenBreakdownValues {
                input_total: 100,
                uncached: 100,
                cache_read: 0,
                cache_write: 0,
                output_total: 20,
                non_reasoning: 20,
                reasoning: 0,
                total: 130,
                unclassified: 10,
                quality: TokenQuality::Complete,
            }),
            TokenValues {
                input: 100,
                output: 10,
                reasoning: 10,
                cache_read_present: true,
                total: 130,
                ..TokenValues::default()
            },
        );
        // Handler contract wins: reasoning folds into output.
        assert_eq!(tokens.output, 20);
    }

    #[test]
    fn unclassified_partition_uses_canonical_totals() {
        let tokens = normalize(
            "executorAdapter",
            "example-plugin",
            "oauth",
            Some(TokenBreakdownValues {
                input_total: 100,
                uncached: 90,
                cache_read: 10,
                cache_write: 0,
                output_total: 20,
                non_reasoning: 20,
                reasoning: 0,
                total: 130,
                unclassified: 10,
                quality: TokenQuality::Unclassified,
            }),
            TokenValues {
                input: 90,
                output: 20,
                cache_read: 10,
                cache_read_present: true,
                total: 130,
                ..TokenValues::default()
            },
        );
        assert_eq!(tokens.input, 100);
        assert_eq!(tokens.cache_read, 10);
        assert_eq!(tokens.total, 130);
    }

    #[test]
    fn unclassified_quality_without_unclassified_tokens_is_rejected() {
        let tokens = normalize(
            "executorAdapter",
            "example-plugin",
            "oauth",
            Some(TokenBreakdownValues {
                input_total: 100,
                uncached: 100,
                cache_read: 0,
                cache_write: 0,
                output_total: 20,
                non_reasoning: 20,
                reasoning: 0,
                total: 120,
                unclassified: 0,
                quality: TokenQuality::Unclassified,
            }),
            TokenValues {
                input: 100,
                output: 20,
                cache_read_present: true,
                total: 120,
                ..TokenValues::default()
            },
        );
        // Rejected, so the legacy fallback keeps the flat fields as-is.
        assert_eq!(tokens.input, 100);
        assert_eq!(tokens.total, 120);
    }

    #[test]
    fn empty_breakdown_is_ignored() {
        let tokens = normalize(
            "executorAdapter",
            "example-plugin",
            "oauth",
            Some(TokenBreakdownValues::default()),
            TokenValues {
                input: 15,
                output: 4,
                cache_read_present: true,
                total: 19,
                ..TokenValues::default()
            },
        );
        assert_eq!(tokens.input, 15);
        assert_eq!(tokens.total, 19);
    }
}
