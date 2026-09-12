use super::*;

// USD per million tokens: input, cached input, output. A negative value means
// that the provider does not publish/support that modality for this model.
// Source: https://developers.openai.com/api/docs/pricing (2026-09-12).
fn rates(model: &str) -> Option<[[f64; 3]; 3]> {
    let table = match model {
        "gpt-image-2" | "gpt-image-2.5-sunburst" | "gpt-image-2.5-flare" => {
            [[5., 1.25, -1.], [-1., -1., -1.], [8., 2., 30.]]
        }
        "gpt-image-1.5" | "chatgpt-image-latest" => {
            [[5., 1.25, 10.], [-1., -1., -1.], [8., 2., 32.]]
        }
        "gpt-image-1-mini" => [[2., 0.2, -1.], [-1., -1., -1.], [2.5, 0.25, 8.]],
        "gpt-image-1" => [[5., 1.25, -1.], [-1., -1., -1.], [10., 2.5, 40.]],
        "gpt-realtime-2.1" | "gpt-realtime-2" => [[4., 0.4, 24.], [32., 0.4, 64.], [5., 0.5, -1.]],
        "gpt-realtime" | "gpt-realtime-1.5" => [[4., 0.4, 16.], [32., 0.4, 64.], [5., 0.5, -1.]],
        "gpt-realtime-mini" | "gpt-realtime-2.1-mini" => {
            [[0.6, 0.06, 2.4], [10., 0.3, 20.], [0.8, 0.08, -1.]]
        }
        "gpt-audio" | "gpt-audio-1.5" => [[2.5, -1., 10.], [32., -1., 64.], [-1., -1., -1.]],
        "gpt-audio-mini" => [[0.6, -1., 2.4], [10., -1., 20.], [-1., -1., -1.]],
        _ => return None,
    };
    Some(table)
}

pub(super) fn supported(model: &str) -> bool {
    rates(model).is_some()
}

pub(super) fn cost(model: &str, tier: &str, t: &CostTokens, raw: &Value) -> Option<f64> {
    let mut rates = rates(model)?;
    match tier {
        "" | "auto" | "default" | "standard" => {}
        "batch"
            if matches!(
                model,
                "gpt-image-2"
                    | "gpt-image-1.5"
                    | "gpt-image-1-mini"
                    | "gpt-image-1"
                    | "chatgpt-image-latest"
            ) =>
        {
            for modality in &mut rates {
                for rate in modality {
                    if *rate >= 0. {
                        *rate *= 0.5;
                    }
                }
            }
            // Published batch cached rates are rounded independently.
            if matches!(
                model,
                "gpt-image-1.5" | "gpt-image-1" | "chatgpt-image-latest"
            ) {
                rates[0][1] = 0.63;
            }
            if model == "gpt-image-1-mini" {
                rates[2][1] = 0.13;
            }
        }
        _ => return None,
    }
    let input = raw
        .get("input_token_details")
        .or_else(|| raw.get("input_tokens_details"))
        .or_else(|| raw.get("prompt_tokens_details"));
    let output = raw
        .get("output_token_details")
        .or_else(|| raw.get("output_tokens_details"))
        .or_else(|| raw.get("completion_tokens_details"));
    let counts = |node: Option<&Value>| -> [u64; 3] {
        ["text_tokens", "audio_tokens", "image_tokens"]
            .map(|key| node.and_then(|v| v[key].as_u64()).unwrap_or(0))
    };
    let input_counts = counts(input);
    let mut output_counts = counts(output);
    let cached_counts = counts(input.and_then(|v| v.get("cached_tokens_details")));
    if output.is_none() && model.starts_with("gpt-image-") && rates[0][2] < 0. {
        output_counts[2] = t.output;
    }
    // Some audio Chat Completions responses omit text counts, but do not infer
    // them from a remainder: unsupported image/video dimensions could be hidden.
    let sum = |values: [u64; 3]| values.into_iter().try_fold(0_u64, u64::checked_add);
    if sum(input_counts) != Some(t.input)
        || sum(output_counts) != Some(t.output)
        || sum(cached_counts) != Some(t.cache_read)
        || t.cache_creation != 0
    {
        return None;
    }
    let mut cost = 0.;
    for i in 0..3 {
        let uncached = input_counts[i].checked_sub(cached_counts[i])?;
        for (count, rate) in [
            (uncached, rates[i][0]),
            (cached_counts[i], rates[i][1]),
            (output_counts[i], rates[i][2]),
        ] {
            if count > 0 {
                if rate < 0. {
                    return None;
                };
                cost += count as f64 * rate;
            }
        }
    }
    cost.is_finite().then_some(cost / TOKENS_PER_PRICE_UNIT)
}
