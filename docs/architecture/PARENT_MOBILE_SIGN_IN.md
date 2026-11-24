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
4. `GET /auth/mobile/finish` requires a valid `hon_session` cookie **and** the start cookie, and the web session must
   be issued at or after the start cookie (`mobileHandoffForBrowser`). It hands nothing to the app: it shows a
   confirmation page ("Continue to the HON Family app? You are signed in as <name>", no framing, strict CSP).
   The parent's **Continue** button POSTs to `/auth/mobile/finish`, which re-checks both cookies, requires
   `Origin == HON_PUBLIC_ORIGIN` (or a null/absent Origin only with `Sec-Fetch-Site: same-origin`, the sign-out
   rule), then issues a hand-off code (HS256 JWT, typ `hon-mobile-handoff+jwt`, aud `${aud}:mobile-handoff`, 60 s,
   claims: identity fields + challenge), clears the start cookie and 303-redirects to `honparent://auth?code=<code>`
   (fixed scheme, never from input).
   Why (RFC 8252 §8.1, review of #465): anyone can link a signed-in parent to `/auth/mobile/start` with their own
   challenge; another app that registered the `honparent` scheme would then receive a code the attacker can
   exchange. The explicit, same-origin Continue stops a silent hand-off. The freshness rule additionally refuses an
   older session in an everyday browser; it does not help when the identity provider signs the parent in silently,
   which is why the confirmation is the main defence.
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
- web: start validates challenge; GET finish never redirects to the app (confirmation page only, name escaped,
  no framing); POST finish needs session + start cookie + same-origin, refuses cross-site and an older session,
  redirect fixed to app scheme.
- app: sign-in builds the start URL from config only, exchanges, stores token; cancel/failed exchange → stays signed out.

## Known limits (pre-launch risk list)
- The hand-off code is not single-use: within its 60 s life it can be exchanged more than once, but only by the
  holder of the verifier. A used-code record can be added later.
- The mobile session gets a fresh 12 h at exchange, so it can outlive the web session it came from by up to the
  start window (the web session is always fresh at hand-off).
- Before a store release, replace the custom `honparent://` return with a claimed https address (iOS Universal
  Links / Android App Links), so no other app can receive the code at all.

## Not in M2
Biometric unlock, push, refresh tokens, server-side session revocation list, staff mobile use.

## Single-use hand-off codes (0655, GitHub security review 2026-11-22)

Each hand-off code carries a random `jti`. Before the API issues a mobile session it calls
`hon.redeem_mobile_handoff(app, jti, expires_at)` (SECURITY DEFINER, `hon_runtime` EXECUTE only). The first call for an
(app, jti) answers true; any later trade of the same code + verifier answers false and the API returns 401
`MOBILE_SIGN_IN_INVALID`. If the ledger cannot answer, nothing is issued and the API returns 503
`MOBILE_SIGN_IN_UNAVAILABLE` (the app shows "sign-in did not finish" and the person tries again). The ledger
`hon.mobile_handoff_redemptions` holds only app, jti and times, is forced RLS with no policies and no table grants, and
prunes rows five minutes after they expire. Codes issued before 0655 have no `jti` and are refused (they live 60 s).
