'use client';

/**
 * Memory-clearing signals only. They never convey identity, school, permission,
 * or authority; every subsequent domain read remains server-authorized.
 */
export const HON_SESSION_INVALIDATED_EVENT = 'hon:session-invalidated';
export const HON_SCHOOL_CONTEXT_CHANGED_EVENT = 'hon:school-context-changed';

export function reportConfirmedSessionInvalidation(): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new Event(HON_SESSION_INVALIDATED_EVENT));
}
