export type UsageViewScope = {
  tab: string;
  range: string;
  customStart: string;
  customEnd: string;
  model: string;
  provider: string;
  source: string;
  apiKeyHash: string;
  result: string;
  page: number;
  pageSize: number;
};

export function usageViewScopeKey(scope: UsageViewScope): string {
  return JSON.stringify([
    scope.tab,
    scope.range,
    scope.customStart,
    scope.customEnd,
    scope.model,
    scope.provider,
    scope.source,
    scope.apiKeyHash,
    scope.result,
    scope.page,
    scope.pageSize,
  ]);
}
