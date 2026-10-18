const REASONING_TIER_SUFFIXES = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

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

export function isModelSubstituted(requested: string, served: string): boolean {
  const req = normalizeModelName(requested);
  const srv = normalizeModelName(served);
  if (!req || !srv || req === srv) return false;
  if (isDatedModelAlias(req, srv) || isDatedModelAlias(srv, req)) return false;
  if (isReasoningTierAlias(srv, req)) return false;
  if (isBuildProxyAlias(req, srv)) return false;
  return true;
}

/** Match CPA-Manager-Plus request monitoring: compare the response with the routed model. */
export function usageModelDetails(model: string, alias = '', response = '') {
  const resolved = model.trim();
  const requested = alias.trim() || resolved || '—';
  const responseModel = response.trim();
  return {
    requested,
    resolved,
    response: responseModel,
    showResolved: Boolean(resolved && resolved !== requested),
    mismatch: Boolean(responseModel && resolved && isModelSubstituted(resolved, responseModel)),
    showResponseInTooltip: Boolean(responseModel && (!resolved || responseModel !== resolved)),
  };
}
