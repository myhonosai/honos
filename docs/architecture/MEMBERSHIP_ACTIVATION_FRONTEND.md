# E1a staff two-step activation frontend

Baseline: backend PR #52, main `2beb7f5fd4307a64c0ae3790795e45270c4f35ae`. This change is frontend and verification only. No backend, contract, migration, financial authority or persistent database is changed.

## Connected path

`/staff/billing/memberships` → `membership-activation-workbench.tsx` → `membership-activation-http.ts` → existing authenticated membership preview/confirmation controllers → existing MembershipService → protected 0177 functions.

The page verifies the signed session, passes only its subject for browser continuity and keys the component to the session. Invalid/expired sessions redirect to sign-in. Known IDs remain untrusted selectors, never authority, and are not populated or fetched from URLs. Every API read and command independently enforces exact school, permission and entitlement rules. Controls are capability-driven; no OWNER-only client rule exists.

## Human review

- Explicit **Review activation** posts `{}` to `activation-preview`, with the exact preview human marker and **no** idempotency header. The shared closed response verifier supplies participant, original plan/source/version, suggested and proposed dates, school-local today/timezone, warnings, blocks, allowed overrides and requirements not evaluated.
- Editing valid dates immediately invalidates the digest, final summary and acknowledgements and issues a new read-only preview. Invalid/intermediate date input cannot be confirmed. Older reads are aborted/epoch-discarded. Date-only presentation uses shared Language & Region calendar formatting, without timezone-shifting the inclusive last valid day.
- Every warning is individually acknowledged. Missing birth date is a warning/reminder, with optional staff adult attestation, never fabricated DOB or customer consent. Minor restrictions stay on the server. An identity override appears only when its code is in `availableOverrides`, with a 10–500-character reason and explicit secondary unresolved-review confirmation. No merge/reassignment tool exists.
- Adjusted dates and OTHER/backdated reasons are collected as required by the backend. A separate final summary and final checkbox precede any activation request. Input uses `validateConfirmMembershipActivationInput`; the request carries the exact digest, date source and closed body.
- The receipt is verified against the exact submitted membership/version/dates/warnings/overrides/attestation. It is historical evidence, not a fresh current-state observation. SCHEDULED says **confirmed — scheduled to begin**, and ENDED is distinct from IN_EFFECT at the recorded confirmation. Inclusive dates, timezone, acknowledged warnings, unresolved overrides and returned work-item references are shown.
- Agreement/signature, payment, recurring authorization, financial responsibility and school policy remain **not evaluated**. Activation never claims financial enrollment is complete.

## Privacy and retry lifecycle

Window blur or hidden-document visibility immediately removes all sensitive content from the rendered tree. An empty view does not require concealment. No grace period or focus-return auto-reveal exists.

Read epochs are separate from command instance ownership. Blur invalidates/aborts reads; it does **not** cancel a consequential command or prevent its `finally` from clearing busy state behind the shield. After settlement, **Verify access and resume** rechecks the exact signed subject and independently authorized school/membership/activation access through the existing context endpoint. Repeated focus loss cancels restoration. Another session remounts memory. No page reload is required for ordinary restoration.

Each confirmation freezes its scope, canonical JSON bytes and fresh idempotency key in memory. Repeated clicks are synchronously gated. Unknown/malformed/server-unavailable outcomes retain that exact request. `IDEMPOTENCY_IN_PROGRESS` remains retryable; stale preview/version/refused-body conflicts require fresh review. Access denial conceals information and preserves unresolved recovery until explicit verification or abandonment. No automatic command retry exists.

Discard is disabled during an unsettled command. After settlement, deliberate abandonment requires its own acknowledgement that it removes browser recovery and **cannot cancel or undo a server action**. Changing form inputs cannot mutate a retained request. No sensitive data or retry key is stored in URLs, browser storage or telemetry. Full document destruction (reload, closing the tab or signing in through a new page) loses in-memory retries; verify server state before any new command. The CRM's separate 50-record list-restoration limitation is unchanged.

## Error vocabulary and cancellation

Actual E1a codes are mapped to safe fixed messages, without echoing backend detail. They include stale preview, two-step required, warning acknowledgement, override required/forbidden, blocked activation, version/state conflict, reused/in-progress keys, date-source mismatch, reason text and inapplicable attestation. Calendar-invalid input uses the implemented `VALIDATION_FAILED`; the backend does not expose a `DATES_INVALID` code. Date-window/minor/plan issues appear as actual preview block codes.

The obsolete `{ expectedVersion }` activation caller has been removed. There is no cancellation frontend caller in current main; existing cancellation backend/API contracts and clients are untouched. E1a backend proofs continue to verify cancellation and fingerprint compatibility. No payment, schedule, agreement, consent, provider or activation workflow outside this explicit staff screen is added.

## Verification and evidence boundaries

- Updated frontend transport, component interactions and signed-page-session tests cover closed contracts, explicit two-step submission, delegated capabilities, missing DOB, overrides/denials, changed dates/digests, future/inclusive presentation, stale facts, duplicate clicks, unknown exact retries and read/command privacy lifecycle.
- `membership-activation-api-verification.mjs` uses the **actual web transport**, real signed-session Nest guard/controller and restricted runtime against the repository's marked localhost disposable PostgreSQL fixture. It verifies zero-effect previews, concurrent exact-key confirmation/replay, post-commit response loss, missing-DOB reminder, known-minor block, stale preview, cross-school denial, expired/absent session and revoked permission including replay. It snapshots financial/entitlement/provider tables to prove no effects. No API or identity mock is used in this test.
- `membership-activation-browser.mjs` extends the existing actual Next production-build browser runner. The API response fixtures are synthetic, validator-checked and localhost-only; this is **not** a live school or provider test. Desktop/mobile screenshots and axe results are retained in the existing private CI artifacts, with no individual GitHub blob uploads. Existing adult, family, close and Resume setup checks remain enabled.
- Full tests, typecheck/build, migration checks and existing 29 PostgreSQL security proofs run in unchanged repository CI. Exact-head results and artifact links belong in the PR. Local dependency installation is blocked by incomplete offline cache and the environment's unreachable proxy; do not infer a local full-suite pass.

## Deployment prerequisites retained

This PR does not approve deployment. Coordinate the frontend and backend release: the old client is refused by 0177, and the new preview route is absent from older backends. Preserve [the backend deployment/risk plan](MEMBERSHIP_ACTIVATION_GATE_DEPLOYMENT_AND_RISKS.md) in full, including:

1. Known-minor adult registration prevention/recovery. A previously converted adult lead cannot simply be relinked by this frontend; authorized backend recovery is still required.
2. E1b effective-status reporting and any membership-dependent benefit gates. Other readers may count scheduled memberships as lifecycle ACTIVE; this frontend does not claim to fix them.
3. Approved persistent-database history/trigger/timezone/privilege verification, backup and coordinated migration 0177/runtime reconciliation. No persistent migration has been executed here.
4. The nine older non-CI manual proofs need fixture updates before reuse. Current CI proofs are separate evidence.
5. Date-window configurability, month-end policy, legacy retry cutover, operational work-item handling and all other documented E1b/E1c/policy follow-ups remain open.

New E1a prose is English; complete Korean/Spanish screen translation and manual physical-device/screen-reader/zoom/contrast QA remain follow-ups. Existing localization preferences/formatting and appearance persistence are preserved. No E1b/E1c functionality, money, consent, agreement, real membership activation or production deployment is claimed.
