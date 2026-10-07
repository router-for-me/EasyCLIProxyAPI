export type HelpDestination = 'home' | 'oauth' | 'agents';
export const UX_NAVIGATE = 'personal:navigate-help';
export function navigateHelp(destination: HelpDestination) {
  window.dispatchEvent(new CustomEvent(UX_NAVIGATE, { detail: destination }));
}
