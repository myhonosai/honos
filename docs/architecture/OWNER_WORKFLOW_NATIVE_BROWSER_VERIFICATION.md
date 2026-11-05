# Native CRM, membership, booking and attendance verification

This verification-only increment starts at preserved #134 `b925bdf42f90f4142d7080e7dd2874408f9c7ea0`. It changes no business API, production frontend, guard, contract, migration, entitlement rule or original proof. The final combined candidate's migration count and source SHA are independently verified by that candidate's normal checks.

`apps/web/scripts/owner-workflow-api-browser-verification.mjs` runs production Next, a narrow real Nest testing module, real identity/IAM resolvers and the existing restricted disposable runtime. It does not import AppModule, start workers, replace guards/services, mock API responses, alter browser request headers or call providers. External browser requests are blocked; known Google Font requests use installed local fallbacks. Requests to the application's own origin are continued unchanged.

The new fixture reuses the existing connected-operations base session/program shape and accepted Class Sessions ACL verifier. Synthetic identity, exact-school permission grants, CORE ACTIVE fixture entitlement, pipeline/lead and class-session rows are base fixture data, not a commercial access exception. Durable student, guardian-child, payer, plan-bound membership and ACTIVE lineage are created through the existing normal registration/account/plan/family/membership services, using real IAM scope resolution and the shared two-step activation confirmation helper. No ACTIVE update or trigger disable is used. These are test records in the marked disposable database; no school, paid access, provider or AI capability is activated outside that fixture.

The mounted flow is English at 1440px and 390px for an adult and a separate guardian/child registration, four cases total:

1. Install a normally signed synthetic HON session cookie and open the real CRM journey with only inert organization/school selectors.
2. Explicitly read the bounded lead list, select the lead and follow its actual saved-memberships link.
3. Explicitly discover the lead's existing ACTIVE membership and open/read current dates/history.
4. Return, rediscover and open Classes and attendance; explicitly load and select the real class session.
5. Confirm one REGULAR booking, read the empty attendance record, explicitly save PRESENT attendance, and read it again.
6. Reload the full document, prove no membership rows have been restored from mounted memory, explicitly rediscover the student from the lead, select the class and read the saved attendance again. Assert exactly one booking and one attendance row, no student/membership ID in navigation URLs or browser storage, no page errors/overflow, and no axe violations.

Every unrelated `hon` table is fingerprinted after fixture setup and compared after the browser cases, including memberships, billing, payment, consent, entitlements, communications and AI. The only allowed browser changes are canonical booking/attendance and their existing audit/outbox/idempotency records. A refusal leaves the case incomplete and the process exits unsuccessfully; other native cases are still attempted to retain useful desktop/mobile findings. Existing separate API security proofs and synthetic language/mode matrices remain required.

## Guarded hosted invocation

The entry point requires these exact selectors before loading clients or issuing a session:

- `GITHUB_ACTIONS=true`, `RUNNER_ENVIRONMENT=github-hosted`, `HON_OWNER_WORKFLOW_TEST=1`.
- `HON_OWNER_WORKFLOW_SHA` equal to the full checked-out Git HEAD.
- Absolute normalized `HON_OWNER_WORKFLOW_TOOLS`, `HON_OWNER_WORKFLOW_CHROME`, and separate `HON_OWNER_WORKFLOW_RESULTS` paths. The tool directory contains the already prepared `playwright-core@1.56.1` and `axe-core@4.10.3`; Chromium is supplied by the hosted job. No installation is performed by the script.
- The unchanged `HON_FLEXIBLE_BILLING_ACCOUNTS_ENV_FILE` private descriptor and its exact `DATABASE_URL` / `HON_RUNTIME_DATABASE_URL`, sourced after the existing guarded fresh disposable setup. The guard verifies localhost:5432, the exact database/owner/runtime aliases, private descriptor custody and no production/provider/PG override environment.

Run from the repository root with the workspace/API/web already built, after the other browser matrices have stopped their listeners. Use a clean `env -i` invocation as in the existing integration workflow, passing only PATH/HOME/LANG, the selectors above and the sourced descriptor. Inherited auth mode, developer identity, session audience/secret, public origin and API origin are refused. The script generates ephemeral test session configuration and uses fixed loopback Next 3000/Nest 3001.

Artifacts under `HON_OWNER_WORKFLOW_RESULTS` are `owner-workflow-report.json` and one screenshot per native adult/child/viewport case. The report includes exact source SHA, completed/incomplete stages, critical HTTP statuses, page-error counts and sanitized browser/Nest ingress observations. It records only Origin presence/equality, Fetch Metadata enums and forwarded-header **names**, without cookie/token/header values, request bodies/keys or query values. The workflow must upload these artifacts with `if: always()` even when the native proof fails.

## Current evidence and narrow transport dependency

Locally executed: `node --check` for all new scripts, the pure support guard/trace suite and `git diff --check`. Local sockets are unavailable; this change does **not** claim the browser, Nest, PostgreSQL or screenshot flow has run. Fresh hosted exact-head execution is required. A signed synthetic cookie tests normal HON session verification; it is **not** external identity-provider login or acceptance from the owner's device.

Source inspection identifies a potential first real browser blocker at the session selector: `ClassSessionsReadHumanUiGuard` requires `headers.origin === configuredPublicOrigin` for GET and rejects `forwarded` / `x-forwarded-*` headers. The reviewed `loadCurrentSchoolClassSessions` transport performs a normal same-origin GET with `referrerPolicy: no-referrer`, without setting Origin; browsers ordinarily omit Origin on that request. Next's actual rewrite may also introduce forwarded headers. The older real API harness supplies headers directly, while its mounted browser partner uses synthetic responses, so neither establishes native compatibility here.

This is a source finding, not an executed reproduction. The new harness records the actual request/response stage and unmodified browser/proxy metadata. If refused, the minimal Claude dependency is to independently review the production browser-to-Next-to-Nest request contract and its trusted proxy boundary, preserving signed identity, exact school/permission/entitlement rechecks and cross-site/authority-header denials. The proof must pass unchanged on the corrected canonical boundary. Test-side Origin synthesis, forwarding-header removal, a guard override or synthetic successful response is forbidden.
