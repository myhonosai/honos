'use client';

/**
 * Session generation (review [20]). Each confirmed session end on this page starts a new generation. A request
 * remembers the generation it was sent in, and a 401 that arrives later may only end the session it belongs to:
 * an answer from before a session end never invalidates the replacement session.
 */
let generation = 0;

/**
 * Memory-clearing signals only. They never convey identity, school, permission,
 * or authority; every subsequent domain read remains server-authorized.
 */
export const HON_SESSION_INVALIDATED_EVENT = 'hon:session-invalidated';
export const HON_SCHOOL_CONTEXT_CHANGED_EVENT = 'hon:school-context-changed';

export function reportConfirmedSessionInvalidation(): void {
  generation += 1;
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new Event(HON_SESSION_INVALIDATED_EVENT));
}

export function currentSessionGeneration(): number { return generation; }
/** Reports a confirmed 401 only while the request's own session is current and its owner still holds it. */
export function reportSessionInvalidationIfCurrent(sentIn: number, owned: () => boolean = () => true): boolean {
  if (currentSessionGeneration() !== sentIn || !owned()) return false;
  reportConfirmedSessionInvalidation();
  return true;
}
