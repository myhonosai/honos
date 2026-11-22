# HON Staff app S0 — native staff sign-in (spec)

Status: built 2026-11-22 (tests listed below). Owner ask: David, 2026-11-22 ("I do need staff app which Kai and HON
lives", "Ok let's build"). Plan: `/mnt/project-files/staff-app/STAFF_APP_PLAN.md`. Builds on the parent app sign-in
(`PARENT_MOBILE_SIGN_IN.md`). **Security-material: goes on the pre-launch risk list.**

## Problem
Native bearer sessions exist only for the HON Family app and reach only `/v1/(parent|me|auth/mobile)/`
(`apps/api/src/foundation/hon-identity.service.ts`). A staff app needs its own session that cannot be confused with
a family one and that reaches only the staff routes the app actually uses.

## Design
Same PKCE hand-off as the family app (RFC 7636 / RFC 8252), as a **separate token family**. Nothing about the family
flow changes.

| Token | typ | aud |
|---|---|---|
| Staff start cookie `hon_staff_mobile_start` (10 min, path `/auth`) | `hon-staff-mobile-start+jwt` | `${aud}:staff-mobile-start` |
| Staff hand-off code (60 s) | `hon-staff-mobile-handoff+jwt` | `${aud}:staff-mobile-handoff` |
| Staff session (12 h max, same as web) | `hon-staff-mobile-session+jwt` | `${aud}:staff-mobile` |

Different typ and audience mean a family token never verifies as a staff token or the other way round, and neither
verifies as a web session.

1. App opens the system browser at `/auth/staff-mobile/start?challenge=<S256, 43 chars>`. The web sets the staff
   start cookie and redirects to `/auth/login?for=staff-mobile`.
2. Normal web OIDC sign-in. Intent `staff-mobile` returns to `/auth/staff-mobile/finish`.
3. `GET /auth/staff-mobile/finish`: needs a valid web session issued at or after the staff start cookie. Shows
   "Continue to the HON Staff app? You are signed in as <name>". Hands nothing to the app.
4. `POST /auth/staff-mobile/finish` (Continue, same-origin rule as the family flow) issues the staff hand-off code,
   clears the start cookie, 303 to the fixed `honstaff://auth?code=…`.
5. App `POST /v1/auth/mobile/staff-session {code, verifier}` → `{token, expiresAt}`. Same native-only header rules as
   `/v1/auth/mobile/session` (no Origin, Sec-Fetch-Site, cookie or Authorization; JSON). The family endpoint refuses a
   staff code and the staff endpoint refuses a family code.

Sign-in proves only who the person is. It grants nothing: every staff route still resolves school, role and
permission from the database on every call (forced RLS, existing guards). A person with no staff role gets the same
403s as on the web.

## API identity rules
- Cookie present → web path, unchanged.
- No cookie, `Authorization: Bearer` → try the family session, then the staff session. Channel stays `MOBILE` (so the
  existing native rule in `CurriculumHumanUiGuard` applies unchanged); `request.honMobileApp = 'FAMILY' | 'STAFF'`.
- **Family app** routes: unchanged (`/v1/parent/`, `/v1/me/`, `/v1/auth/mobile/`).
- **Staff app** routes: an explicit allow-list, `STAFF_MOBILE_ROUTES` in `hon-identity.service.ts`. S0 holds only:
  - `/v1/me/…` (language, HQ contact)
  - `/v1/auth/mobile/…`
  - `GET /v1/staff/current-reporting-school`, `GET /v1/staff/reporting-schools` (which school the person works at)
  Everything else, including `/v1/parent/…`, every `/v1/organizations/…` route, `/v1/hq/…` and all other `/v1/staff/…`
  routes, is refused with 403 `MOBILE_SESSION_SCOPE`. Each later phase (S1 Today, S2 HON, …) adds its exact routes in
  its own reviewed PR, with a test per route.
- The allow-list is matched on the URL path only (query ignored), anchored, segment-exact (no prefix tricks such as
  `/v1/staff/reporting-schoolsx`).

## Out of scope (S0)
The Expo app itself (S0b, next PR), HQ mode (S7), per-staff agent switches (S2), push, server-side token revocation
(pre-launch risk item, same as the family app), claimed https return links (pre-launch, same as the family app).

## Tests (TDD)
- auth (`packages/auth/src/mobile.test.ts`): staff session/start/hand-off issue+verify; family↔staff tokens refused
  both ways; web token refused as staff; staff exchange needs the verifier; staff browser hand-off freshness rule.
- API (`apps/api/test/staff-mobile-session.test.cjs`): staff bearer authenticates allow-listed routes with
  `honMobileApp = 'STAFF'`; refused on parent, organizations, hq, other staff routes and look-alike paths; family
  bearer still refused on staff routes; staff exchange endpoint header rules and cross-family refusal.
- web (`apps/web`): staff start validates the challenge and sets the staff cookie; finish GET shows the confirmation;
  POST requires same-origin and redirects to `honstaff://auth`; `staff-mobile` login intent.
