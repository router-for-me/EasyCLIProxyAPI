/** Keep the requested and reported tiers separate: a badge is not a billing confirmation. */
export function usageServiceTierDetails(requested?: string | null, response?: string | null) {
  const requestedTier = requested?.trim() || '';
  const responseTier = response?.trim() || '';
  const normalized = requestedTier.toLowerCase();
  const badge = normalized === 'ultrafast'
    ? 'ultrafast'
    : normalized === 'priority' || normalized === 'fast' ? 'fast' : null;

  return { requested: requestedTier, response: responseTier, badge };
}
