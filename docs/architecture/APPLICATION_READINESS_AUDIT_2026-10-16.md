# HON application readiness audit — 2026-10-16

**Scope:** focused Preview/application boundary audit after the current owner-launch, CRM and governed-AI slices. This is not a production-readiness certification, a live payment/provider exercise, or an authenticated mutation of the shared database.

## Verified now

| Check | Result | Evidence |
| --- | --- | --- |
| Web Preview starts and renders reference routes | **Pass** | HTTPS Preview returned `200` for `/`, `/core`, `/hq`, and `/complete-mobile`. The root Complete surface visibly labels itself **Design reference · representative sample state only · no tenant data is read or changed**. Its sample AI activity/metrics are not treated as real work. |
| Preview recovery after local production build | **Pass** | A transient Next.js dev-server cache/manifest failure (`.next` chunk/manifest lookup) temporarily returned `500` for Preview after a local production build. Removing generated `.next` artifacts and restarting the development service restored local and public Preview `200` responses. No application source or data change was required. |
| Session gate for staff pages | **Fixed and passed** | The audit initially found CRM lead/trial and AI-work shells could render anonymously. A new dynamic `/staff` server layout now verifies `HON_SESSION_COOKIE` with the existing `verifySession`/`sessionConfig` boundary and redirects unauthenticated access. Preview checks returned `307 /auth/login` for launch, dashboard, CRM leads/trials, AI work, attendance and marketing routes. |
| API fail-closed behavior | **Pass** | Unauthenticated Preview and direct listener reads of `/v1/owner-launch` and an operations-report path returned `401`. API authorization remains separate from the browser page gate. |
| Auth redirect path | **Pass for current Preview** | `/auth/login` returns a `307` to the configured app-auth flow; browser navigation reached the configured sign-in screen. |
| Web regression and production build | **Pass** | `pnpm --filter @hon/web test` completed **68 files / 305 tests**; `pnpm --filter @hon/web check`, `pnpm --filter @hon/web build`, and `git diff --check` passed. Build emitted existing non-fatal CSS/autoprefixer warnings only. |

## Important readiness findings

1. **Preview identity is still Manus app-auth.** This is suitable for the current protected Preview, but it is not evidence that a customer deployment is independent of Manus authentication. Production must select and configure a deployment-owned identity provider/session issuer before launch. This does not make the HON Action Engine or AI runtime dependent on Manus; it is a distinct deployment/authentication gap.
2. **The Complete/Core/HQ public reference surfaces are design demonstrations, not live tenant consoles.** They are correctly labelled as representative sample state. Do not treat their example agent states, metrics, or approvals as operational evidence.
3. **Authenticated mutation walkthroughs were intentionally not run against the shared database.** The repository’s guarded database/API/UI regression evidence remains the validation for RLS, receipts, idempotency and domain effects. A real user journey needs a disposable, authorized test tenant and an explicit safe test-data plan before creating people, bookings, memberships or messages.
4. **No production deployment, provider call, payment, message, advertising action or external delivery was performed.** Auto-publish remains disabled.

## Corrected gap

The shared `/staff` layout is the only new browser guard. It does not carry school IDs, permissions, tiers, role decisions, domain data or Action Engine authority. Every rendered workbench must still call its existing server/API boundaries to establish the current human and exact authorized school.

## Recommended next acceptance slice

Provision an isolated authorized demo school with disposable fixtures, then execute the already-built ordinary flow end-to-end: authenticate → owner launch → save program/class/registration → confirm booking/DRAFT posture → open dashboard → search/list CRM records. Keep payment activation, communications, provider calls and membership activation outside that test until their explicit policies are approved.
