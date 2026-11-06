// `-max` and `-ultra` also name distinct models (for example `gpt-5.1-codex-max`),
// so only plain effort suffixes count as the same model at another reasoning tier.
const REASONING_TIER_SUFFIXES = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);
const SPEED_SUFFIX_RE = /-(?:ultrafast|fast)$/i;
const EFFORT_SUFFIX_RE = /-(none|off|minimal|low|medium|high|xhigh|max|ultra|auto)$/i;

export function inferReasoningEffortFromModelName(name: string): string {
  const withoutSpeed = name.trim().replace(SPEED_SUFFIX_RE, '');
  const match = withoutSpeed.match(EFFORT_SUFFIX_RE);
  return match ? match[1].toLowerCase() : '';
}

function normalizeModelName(model: string): string {
  const trimmed = model.trim().toLowerCase();
  const withoutThinking = trimmed.replace(/\([^()]*\)$/, '').trim();
  const slashIndex = withoutThinking.lastIndexOf('/');
  const withoutPrefix =
    slashIndex >= 0 && slashIndex < withoutThinking.length - 1
      ? withoutThinking.slice(slashIndex + 1)
      : withoutThinking;
  return withoutPrefix.replace(/-latest$/, '');
}

function isDatedModelAlias(base: string, dated: string): boolean {
  const prefix = `${base}-`;
  if (!dated.startsWith(prefix)) return false;
  const suffix = dated.slice(prefix.length);
  return /^\d{4}-\d{2}-\d{2}$/.test(suffix) || /^\d{8}$/.test(suffix) || /^\d{3}$/.test(suffix);
}

function isReasoningTierAlias(base: string, tiered: string): boolean {
  const prefix = `${base}-`;
  if (!tiered.startsWith(prefix)) return false;
  return REASONING_TIER_SUFFIXES.has(tiered.slice(prefix.length));
}

function isBuildProxyAlias(base: string, served: string): boolean {
  return served === `${base}-build`;
}

// Follows the core's IsModelSubstituted (provider prefixes, -latest, dated pins) and also
// accepts a base-model answer (including Antigravity -n variants) to a reasoning-tier request
// and a -build variant answer.
function isModelSubstituted(requested: string, served: string): boolean {
  const req = normalizeModelName(requested);
  const srv = normalizeModelName(served);
  if (!req || !srv || req === srv) return false;
  const srvBase = srv.endsWith('-n') ? srv.slice(0, -2) : srv;
  if (srvBase && (req === srvBase || isReasoningTierAlias(srvBase, req))) return false;
  if (isDatedModelAlias(req, srv) || isDatedModelAlias(srv, req)) return false;
  if (isReasoningTierAlias(srv, req)) return false;
  if (isBuildProxyAlias(req, srv)) return false;
  return true;
}

/** Match CPA-Manager-Plus request monitoring: compare the response with the routed model. */
export function usageModelDetails(model: string, alias = '', response = '', reasoningEffort = '') {
  const resolved = model.trim();
  const trimmedAlias = alias.trim();
  const requested = trimmedAlias || resolved || '—';
  const responseModel = response.trim();
  const explicitEffort = reasoningEffort.trim();
  const effort = explicitEffort
    || inferReasoningEffortFromModelName(trimmedAlias)
    || inferReasoningEffortFromModelName(resolved);
  return {
    requested, resolved, response: responseModel, effort,
    showResolved: Boolean(resolved && resolved !== requested),
    mismatch: Boolean(responseModel && resolved && isModelSubstituted(resolved, responseModel)),
    showResponseInTooltip: Boolean(responseModel && (!resolved || responseModel !== resolved)),
  };
}
