/** Match CPA-Manager-Plus request monitoring: compare the response with the routed model. */
export function usageModelDetails(model: string, alias = '', response = '') {
  const resolved = model.trim();
  const requested = alias.trim() || resolved || '—';
  const responseModel = response.trim();
  return {
    requested, resolved, response: responseModel,
    showResolved: Boolean(resolved && resolved !== requested),
    mismatch: Boolean(responseModel && resolved && responseModel !== resolved),
    showResponseInTooltip: Boolean(responseModel && (!resolved || responseModel !== resolved)),
  };
}
