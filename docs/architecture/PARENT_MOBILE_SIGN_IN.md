# Parent mobile app M2 — native sign-in (spec)

Status: built, 2026-11-17 (see tests listed below). Builds on M1 (PR #463). Security-material: goes on the pre-launch risk list.

## Problem
The API authenticates only the `hon_session` cookie (`apps/api/src/foundation/hon-identity.service.ts`), and every
parent POST passes `CurriculumHumanUiGuard`, which requires `Origin == HON_PUBLIC_ORIGIN` (a CSRF defence for cookies).
A native app has no browser cookie jar shared with the web and sends no Origin. Setting Origin by hand from the app
would defeat the check, so it is not an option.

## Design
Reuse the existing web OIDC sign-in (same provider client, same redirect URI `${origin}/auth/callback`); no new
identity-provider registration and no provider secret on the phone.

1. App makes `verifier` (32 random bytes, base64url) and `challenge = S256(verifier)`, then opens the system browser
   (`expo-web-browser` auth session, ephemeral) at `${origin}/auth/mobile/start?challenge=<43 chars>`.
2. `/auth/mobile/start` (web) validates the challenge, sets a 10-minute signed `hon_mobile_handoff` cookie
   (HS256, typ `hon-mobile-start+jwt`, aud `${aud}:mobile-start`, holds only the challenge) and redirects to
   `/auth/login?for=mobile` (the web thread's intent mechanism).
3. Normal OIDC login runs. `/auth/continue` with intent `mobile` redirects to `/auth/mobile/finish`.
4. `/auth/mobile/finish` requires a valid `hon_session` cookie **and** the start cookie, issues a hand-off code
   (HS256 JWT, typ `hon-mobile-handoff+jwt`, aud `${aud}:mobile-handoff`, 60 s, claims: identity fields + challenge),
   clears the start cookie and redirects to `honparent://auth?code=<code>` (fixed scheme from config, never from input).
5. App `POST /v1/auth/mobile/session` `{ code, verifier }` (JSON). API verifies the code, `S256(verifier) == challenge`
   (constant time), and returns `{ token, expiresAt }`: a mobile session JWT, typ `hon-mobile-session+jwt`,
   aud `${aud}:mobile`, same 12 h maximum as the web session, same claim allow-list.
   An intercepted code is useless without the verifier, which never leaves the app (RFC 8252 / 7636).
6. App stores the token in the keychain (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`) and sends `Authorization: Bearer`.

## API identity rules
- `HonIdentityService.authenticate`: a `hon_session` cookie decides exactly as before and any Authorization header is
  ignored (a staging proxy may add Basic auth; a browser cannot attach a bearer cross-origin because CORS is off).
  No cookie → `Authorization: Bearer` must be a mobile session (`verifyMobileSession`); a web token as bearer, a
  mobile token as cookie, or a non-bearer header → 401. Sets `request.honChannel = 'WEB' | 'MOBILE'`.
- `CurriculumHumanUiGuard` (base of every human-UI POST guard): when `honChannel === 'MOBILE'`, the Origin requirement
  (or, when the guard runs before the identity guard, no cookie and a `Bearer` header) is replaced by: no `Origin`
  and no `Sec-Fetch-Site` header at all (a browser always sends one; CORS is off so a
  browser cannot attach the bearer cross-origin anyway). Still POST only, exact `x-hon-human-command`, JSON body.
  Delegation/source headers stay refused. Web behaviour is byte-for-byte unchanged.
- Mobile sessions are parent-only in M2: a bearer request to any non-`/v1/parent/*`, `/v1/me/*` or
  `/v1/auth/mobile/*` route is refused (403 `MOBILE_SESSION_SCOPE`). Staff/HQ stay web-only until reviewed.
- Revocation: family authority is still re-resolved on every read/command; a revoked guardian is refused at once.
  Sign-out deletes the token on the device. Server-side token revocation list is out of scope (12 h max lifetime,
  same as web); listed as a pre-launch risk item.

## Tests (TDD)
- auth: issue/verify mobile session (typ/aud/claims/expiry/tamper), web token rejected as mobile and vice versa,
  hand-off code (expiry, challenge mismatch, wrong typ), start cookie.
- API: cookie+bearer → 401; bearer web token → 401; bearer mobile → identity; guard: mobile POST with
  Origin/Sec-Fetch-Site → refused, without → admitted with correct command, wrong command refused; web path unchanged;
  mobile on staff route → 403; exchange endpoint happy path / bad verifier / expired code / extra fields.
- web: start validates challenge; finish requires session + start cookie, redirect fixed to app scheme.
- app: sign-in builds the start URL from config only, exchanges, stores token; cancel/failed exchange → stays signed out.

## Not in M2
Biometric unlock, push, refresh tokens, server-side session revocation list, staff mobile use.
