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

export type ChartPoint = { x: number; y: number };

const MAX_POINTS = 96;
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

function estimateBucketCount(start: Date, end: Date, bucket: TrendBucket): number {
  if (end.getTime() <= start.getTime()) return 1;
  if (bucket === '30m') {
    return Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (HOUR_MS / 2)));
  }
  if (bucket === 'hour') {
    return Math.max(1, Math.ceil((end.getTime() - start.getTime()) / HOUR_MS));
  }
  if (bucket === '3h') {
    return Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (3 * HOUR_MS)));
  }
  let count = 0;
  let cursor = startOfBucket(start, bucket);
  const limit = startOfBucket(end, bucket);
  while (cursor.getTime() <= limit.getTime() && count <= MAX_POINTS + 2) {
    count += 1;
    cursor = addBucket(cursor, bucket);
  }
  return Math.max(1, count);
}

const BUCKET_ORDER: TrendBucket[] = ['30m', 'hour', '3h', 'day', 'week', 'month', 'year'];

export function chooseTrendBucket(start: Date, end: Date): TrendBucket {
  for (const bucket of BUCKET_ORDER) {
    if (estimateBucketCount(start, end, bucket) <= MAX_POINTS) return bucket;
  }
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

export function selectTrendAxisLabels(count: number, maxLabels = 8): number[] {
  if (count <= 0) return [];
  if (count <= maxLabels) return Array.from({ length: count }, (_, index) => index);
  const last = count - 1;
  const indexes = new Set<number>([0, last]);
  const inner = maxLabels - 2;
  for (let step = 1; step <= inner; step += 1) {
    indexes.add(Math.round((last * step) / (inner + 1)));
  }
  return [...indexes].sort((left, right) => left - right);
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
  point: PreparedTrendPoint,
  bucket: TrendBucket,
  locale: string,
  options?: { compactSameDay?: boolean },
): string {
  if (bucket === '30m' || bucket === 'hour' || bucket === '3h') {
    if (options?.compactSameDay) return formatTime(point.start, locale);
    return `${formatMonthDay(point.start, locale)} ${formatTime(point.start, locale)}`;
  }
  if (bucket === 'day') return formatMonthDay(point.start, locale);
  if (bucket === 'week') return formatMonthDay(point.start, locale);
  if (bucket === 'month') return formatYearMonth(point.start, locale);
  return formatYear(point.start, locale);
}

export function formatTrendRangeLabel(
  point: PreparedTrendPoint,
  locale: string,
  bucket: TrendBucket = 'hour',
): string {
  const start = point.start;
  const end = new Date(Math.max(start.getTime(), point.end.getTime() - 1));
  if (bucket === 'year') return formatYear(start, locale);
  if (bucket === 'month') return formatYearMonth(start, locale);
  if (bucket === 'day') {
    const withYear = start.getFullYear() !== new Date().getFullYear();
    return new Intl.DateTimeFormat(locale, {
      year: withYear ? 'numeric' : undefined,
      month: 'numeric',
      day: 'numeric',
    }).format(start);
  }
  if (bucket === 'week') {
    const withYear = start.getFullYear() !== end.getFullYear();
    const formatter = new Intl.DateTimeFormat(locale, {
      year: withYear ? 'numeric' : undefined,
      month: 'numeric',
      day: 'numeric',
    });
    return `${formatter.format(start)}-${formatter.format(end)}`;
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
  const parsed = points
    .map((point) => {
      const start = parseLocalHourKey(point.hour);
      if (!start) return null;
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

  if (parsed.length === 0) {
    return { bucket: '30m', points: [], totals, peak: null, models: [] };
  }

  const rangeStart = parseRangeDate(range?.start);
  const rangeEnd = parseRangeDate(range?.end);
  const first = parsed[0].start;
  const last = parsed[parsed.length - 1].start;
  const spanStart = rangeStart
    ? new Date(Math.min(rangeStart.getTime(), first.getTime()))
    : first;
  const spanEndSource = rangeEnd ?? (rangeStart ? now : new Date(last.getTime() + HOUR_MS / 2));
  const spanEnd = new Date(Math.max(spanEndSource.getTime(), last.getTime() + HOUR_MS / 2));

  const bucket = chooseTrendBucket(spanStart, spanEnd);
  const seriesStart = startOfBucket(spanStart, bucket);
  const seriesEnd = startOfBucket(new Date(Math.max(spanEnd.getTime() - 1, seriesStart.getTime())), bucket);

  const buckets = new Map<number, PreparedTrendPoint>();
  let cursor = cloneDate(seriesStart);
  let guard = 0;
  while (cursor.getTime() <= seriesEnd.getTime() && guard <= 400) {
    buckets.set(cursor.getTime(), emptyPoint(cloneDate(cursor), bucket));
    cursor = addBucket(cursor, bucket);
    guard += 1;
  }

  for (const point of parsed) {
    const key = startOfBucket(point.start, bucket).getTime();
    const current = buckets.get(key) ?? emptyPoint(startOfBucket(point.start, bucket), bucket);
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

  const series = [...buckets.values()].sort((left, right) => left.start.getTime() - right.start.getTime());
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

function monotoneTangents(points: ChartPoint[]): number[] {
  const count = points.length;
  const delta = Array.from({ length: Math.max(0, count - 1) }, () => 0);
  const tangent = Array.from({ length: count }, () => 0);
  for (let index = 0; index < count - 1; index += 1) {
    const dx = points[index + 1].x - points[index].x;
    delta[index] = dx === 0 ? 0 : (points[index + 1].y - points[index].y) / dx;
  }
  if (count > 0) tangent[0] = delta[0] ?? 0;
  if (count > 1) tangent[count - 1] = delta[count - 2] ?? 0;
  for (let index = 1; index < count - 1; index += 1) {
    tangent[index] = delta[index - 1] * delta[index] <= 0 ? 0 : (delta[index - 1] + delta[index]) / 2;
  }
  for (let index = 0; index < count - 1; index += 1) {
    if (delta[index] === 0) {
      tangent[index] = 0;
      tangent[index + 1] = 0;
      continue;
    }
    const alpha = tangent[index] / delta[index];
    const beta = tangent[index + 1] / delta[index];
    const square = alpha * alpha + beta * beta;
    if (square > 9) {
      const scale = 3 / Math.sqrt(square);
      tangent[index] = scale * alpha * delta[index];
      tangent[index + 1] = scale * beta * delta[index];
    }
  }
  return tangent;
}

export function smoothLinePath(points: ChartPoint[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  if (points.length === 2) {
    return `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)} L ${points[1].x.toFixed(2)} ${points[1].y.toFixed(2)}`;
  }
  const tangent = monotoneTangents(points);
  let path = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const dx = (end.x - start.x) / 3;
    path += ` C ${(start.x + dx).toFixed(2)} ${(start.y + tangent[index] * dx).toFixed(2)} ${(end.x - dx).toFixed(2)} ${(end.y - tangent[index + 1] * dx).toFixed(2)} ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
  }
  return path;
}

export function smoothAreaPath(top: ChartPoint[], bottom: ChartPoint[]): string {
  if (!top.length || top.length !== bottom.length) return '';
  const topPath = smoothLinePath(top);
  const bottomPath = smoothLinePath([...bottom].reverse());
  if (!topPath || !bottomPath) return '';
  return `${topPath} ${bottomPath.replace(/^M /, 'L ')} Z`;
}

export const OTHER_TREND_MODEL_KEY = OTHER_MODEL_KEY;
