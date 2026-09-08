export type AppUpdateIndicatorState = 'available' | 'processing' | null;

export function appUpdateIndicatorState(
  appHasUpdate: boolean,
  coreHasUpdate: boolean,
  processing: boolean,
): AppUpdateIndicatorState {
  if (processing) return 'processing';
  return appHasUpdate || coreHasUpdate ? 'available' : null;
}
