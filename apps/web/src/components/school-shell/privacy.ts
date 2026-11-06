/**
 * Private school content the shell and its pages render (the verified school name, the
 * school choices, the dashboard) carries this attribute. On blur, a hidden tab, page hide,
 * session end or a school change it is hidden and made inert synchronously, before React
 * re-renders; the re-render then replaces those nodes (they are keyed by phase), and they
 * come back only after the shell re-verifies the current identity and exact school.
 */
export const SHELL_PRIVATE_ATTRIBUTE = 'data-shell-private';

export function concealShellPrivateNow(root: ParentNode = document): void {
  for (const element of root.querySelectorAll<HTMLElement>(`[${SHELL_PRIVATE_ATTRIBUTE}]`)) { element.hidden = true; element.inert = true; }
}

/** The privacy events that conceal; visibility counts only when the document becomes hidden. */
export function onShellPrivacyEvent(conceal: (event: Event) => void, extra: readonly string[] = []): () => void {
  const windowEvents = ['blur', 'pagehide', ...extra];
  const visibility = (event: Event) => { if (document.visibilityState !== 'visible') conceal(event); };
  for (const name of windowEvents) window.addEventListener(name, conceal);
  document.addEventListener('visibilitychange', visibility);
  return () => { for (const name of windowEvents) window.removeEventListener(name, conceal); document.removeEventListener('visibilitychange', visibility); };
}
