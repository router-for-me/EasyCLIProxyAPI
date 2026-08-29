export type UsageAnalysisMetric = 'tokens' | 'requests' | 'failureRate';

export type UsageCategoryMetrics = {
  key: string;
  requests: number;
  failures: number;
  tokens: number;
};

const nonNegativeNumber = (value: number) => (
  Number.isFinite(value) ? Math.max(value, 0) : 0
);

export const failureRatePercent = (category: UsageCategoryMetrics) => {
  const requests = nonNegativeNumber(category.requests);
  if (requests === 0) return 0;
  return Math.min((nonNegativeNumber(category.failures) * 100) / requests, 100);
};

export const categoryMetricValue = (
  category: UsageCategoryMetrics,
  metric: UsageAnalysisMetric,
) => {
  if (metric === 'failureRate') return failureRatePercent(category);
  return nonNegativeNumber(category[metric]);
};

export const sortCategoriesByMetric = <T extends UsageCategoryMetrics>(
  categories: readonly T[],
  metric: UsageAnalysisMetric,
) => [...categories].sort((left, right) => (
  categoryMetricValue(right, metric) - categoryMetricValue(left, metric)
  || nonNegativeNumber(right.tokens) - nonNegativeNumber(left.tokens)
  || nonNegativeNumber(right.requests) - nonNegativeNumber(left.requests)
  || left.key.localeCompare(right.key)
));
