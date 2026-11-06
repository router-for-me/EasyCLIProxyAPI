import type {
  AgentUsageBucketRow,
  AgentUsageCalendarRow,
  AgentUsageHourRow,
  AgentUsageSource,
  AgentUsageTotals,
} from './agentUsage';

export type AgentUsageMetric = 'totalTokens' | 'costUSD';

export type AgentUsageStackInput = {
  key: string;
  label: string;
  rows: AgentUsageBucketRow[];
};

export type AgentUsageStackPoint = {
  bucket: string;
  total: number;
  segments: { key: string; value: number }[];
};

export type AgentUsageStack = {
  keys: string[];
  points: AgentUsageStackPoint[];
  max: number;
};

export type AgentUsageCalendarCell = {
  date: string;
  value: number;
};

export type AgentUsageTokenStructureRow = {
  bucket: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  cacheHitRate: number;
};

export type AgentUsageModelRank = {
  model: string;
  totalTokens: number;
  costUSD: number;
  priced: boolean;
  sources: string[];
};

const OTHER_KEY = '__other__';

export function buildStackedSeries(
  inputs: AgentUsageStackInput[],
  metric: AgentUsageMetric,
  baseBuckets: string[] = [],
  limit = 6,
): AgentUsageStack {
  const totals = inputs.map((input) => ({
    input,
    total: input.rows.reduce((sum, row) => sum + Math.max(0, row[metric]), 0),
  }));
  const ranked = [...totals].sort((left, right) => right.total - left.total);
  const kept = new Set(ranked.slice(0, limit).map((entry) => entry.input.key));
  const keys = ranked.filter((entry) => kept.has(entry.input.key)).map((entry) => entry.input.key);
  const hasOther = ranked.length > keys.length;
  if (hasOther) keys.push(OTHER_KEY);

  const buckets = new Set<string>(baseBuckets);
  inputs.forEach((input) => input.rows.forEach((row) => buckets.add(row.bucket)));
  const points: AgentUsageStackPoint[] = [...buckets].sort().map((bucket) => {
    const segments = inputs.map((input) => {
      const key = kept.has(input.key) ? input.key : OTHER_KEY;
      const value = input.rows
        .filter((candidate) => candidate.bucket === bucket)
        .reduce((sum, row) => sum + Math.max(0, row[metric]), 0);
      return { key, value };
    });
    const merged = new Map<string, number>();
    segments.forEach((segment) => {
      merged.set(segment.key, (merged.get(segment.key) ?? 0) + segment.value);
    });
    const ordered = keys.map((key) => ({ key, value: merged.get(key) ?? 0 }));
    return {
      bucket,
      total: ordered.reduce((sum, segment) => sum + segment.value, 0),
      segments: ordered,
    };
  });
  return {
    keys,
    points,
    max: points.reduce((value, point) => Math.max(value, point.total), 0),
  };
}

export function buildCalendarGrid(
  rows: AgentUsageCalendarRow[],
  endDate: string,
  days: number,
): AgentUsageCalendarCell[][] {
  const byDate = new Map(rows.map((row) => [row.date, row.totalTokens]));
  const end = new Date(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(end.getTime())) return [];
  const weeks: AgentUsageCalendarCell[][] = [];
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const offset = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - offset);
  for (let cursor = new Date(start); cursor <= end;) {
    const week: AgentUsageCalendarCell[] = [];
    for (let day = 0; day < 7; day += 1) {
      const date = cursor.toISOString().slice(0, 10);
      week.push({ date, value: cursor > end ? 0 : byDate.get(date) ?? 0 });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}

export function calendarSpanDays(firstDate: string, endDate: string, columns: number): number {
  const end = Date.parse(`${endDate}T00:00:00Z`);
  const first = Date.parse(`${firstDate}T00:00:00Z`);
  const history = Number.isFinite(first) && first <= end ? Math.round((end - first) / 86_400_000) + 1 : 1;
  const lastWeekDays = (new Date(end).getUTCDay() + 6) % 7 + 1;
  return Math.max(history, Math.max(0, columns - 1) * 7 + lastWeekDays);
}

export function calendarMinColumns(firstDate: string, endDate: string, floor = 8, cap = 26): number {
  const weeks = Math.ceil(calendarSpanDays(firstDate, endDate, 0) / 7) + 1;
  return Math.min(cap, Math.max(floor, weeks));
}

export function calendarMonthStarts(grid: AgentUsageCalendarCell[][], endDate: string): (string | null)[] {
  return grid.map((week) => week.find((day) => day.date.endsWith('-01') && day.date <= endDate)?.date ?? null);
}

export function buildHourGrid(rows: AgentUsageHourRow[]): number[][] {
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  rows.forEach((row) => {
    const weekday = Math.min(6, Math.max(0, Math.trunc(row.weekday)));
    const hour = Math.min(23, Math.max(0, Math.trunc(row.hour)));
    grid[weekday][hour] += Math.max(0, row.totalTokens);
  });
  return grid;
}

export function buildTokenStructure(rows: AgentUsageBucketRow[]): AgentUsageTokenStructureRow[] {
  return rows.map((row) => {
    const prompt = row.inputTokens + row.cacheReadTokens + row.cacheCreationTokens;
    return {
      bucket: row.bucket,
      input: Math.max(0, row.inputTokens),
      output: Math.max(0, row.outputTokens),
      cacheRead: Math.max(0, row.cacheReadTokens),
      cacheCreation: Math.max(0, row.cacheCreationTokens),
      cacheHitRate: prompt > 0 ? Math.max(0, row.cacheReadTokens) / prompt : 0,
    };
  });
}

export function buildModelRanking(sources: AgentUsageSource[]): AgentUsageModelRank[] {
  const models = new Map<string, AgentUsageModelRank>();
  sources.forEach((source) => {
    source.models.forEach((row) => {
      const key = row.model.trim();
      if (row.totalTokens <= 0) return;
      const current = models.get(key) ?? { model: key, totalTokens: 0, costUSD: 0, priced: false, sources: [] };
      current.totalTokens += Math.max(0, row.totalTokens);
      current.costUSD += Math.max(0, row.costUSD);
      current.priced = current.priced || row.priced;
      if (!current.sources.includes(source.source)) current.sources.push(source.source);
      models.set(key, current);
    });
  });
  return [...models.values()]
    .sort((left, right) => right.totalTokens - left.totalTokens || left.model.localeCompare(right.model));
}

export function periodChange(current: number, previous: number): number | null {
  if (!(previous > 0)) return null;
  return (current - previous) / previous;
}

export function cacheHitRate(totals: AgentUsageTotals): number {
  const prompt = totals.inputTokens + totals.cacheReadTokens + totals.cacheCreationTokens;
  return prompt > 0 ? totals.cacheReadTokens / prompt : 0;
}

export function peakValue(values: number[]): number {
  return values.reduce((value, current) => Math.max(value, current), 0);
}

export function shareOf(value: number, total: number): number {
  return total > 0 ? Math.max(0, Math.min(1, value / total)) : 0;
}

export function sparklinePoints(values: number[], width: number, height: number): string {
  if (!values.length) return '';
  const peak = peakValue(values);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  return values.map((value, index) => {
    const x = values.length > 1 ? index * step : width / 2;
    const y = peak > 0 ? height - (Math.max(0, value) / peak) * height : height;
    return `${Number(x.toFixed(2))},${Number(y.toFixed(2))}`;
  }).join(' ');
}

export function slotIndexAt(x: number, left: number, plotWidth: number, count: number): number | null {
  if (count <= 0 || plotWidth <= 0 || x < left || x > left + plotWidth) return null;
  return Math.min(count - 1, Math.floor(((x - left) / plotWidth) * count));
}

export function labelStep(count: number, plotWidth: number, spacing: number): number {
  const fit = Math.max(1, Math.floor(plotWidth / Math.max(1, spacing)));
  return Math.max(1, Math.ceil(count / fit));
}

export function axisLabelWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    width += char === '.' || char === ',' || char === ' ' ? 3.5 : code > 0x7f ? 11.5 : 7;
  }
  return Math.ceil(width);
}

export function axisGutter(labels: string[], minimum: number, padding: number): number {
  const widest = labels.reduce((max, label) => Math.max(max, axisLabelWidth(label)), 0);
  return Math.max(minimum, widest + padding);
}

export function axisScale(max: number): { ceiling: number; step: number } {
  if (!Number.isFinite(max) || max <= 0) return { ceiling: 4, step: 1 };
  const magnitude = 10 ** Math.floor(Math.log10(max / 4));
  let best = { ceiling: Infinity, step: 1 };
  [magnitude / 10, magnitude, magnitude * 10].forEach((base) => [1, 2, 2.5, 5].forEach((factor) => {
    const step = base * factor;
    const parts = Math.ceil(max / step - 1e-9);
    if (parts < 3 || parts > 5) return;
    const ceiling = parts * step;
    if (ceiling < best.ceiling || (ceiling === best.ceiling && step > best.step)) best = { ceiling, step };
  }));
  return Number.isFinite(best.ceiling) ? best : { ceiling: max, step: max / 4 };
}

export function heatThresholds(values: number[]): number[] {
  const sorted = values.filter((value) => value > 0).sort((left, right) => left - right);
  if (!sorted.length) return [];
  return [0.25, 0.5, 0.75].map((ratio) => sorted[Math.min(sorted.length - 1, Math.floor(ratio * sorted.length))]);
}

export function heatLevel(value: number, thresholds: number[]): number {
  if (!(value > 0)) return 0;
  return 1 + thresholds.filter((threshold) => value >= threshold).length;
}
