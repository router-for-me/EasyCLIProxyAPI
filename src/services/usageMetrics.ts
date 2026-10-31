type GenerationSpeedInput = {
  outputTokens: number;
  latencyMs: number;
};

type CacheReadRateInput = {
  inputTokens: number;
  cacheReadTokens: number;
};

export const calculateTokenComposition = (tokens: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}) => {
  const normalizedCount = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;
  const input = normalizedCount(tokens.inputTokens);
  const output = normalizedCount(tokens.outputTokens);
  const cacheRead = normalizedCount(tokens.cacheReadTokens);
  const cacheCreation = normalizedCount(tokens.cacheCreationTokens);
  const uncachedInput = Math.max(0, input - cacheRead - cacheCreation);
  const total = uncachedInput + cacheRead + cacheCreation + output;
  let offset = 0;
  const segments = ([
    { key: 'input', value: uncachedInput },
    { key: 'cache-read', value: cacheRead },
    { key: 'cache-creation', value: cacheCreation },
    { key: 'output', value: output },
  ] as const).map((segment) => {
    const percent = total > 0 ? segment.value / total * 100 : 0;
    const result = { ...segment, percent, offset };
    offset += percent;
    return result;
  });
  return { total, segments, cacheShare: total > 0 ? cacheRead / total * 100 : 0 };
};

export const calculateGenerationSpeed = ({
  outputTokens,
  latencyMs,
}: GenerationSpeedInput): number | null => {
  if (
    !Number.isFinite(outputTokens) ||
    !Number.isFinite(latencyMs) ||
    outputTokens <= 0 ||
    latencyMs <= 0
  ) {
    return null;
  }

  const speed = outputTokens / (latencyMs / 1_000);
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
