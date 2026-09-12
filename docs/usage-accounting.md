# Usage and cost accounting

The dashboard reports usage events and the known USD amount associated with them. It is not a provider invoice or an HTTP access log. Retries, tools, prewarms, health probes, and unmeasured operations are separate event kinds. Endpoint/transport filters and distinct generation IDs make these differences visible; a WebSocket frame is not a request.

## Measurement and valuation

The collector preserves normalized token breakdown v2, quality, raw provider usage, cache lifetimes, event/attempt/generation IDs, transport, upstream URL, and reported cost. V2 is authoritative. Legacy Gemini thinking is included in billable output; OpenAI cached/reasoning tokens are subsets. Invalid or incomplete breakdowns are never repaired by inventing tokens. A missing usage object differs from an observed zero.

Each newly ingested event receives a valuation snapshot when its amount is known. The snapshot records the rates and rule version used, so editing prices does not rewrite known historical amounts. Legacy records without a snapshot can still be estimated using available prices, and an unknown event can acquire a later manual tariff. This does not recreate historical rates or lost upstream usage.

- `reported`: provider-supplied USD amount (currently xAI ticks, with the original decimal retained).
- `estimated`: a supported token/modality tariff with its source and captured rates.
- `unknown`: no sufficient usage, inconsistent/partial usage, missing price, or unsupported billing dimensions. Cost is null, not free. The coverage ratio counts only known amounts.

Amounts are evaluated per event before summation, preserving model-specific context thresholds and additivity. Request tier is overridden by an explicit response tier. Unsupported tier/context combinations remain unknown. Claude cache creation distinguishes 5-minute and 1-hour rates; an old aggregate write count cannot reveal its lifetime. Gemini thinking and audio input, OpenAI image/text/audio/cache dimensions, and DeepSeek's documented UTC peak schedule have separate rules. Unknown cache modality splits are not guessed.

xAI video polling retains every event but charges only the increase over a previously recorded cumulative operation cost. General token estimates do not replace a provider's actual cost. Built-in API prices are estimates for OAuth/subscription usage too; they do not establish the subscription's cash charge, taxes, negotiated discounts, reseller margins, or external tool bills. Manual rates can be scoped to provider and upstream base URL.

Model matching uses exact IDs, canonical provider prefixes, and known reasoning suffixes. An unknown media variant cannot inherit its parent text model's price. Manual alias mappings remain explicit user choices. Price sync preserves the last good cache on failure and rejects catalogs older than the bundled rule baseline.

## Sources and coverage

| Source | What is accounted for | Deliberate limit |
| --- | --- | --- |
| Chat/Responses/Claude/Gemini/Interactions executors | Reported tokens, cache, thinking, tiers and available billing dimensions | Aborted streams without final usage cannot establish complete spend |
| Codex Responses HTTP and WebSocket image tools | Separate parent and image-tool events, modality-specific rates | Unpublished/missing modality data remains unknown |
| Live/realtime WebSocket | Upstream terminal response usage, including text/audio/cache | Opaque WebRTC media without usage is an unmeasured operation |
| xAI image/video | Exact reported ticks, cumulative video operation costs | No invented per-image or duration-based charge when the provider omits billing |
| Alpha Search and management model probes | Available core-reported usage | Missing usage or independently priced search tools may remain unknown |
| Desktop health probes | Complete stream consumption, bounded output request, final usage for all four protocols, partial failure records | Network/size/timeout termination can leave only partial measurements |
| Token-count/control calls | Separate unmeasured operations | Predicted tokens are not charged as consumed tokens |
| Hosted tools | Claude search and OpenAI file-search request fees when counts are present | Ambiguous OpenAI search variants, grounding, containers and unsupported tools are not silently priced as token-only work |
| Plugins/custom gateways | Published SDK usage and explicit manual tariffs | Arbitrary external traffic and unpublished plugin charges cannot be inferred |

Billing rules were checked against official sources on 2026-09-12: [OpenAI](https://developers.openai.com/api/docs/pricing), [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing), [Gemini](https://ai.google.dev/gemini-api/docs/pricing), [xAI pricing](https://docs.x.ai/developers/pricing), [xAI cost tracking](https://docs.x.ai/developers/cost-tracking), and [DeepSeek](https://api-docs.deepseek.com/quick_start/pricing/). The catalog is not a complete historical price database. DeepSeek's new schedule is not applied retrospectively before this rule baseline.

## Collection and deployment

With the companion CLIProxyAPI update, the collector reads `/v0/management/usage-journal`, commits a local SQLite inbox before acknowledging event IDs, and deduplicates replay using a unique nonempty `event_id`. A repeated `request_id` remains valid across retries/tools. The UI uses the SQLite row ID. Credentials are fingerprinted before inbox persistence, including old queue messages and direct probes.

Only a 404 enables legacy queue fallback; a journal storage/network/ACK error remains visible and is retried. A lost ACK cannot double-count a committed event. The core journal is a single-consumer local spool whose unacknowledged files do not expire. Operators must monitor storage if the collector is stopped. Disk failure, upstream omission, and events lost before upgrading cannot be fixed by deduplication.

**Release dependency:** `core-version.txt` stays at 7.2.158 until an upstream core release containing the companion fix exists. Before shipping the complete feature, publish that core release and update the pin using the project's normal release workflow. The desktop changes remain backward compatible, but legacy cores do not provide the new durability and source coverage.

## Regression validation

Native tests cover the original arithmetic reproductions, context boundaries, tier modifiers, Claude TTL, Gemini thinking/audio, image/realtime modalities, reported media cost, repeated polling, replay IDs, endpoint/transport filters, provider-specific manual rates, price snapshots, unknown usage/price dimensions, and credential redaction. Health parser tests cover final stream usage. New regressions were first observed failing, then fixed.

The complete Rust test suite, Bun test suite and TypeScript/Vite build pass locally. On macOS, use a real directory for `TMPDIR`: existing backup tests intentionally reject symlink paths such as `/var`. Their symlink cleanup now uses the correct Unix operation while retaining Windows junction handling.

## Independent review corrections

Schema migration uses an atomic savepoint and repairs partially added accounting columns. The local inbox uses SQLite `synchronous=FULL`: a durable ACK must follow a flushed WAL commit, not merely a NORMAL-mode commit that could be lost on power failure. Overview counters are populated by event kind; logical generation counts deduplicate attempts and exclude prewarms/tools/probes.

Direct health probes pass provider/base URL through IPC, preserve actual response tiers, and require a terminal response instead of treating the first text delta as proof of completeness. Error bodies are captured through the same bounded reader; aborted streams are partial. DeepSeek cache-hit and Gemini tool-input counters retain their provider semantics.

Claude's actual `usage.speed` controls Fast pricing, including standard-speed fallback. Anthropic Priority commitments have no inferred Fast tariff. Eligible OpenAI US/EU processing endpoints receive the documented regional uplift; storage-only regions do not. Unsupported regional combinations remain unknown, and manual tariffs do not receive an extra automatic uplift. Sources: [Claude Fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode), [OpenAI data residency support](https://developers.openai.com/api/docs/guides/your-data#api-endpoint-tool-and-model-support), and the pricing sources above.
