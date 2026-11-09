import { usagePreferences } from './usagePreferences';

export type GenerationSpeedMode = 'total' | 'ttft';

export const EVENT_SPEED_MODE_KEY = 'cpa-gui.usage-events-speed-mode.v1';

export const getSpeedMode = (): GenerationSpeedMode =>
  usagePreferences.getItem(EVENT_SPEED_MODE_KEY) === 'ttft' ? 'ttft' : 'total';

export const setSpeedMode = (mode: GenerationSpeedMode): void => {
  usagePreferences.setItem(EVENT_SPEED_MODE_KEY, mode);
};

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

/** Require a 100 ms TTFT-subtracted window to guard against transport bursts. */
export const SPEED_MIN_GENERATION_MS = 100;

/** Speed eligibility matches keeper: positive output and latency, plus a positive
 * TTFT below latency in ttft mode. The default is the total/end-to-end window
 * covering the whole request latency; ttft mode is opt-in and additionally
 * applies a 100 ms floor on the TTFT-subtracted window to guard against
 * transport bursts. Neither mode has a minimum output-token count. */
export const calculateGenerationSpeed = ({
  outputTokens,
  latencyMs,
  ttftMs,
  mode = 'total',
}: GenerationSpeedInput): number | null => {
  if (
    !Number.isFinite(outputTokens) ||
    !Number.isFinite(latencyMs) ||
    outputTokens <= 0 ||
    latencyMs <= 0
  ) {
    return null;
  }

  let durationMs = latencyMs;
  if (mode === 'ttft') {
    if (ttftMs == null || !Number.isFinite(ttftMs) || ttftMs <= 0 || ttftMs >= latencyMs) {
      return null;
    }
    durationMs = latencyMs - ttftMs;
    if (durationMs < SPEED_MIN_GENERATION_MS) return null;
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