const alwaysAvailablePages = new Set(['easy', 'home', 'versions', 'config', 'usage-records']);

export function isAlwaysAvailablePage(pageId: string) {
  return alwaysAvailablePages.has(pageId);
}

export function canOpenAppPage(pageId: string, coreRunning: boolean) {
  return coreRunning || isAlwaysAvailablePage(pageId);
}
