type GenerationSpeedInput = {
  outputTokens: number;
  latencyMs: number;
  ttftMs: number | null;
};

type CacheReadRateInput = {
  inputTokens: number;
  cacheReadTokens: number;
};

export const calculateGenerationSpeed = ({
  outputTokens,
  latencyMs,
  ttftMs,
}: GenerationSpeedInput): number | null => {
  if (
    !Number.isFinite(outputTokens) ||
    !Number.isFinite(latencyMs) ||
    ttftMs === null ||
    !Number.isFinite(ttftMs) ||
    outputTokens <= 0 ||
    ttftMs <= 0 ||
    latencyMs <= ttftMs
  ) {
    return null;
  }

  const speed = outputTokens / ((latencyMs - ttftMs) / 1_000);
  return Number.isFinite(speed) && speed > 0 ? speed : null;
};

export const formatGenerationSpeed = (input: GenerationSpeedInput): string => {
  const speed = calculateGenerationSpeed(input);
  return speed === null ? '—' : `${speed.toFixed(1)} t/s`;
};

export const calculateCacheReadRate = ({
  inputTokens,
  cacheReadTokens,
}: CacheReadRateInput): number | null => {
  if (!Number.isFinite(inputTokens) || !Number.isFinite(cacheReadTokens) || inputTokens <= 0) {
    return null;
  }

  const normalizedCacheReadTokens = Math.max(cacheReadTokens, 0);
  return (Math.min(normalizedCacheReadTokens, inputTokens) / inputTokens) * 100;
};

export const formatCacheReadRate = (input: CacheReadRateInput): string => {
  const rate = calculateCacheReadRate(input);
  return rate === null ? '—' : `${rate.toFixed(2)}%`;
};
