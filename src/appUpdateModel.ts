export type AppUpdateIndicatorState = 'available' | 'processing' | null;

export function appUpdateIndicatorState(
  hasUpdate: boolean,
  processing: boolean,
): AppUpdateIndicatorState {
  if (processing) return 'processing';
  return hasUpdate ? 'available' : null;
}
