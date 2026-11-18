import { WALKIN_TOKEN } from '@hon/contracts';
import type { HonInterfaceTheme } from '@hon/design-system';

/**
 * The one in-memory hand-off from the staff page that started a tablet to the visitor screen in the same tab (a client
 * navigation keeps this module alive; a reload or a new tab does not). The token is never put in a URL, cookie or storage,
 * and it is taken exactly once.
 */
export type WalkInHandoff = Readonly<{ token: string; mode: HonInterfaceTheme; language: string }>;
let pending: WalkInHandoff | null = null;

export function handOffWalkInTablet(handoff: WalkInHandoff): void {
  if (!WALKIN_TOKEN.test(handoff.token)) throw new Error('Invalid walk-in tablet token.');
  pending = handoff;
}
/** Reads within the same task see the same hand-off (React may call an initializer twice); it is gone right after. */
export function takeWalkInTablet(): WalkInHandoff | null {
  const taken = pending;
  if (taken) queueMicrotask(() => { if (pending === taken) pending = null; });
  return taken;
}
