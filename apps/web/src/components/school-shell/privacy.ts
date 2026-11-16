import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';

/**
 * Private school content the shell and its pages render (the verified school name, the
 * school choices, the dashboard) carries this attribute. On session end or a school change it is hidden and made inert synchronously, before React
 * re-renders; the re-render then replaces those nodes (they are keyed by phase), and they
 * come back only after the shell re-verifies the current identity and exact school.
 */
export const SHELL_PRIVATE_ATTRIBUTE = 'data-shell-private';

export function concealShellPrivateNow(root: ParentNode = document): void {
  for (const element of root.querySelectorAll<HTMLElement>(`[${SHELL_PRIVATE_ATTRIBUTE}]`)) { element.hidden = true; element.inert = true; }
}

/**
 * The security events that clear a page's school memory: session end and a school change.
 * Blur, a hidden tab and page hide are deliberately NOT privacy events any more (owner request
 * 2026-11-16): the shell covers the app with its screensaver instead and keeps the school.
 * `extra` names more events for a page that needs them; duplicates are listened to once.
 */
export const SHELL_SECURITY_EVENTS: readonly string[] = [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT];
export function onShellPrivacyEvent(conceal: (event: Event) => void, extra: readonly string[] = []): () => void {
  const names = [...new Set([...SHELL_SECURITY_EVENTS, ...extra])];
  for (const name of names) window.addEventListener(name, conceal);
  return () => { for (const name of names) window.removeEventListener(name, conceal); };
}
