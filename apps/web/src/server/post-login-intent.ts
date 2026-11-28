/**
 * Where a sign-in started, as one of a fixed set of names. The browser never supplies a path: the
 * sign-in link carries only `?for=<name>`, the login route stores the name in a short-lived HttpOnly
 * cookie scoped to /auth, and /auth/continue maps it back to its fixed page and clears it.
 */
export const POST_LOGIN_INTENT_COOKIE = 'hon_post_login';
/**
 * `mobile`: the HON Family app's sign-in (/auth/mobile/start) and `staff-mobile`: the HON Staff app's
 * (/auth/staff-mobile/start) return to their confirmation step, never straight to the app.
 * `start`: someone who tapped "Start a new school" (the website or the app home) and had to sign in or create a
 * login first comes back to /account/start, which still decides everything itself.
 */
export const POST_LOGIN_INTENTS = { parent: '/parent', 'family-invitation': '/account/family-invitation', mobile: '/auth/mobile/finish', 'staff-mobile': '/auth/staff-mobile/finish', start: '/account/start' } as const;
export type PostLoginIntent = keyof typeof POST_LOGIN_INTENTS;
export type PostLoginIntentPath = (typeof POST_LOGIN_INTENTS)[PostLoginIntent];

export function postLoginIntent(value: string | null | undefined): PostLoginIntent | null {
  return typeof value === 'string' && Object.hasOwn(POST_LOGIN_INTENTS, value) ? value as PostLoginIntent : null;
}

/** Only the exact form `?for=<name>` names an intent; anything else (extra keys, repeats) names none. */
export function postLoginIntentFromQuery(search: URLSearchParams): PostLoginIntent | null {
  const keys = [...search.keys()];
  return keys.length === 1 && keys[0] === 'for' ? postLoginIntent(search.get('for')) : null;
}

export const PARENT_SIGN_IN = '/auth/login?for=parent';
export const FAMILY_INVITATION_SIGN_IN = '/auth/login?for=family-invitation';
export const START_SIGN_IN = '/auth/login?for=start';
