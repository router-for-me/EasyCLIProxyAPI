export type GenerationSpeedMode = 'total' | 'ttft';

export type GenerationSpeedInput = {
  outputTokens: number;
  latencyMs: number;
  ttftMs?: number | null;
  mode?: GenerationSpeedMode;
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

/** Least output tokens a request must have to tell a generation speed by. */
export const SPEED_MIN_OUTPUT_TOKENS = 100;

/** Least generation window (latency - TTFT) a request must have: below it the
 *  elapsed time is a transport burst, not writing. Same rule as cc-switch and
 *  cockpit-tools. */
export const SPEED_MIN_GENERATION_MS = 100;

export const calculateGenerationSpeed = ({
  outputTokens,
  latencyMs,
  ttftMs,
  mode = 'total',
}: GenerationSpeedInput): number | null => {
  if (
    !Number.isFinite(outputTokens) ||
    !Number.isFinite(latencyMs) ||
    outputTokens < SPEED_MIN_OUTPUT_TOKENS ||
    latencyMs <= 0
  ) {
    return null;
  }

  const durationMs =
    mode === 'ttft' && ttftMs != null && Number.isFinite(ttftMs) && ttftMs > 0 && latencyMs > ttftMs
      ? latencyMs - ttftMs
      : latencyMs;

  if (mode === 'ttft' && durationMs < SPEED_MIN_GENERATION_MS) {
    return null;
  }

  const speed = outputTokens / (durationMs / 1_000);
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
  return rate === null ? '—' : rate.toFixed(2) + '%';
};