const STORAGE_KEY = 'cpa-gui.perf-mode';

export type PerformanceMode = 'full' | 'lite';

let cachedMode: PerformanceMode | null = null;

function readStoredMode(): PerformanceMode | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    if (value === 'lite' || value === 'full') return value;
  } catch {
    // Ignore storage access errors in restricted webviews.
  }
  return null;
}

function detectDefaultMode(): PerformanceMode {
  if (typeof navigator === 'undefined') return 'full';
  const platform = (navigator.platform ?? '').toLowerCase();
  const ua = (navigator.userAgent ?? '').toLowerCase();
  // Enable performance-first mode automatically on Linux ARM / Raspberry Pi
  // (WebKitGTK on aarch64/arm) and Linux Tauri WebKitGTK builds where software
  // blurs, transitions, and JS overlay scrollbars cause noticeable frame drops.
  const isArmLinux = (platform.includes('linux') || ua.includes('linux'))
    && (platform.includes('aarch64') || platform.includes('arm') || ua.includes('aarch64') || ua.includes('arm'));
  return isArmLinux ? 'lite' : 'full';
}

export function getPerformanceMode(): PerformanceMode {
  if (cachedMode !== null) return cachedMode;
  cachedMode = readStoredMode() ?? detectDefaultMode();
  return cachedMode;
}

export function isLitePerformanceMode(): boolean {
  return getPerformanceMode() === 'lite';
}

export function initializePerformanceMode(): PerformanceMode {
  const mode = getPerformanceMode();
  if (typeof document !== 'undefined') {
    if (mode === 'lite') {
      document.documentElement.dataset.perfMode = 'lite';
    } else {
      delete document.documentElement.dataset.perfMode;
    }
  }
  return mode;
}
