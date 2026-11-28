import { parseFamilyInviteFragment } from '@hon/contracts';

/**
 * 0714: the invitation a parent opened from their email, kept for this browser tab only (sessionStorage) so it survives
 * the trip through sign-in. It is removed as soon as it is used or found unusable. Holding it here is safe because the
 * code alone gives nobody access: accepting needs a HON-verified sign-in with the invited email as well.
 */
export type FamilyInvite = Readonly<{ invitationId: string; token: string }>;
const KEY = 'hon.family-invite';
const box = (): Storage | null => { try { return globalThis.sessionStorage ?? null; } catch { return null; } };

export function keepFamilyInvite(invite: FamilyInvite): boolean {
  try { const store = box(); if (!store) return false; store.setItem(KEY, `#i=${invite.invitationId}&c=${invite.token}`); return true; } catch { return false; }
}
export function readFamilyInvite(): FamilyInvite | null {
  try { const value = box()?.getItem(KEY); return value ? parseFamilyInviteFragment(value) : null; } catch { return null; }
}
export function dropFamilyInvite(): void { try { box()?.removeItem(KEY); } catch { /* nothing kept */ } }

/**
 * Takes the invitation out of the address (`#i=…&c=…`) and removes it from the address bar and history entry at once,
 * so it is not left in the URL, a bookmark or a screenshot.
 */
export function takeFamilyInviteFromAddress(): FamilyInvite | null {
  const location = globalThis.location; if (!location) return null;
  const invite = parseFamilyInviteFragment(location.hash);
  if (location.hash) { try { globalThis.history?.replaceState(null, '', location.pathname); } catch { /* address unchanged */ } }
  return invite;
}
