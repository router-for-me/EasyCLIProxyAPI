export type UsageTimelineModel = {
  key: string;
  label: string;
  tokens: number;
  requests?: number;
};

export type UsageTimelinePoint = {
  hour: string;
  requests: number;
  success: number;
  failure: number;
  canceled: number;
  tokens: number;
  models?: UsageTimelineModel[];
};

export type TrendBucket = '30m' | 'hour' | '3h' | 'day' | 'week' | 'month' | 'year';

export type PreparedTrendPoint = {
  hour: string;
  requests: number;
  success: number;
  failure: number;
  canceled: number;
  tokens: number;
  models: Record<string, number>;
  start: Date;
  end: Date;
};

export type PreparedTrendModel = {
  key: string;
  label: string;
  tokens: number;
  color: string;
};

export type PreparedTrendSeries = {
  bucket: TrendBucket;
  points: PreparedTrendPoint[];
  totals: {
    requests: number;
    tokens: number;
    failures: number;
    success: number;
    canceled: number;
  };
  peak: PreparedTrendPoint | null;
  models: PreparedTrendModel[];
};

const MAX_VISIBLE_MODELS = 6;
const OTHER_MODEL_KEY = '__other__';
const HOUR_MS = 60 * 60 * 1000;
const MODEL_COLORS = [
  '#3b82f6',
  '#10b981',
  '#8b5cf6',
  '#f59e0b',
  '#ec4899',
  '#06b6d4',
];

export function parseLocalHourKey(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(?:-(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  if (
    !Number.isInteger(year)
    || !Number.isInteger(month)
    || !Number.isInteger(day)
    || !Number.isInteger(hour)
    || !Number.isInteger(minute)
    || month < 1
    || month > 12
    || day < 1
    || day > 31
    || hour < 0
    || hour > 23
    || minute < 0
    || minute > 59
  ) {
    return null;
  }
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
    || date.getHours() !== hour
    || date.getMinutes() !== minute
  ) {
    return null;
  }
  return date;
}

export function formatLocalHourKey(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}-${hour}-${minute}`;
}

function parseRangeDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function cloneDate(date: Date): Date {
  return new Date(date.getTime());
}

export function startOfBucket(date: Date, bucket: TrendBucket): Date {
  const next = cloneDate(date);
  next.setSeconds(0, 0);
  if (bucket === '30m') {
    next.setMinutes(next.getMinutes() < 30 ? 0 : 30, 0, 0);
    return next;
  }
  next.setMinutes(0, 0, 0);
  if (bucket === 'hour') return next;
  if (bucket === '3h') {
    next.setHours(Math.floor(next.getHours() / 3) * 3);
    return next;
  }
  next.setHours(0, 0, 0, 0);
  if (bucket === 'day') return next;
  if (bucket === 'week') {
    const weekday = next.getDay();
    const offset = weekday === 0 ? -6 : 1 - weekday;
    next.setDate(next.getDate() + offset);
    return next;
  }
  next.setDate(1);
  if (bucket === 'month') return next;
  next.setMonth(0, 1);
  return next;
}

export function addBucket(date: Date, bucket: TrendBucket): Date {
  const next = cloneDate(date);
  if (bucket === '30m') {
    next.setMinutes(next.getMinutes() + 30);
    return next;
  }
  if (bucket === 'hour') {
    next.setHours(next.getHours() + 1);
    return next;
  }
  if (bucket === '3h') {
    next.setHours(next.getHours() + 3);
    return next;
  }
  if (bucket === 'day') {
    next.setDate(next.getDate() + 1);
    return next;
  }
  if (bucket === 'week') {
    next.setDate(next.getDate() + 7);
    return next;
  }
  if (bucket === 'month') {
    next.setMonth(next.getMonth() + 1);
    return next;
  }
  next.setFullYear(next.getFullYear() + 1);
  return next;
}

export function endOfBucket(start: Date, bucket: TrendBucket): Date {
  return addBucket(start, bucket);
}

export function chooseTrendBucket(start: Date, end: Date): TrendBucket {
  const hours = Math.max(0, end.getTime() - start.getTime()) / HOUR_MS;
  if (hours <= 6) return '30m';
  if (hours <= 48) return 'hour';
  if (hours <= 72) return '3h';
  if (hours <= 24 * 90) return 'day';
  if (hours <= 24 * 366 * 2) return 'week';
  if (hours <= 24 * 366 * 10) return 'month';
  return 'year';
}

function emptyTotals() {
  return { requests: 0, tokens: 0, failures: 0, success: 0, canceled: 0 };
}

function addTotals(
  target: ReturnType<typeof emptyTotals>,
  point: Pick<UsageTimelinePoint, 'requests' | 'tokens' | 'failure' | 'success' | 'canceled'>,
) {
  target.requests += point.requests;
  target.tokens += point.tokens;
  target.failures += point.failure;
  target.success += point.success;
  target.canceled += point.canceled;
}

function emptyPoint(start: Date, bucket: TrendBucket): PreparedTrendPoint {
  return {
    hour: formatLocalHourKey(start),
    requests: 0,
    success: 0,
    failure: 0,
    canceled: 0,
    tokens: 0,
    models: {},
    start,
    end: endOfBucket(start, bucket),
  };
}

function modelColor(index: number, key: string): string {
  if (key === OTHER_MODEL_KEY) return '#64748b';
  return MODEL_COLORS[index % MODEL_COLORS.length];
}

export function niceCeiling(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const magnitude = 10 ** exponent;
  const normalized = value / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

export function trendAxisTicks(max: number, targetCount = 5): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0, 1];
  const parts = Math.max(2, Math.round(targetCount));
  if (Number.isInteger(max) && max <= parts) {
    return Array.from({ length: max + 1 }, (_, index) => index);
  }
  const rawStep = max / parts;
  const exponent = Math.floor(Math.log10(rawStep));
  const magnitude = 10 ** exponent;
  const normalized = rawStep / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const step = nice * magnitude;
  const ticks: number[] = [];
  for (let value = 0; value < max && ticks.length < 12; value += step) {
    ticks.push(Number.isInteger(value) ? value : Number(value.toFixed(6)));
  }
  if (ticks[ticks.length - 1] !== max) ticks.push(max);
  return ticks;
}

export function trendTimePosition(date: Date, start: Date, end: Date): number {
  const span = end.getTime() - start.getTime();
  if (span <= 0) return 0;
  return Math.max(0, Math.min(1, (date.getTime() - start.getTime()) / span));
}

export function trendTimeAxisTicks(start: Date, end: Date, width: number, labelWidth = 88): Date[] {
  const span = end.getTime() - start.getTime();
  if (span <= 0) return [start];
  // Choose a readable time interval from the selected duration and available space.
  const minStep = span * labelWidth / Math.max(labelWidth, width);
  const steps = [1 / 60, 5 / 60, 15 / 60, 0.5, 1, 2, 3, 6, 12, 24, 48, 72, 168, 336, 720, 2160, 4380, 8760];
  const step = steps.map((hours) => hours * HOUR_MS).find((value) => value >= minStep)
    ?? niceCeiling(minStep / (8760 * HOUR_MS)) * 8760 * HOUR_MS;
  const ticks = [start];
  const monthStep = step >= 720 * HOUR_MS ? Math.max(1, Math.round(step / (730 * HOUR_MS))) : 0;
  let cursor = monthStep ? startOfBucket(start, 'month') : start;
  while (true) {
    cursor = cloneDate(cursor);
    if (monthStep) cursor.setMonth(cursor.getMonth() + monthStep);
    else cursor.setTime(cursor.getTime() + step);
    if (cursor.getTime() > end.getTime() - minStep) break;
    if (cursor.getTime() >= start.getTime() + minStep) ticks.push(cursor);
  }
  ticks.push(end);
  return ticks;
}

export function findTrendPointIndex(points: PreparedTrendPoint[], time: Date): number {
  if (!points.length) return -1;
  const index = points.findIndex((point) => time.getTime() < point.end.getTime());
  return index < 0 ? points.length - 1 : index;
}

function sameCalendarDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate()
  );
}

function formatTime(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date);
}

function formatMonthDay(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' }).format(date);
}

function formatYearMonth(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short' }).format(date);
}

function formatYear(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { year: 'numeric' }).format(date);
}

export function formatTrendAxisLabel(
  point: Pick<PreparedTrendPoint, 'start'>,
  bucket: TrendBucket,
  locale: string,
  options?: { compactSameDay?: boolean; showTime?: boolean },
): string {
  if (options?.showTime || bucket === '30m' || bucket === 'hour' || bucket === '3h') {
    if (options?.compactSameDay) return formatTime(point.start, locale);
    return `${formatMonthDay(point.start, locale)} ${formatTime(point.start, locale)}`;
  }
  if (bucket === 'day') return formatMonthDay(point.start, locale);
  if (bucket === 'week') return formatMonthDay(point.start, locale);
  if (bucket === 'month') return formatYearMonth(point.start, locale);
  return formatYear(point.start, locale);
}

export function formatTrendRangeLabel(
  point: Pick<PreparedTrendPoint, 'start' | 'end'>,
  locale: string,
  bucket: TrendBucket = 'hour',
): string {
  const start = point.start;
  const end = point.end;
  const completeBucket = start.getTime() === startOfBucket(start, bucket).getTime()
    && end.getTime() === endOfBucket(start, bucket).getTime();
  if (bucket === 'year' && completeBucket) return formatYear(start, locale);
  if (bucket === 'month' && completeBucket) return formatYearMonth(start, locale);
  if (bucket === 'day' && completeBucket) {
    const withYear = start.getFullYear() !== new Date().getFullYear();
    return new Intl.DateTimeFormat(locale, {
      year: withYear ? 'numeric' : undefined,
      month: 'numeric',
      day: 'numeric',
    }).format(start);
  }
  if (bucket === 'week' && completeBucket) {
    const lastDay = new Date(end.getTime() - 1);
    const withYear = start.getFullYear() !== lastDay.getFullYear();
    const formatter = new Intl.DateTimeFormat(locale, {
      year: withYear ? 'numeric' : undefined,
      month: 'numeric',
      day: 'numeric',
    });
    return `${formatter.format(start)}-${formatter.format(lastDay)}`;
  }
  const sameDay = sameCalendarDay(start, end);
  const dayPart = formatMonthDay(start, locale);
  if (sameDay) return `${dayPart} ${formatTime(start, locale)}-${formatTime(end, locale)}`;
  return `${dayPart} ${formatTime(start, locale)}-${formatMonthDay(end, locale)} ${formatTime(end, locale)}`;
}

function addModelTokens(target: Record<string, number>, key: string, tokens: number) {
  if (!key || tokens <= 0) return;
  target[key] = (target[key] ?? 0) + tokens;
}

export function buildUsageTrendSeries(
  points: UsageTimelinePoint[],
  range?: { start?: string; end?: string },
  now = new Date(),
): PreparedTrendSeries {
  const labels = new Map<string, string>();
  const rangeStart = parseRangeDate(range?.start);
  const rangeEnd = parseRangeDate(range?.end);
  const parsed = points
    .map((point) => {
      const start = parseLocalHourKey(point.hour);
      if (!start) return null;
      // The backend filters requests before grouping them into half-hour slots.
      // Keep the partial slot overlapping the start, and the inclusive end slot.
      if (rangeStart && addBucket(start, '30m').getTime() <= rangeStart.getTime()) return null;
      if (rangeEnd && start.getTime() > rangeEnd.getTime()) return null;
      const models: Record<string, number> = {};
      for (const model of point.models ?? []) {
        const key = (model.key || model.label || '').trim() || 'unknown';
        const label = (model.label || model.key || key).trim() || key;
        labels.set(key, label);
        addModelTokens(models, key, Math.max(0, model.tokens || 0));
      }
      const tokens = Math.max(0, point.tokens || 0);
      const namedTokens = Object.values(models).reduce((sum, value) => sum + value, 0);
      if (tokens > namedTokens) addModelTokens(models, 'unknown', tokens - namedTokens);
      if (!Object.keys(models).length && tokens > 0) addModelTokens(models, 'unknown', tokens);
      return {
        hour: point.hour,
        requests: Math.max(0, point.requests || 0),
        success: Math.max(0, point.success || 0),
        failure: Math.max(0, point.failure || 0),
        canceled: Math.max(0, point.canceled || 0),
        tokens,
        models,
        start,
      };
    })
    .filter((point): point is UsageTimelinePoint & { start: Date; models: Record<string, number> } => point !== null)
    .sort((left, right) => left.start.getTime() - right.start.getTime());

  const totals = emptyTotals();
  const modelTotals = new Map<string, number>();
  for (const point of parsed) {
    addTotals(totals, point);
    for (const [key, tokens] of Object.entries(point.models)) {
      modelTotals.set(key, (modelTotals.get(key) ?? 0) + tokens);
    }
  }

  if (parsed.length === 0 && !rangeStart) {
    return { bucket: '30m', points: [], totals, peak: null, models: [] };
  }

  const first = parsed[0]?.start ?? rangeStart!;
  const last = parsed[parsed.length - 1]?.start ?? first;
  const spanStart = rangeStart ?? first;
  const spanEnd = rangeEnd ?? (rangeStart ? now : addBucket(last, '30m'));
  if (spanEnd.getTime() <= spanStart.getTime()) {
    return { bucket: '30m', points: [], totals: emptyTotals(), peak: null, models: [] };
  }

  const bucket = chooseTrendBucket(spanStart, spanEnd);
  const seriesStart = startOfBucket(spanStart, bucket);
  const seriesEnd = startOfBucket(new Date(Math.max(spanEnd.getTime() - 1, seriesStart.getTime())), bucket);

  const buckets = new Map<number, PreparedTrendPoint>();
  let cursor = cloneDate(seriesStart);
  while (cursor.getTime() <= seriesEnd.getTime()) {
    buckets.set(cursor.getTime(), emptyPoint(cloneDate(cursor), bucket));
    cursor = addBucket(cursor, bucket);
  }

  for (const point of parsed) {
    const time = new Date(Math.max(spanStart.getTime(), Math.min(point.start.getTime(), spanEnd.getTime() - 1)));
    const key = startOfBucket(time, bucket).getTime();
    const current = buckets.get(key)!;
    current.requests += point.requests;
    current.success += point.success;
    current.failure += point.failure;
    current.canceled += point.canceled;
    current.tokens += point.tokens;
    for (const [modelKey, tokens] of Object.entries(point.models)) {
      addModelTokens(current.models, modelKey, tokens);
    }
    buckets.set(key, current);
  }

  const series = [...buckets.values()].map((point) => ({
    ...point,
    start: new Date(Math.max(point.start.getTime(), spanStart.getTime())),
    end: new Date(Math.min(point.end.getTime(), spanEnd.getTime())),
  }));
  const ranked = [...modelTotals.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const visible = ranked.slice(0, MAX_VISIBLE_MODELS);
  const rest = ranked.slice(MAX_VISIBLE_MODELS);
  const models: PreparedTrendModel[] = visible.map(([key, tokens], index) => ({
    key,
    label: labels.get(key) ?? key,
    tokens,
    color: modelColor(index, key),
  }));
  if (rest.length) {
    models.push({
      key: OTHER_MODEL_KEY,
      label: OTHER_MODEL_KEY,
      tokens: rest.reduce((sum, [, tokens]) => sum + tokens, 0),
      color: modelColor(models.length, OTHER_MODEL_KEY),
    });
  }
  const peak = series.reduce<PreparedTrendPoint | null>((best, point) => {
    if (point.tokens <= 0) return best;
    if (!best || point.tokens > best.tokens) return point;
    return best;
  }, null);

  return { bucket, points: series, totals, peak, models };
}

export function stackModelTokens(
  point: PreparedTrendPoint,
  models: PreparedTrendModel[],
  hiddenKeys: ReadonlySet<string> = new Set(),
): Array<{ key: string; tokens: number; y0: number; y1: number }> {
  const visible = models.filter((model) => !hiddenKeys.has(model.key));
  const rankedKeys = new Set(models.filter((model) => model.key !== OTHER_MODEL_KEY).map((model) => model.key));
  let cursor = 0;
  return visible.map((model) => {
    const tokens = model.key === OTHER_MODEL_KEY
      ? Object.entries(point.models).reduce((sum, [key, value]) => (rankedKeys.has(key) ? sum : sum + value), 0)
      : point.models[model.key] ?? 0;
    const y0 = cursor;
    cursor += tokens;
    return { key: model.key, tokens, y0, y1: cursor };
  });
}

export const OTHER_TREND_MODEL_KEY = OTHER_MODEL_KEY;
