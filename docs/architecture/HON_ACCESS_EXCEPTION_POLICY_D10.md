# D10 — exception-only policy decisions and enforcement

Baseline: `b54ea12565b38e44ae0227c1acc8cd3090302a13`. New additive migration **0186**; 0179/0180 remain reserved. No approval decision is seeded. This is a source implementation for review, not operational approval or deployment.

## Architecture audit and choice

0185 already validates live direct-human HQ-owner authority, exact school/organization, entitlement version, duration, justification and canonical lock order. It grants while immutable `saas_access_policy_terms` v1 is PROPOSED. The latest `PAID_ACCESS` policy record is PROPOSED; its older decision projection is UNDECIDED. Those records also cover proposed payment/lifecycle behavior and cannot safely be relabelled APPROVED for exception administration alone.

Reuse canonical SaaS identity, request claims, audit/inert outbox, forced RLS and version checking. Add one private, append-only **exception-only decision ledger**. Do not create another entitlement authority or modify payment/credit programs. The existing grant request shape remains unchanged. Its response gains a nullable governing-policy binding, allowing historical pre-D10 exceptions to remain explicitly unverified rather than being backfilled as approved.

## Decision semantics

- Explicit owner actions append PROPOSED, APPROVED, WITHDRAWN or REVOKED decisions with monotonically increasing revision and an expected prior revision. No record is updated or deleted. Every prior revision is superseded for **new grants**, while remaining immutable historical evidence.
- Proposing/approving requires the exact existing terms version, explicit maximum days, finite validity dates and justification. Approval additionally requires the exact exception-only confirmation phrase and same-origin human-command marker. The 90-day existing technical ceiling is not an approved value or a default approval.
- Latest decision wins. PROPOSED deliberately disarms new grants, as do absence, future start, expiry, withdrawal, revocation or a terms-version mismatch. There is no automatic fallback to an older approval.
- Approval authorizes creation of exceptions within its window; it does not itself grant access. Existing exceptions retain their own captured expiry/terms if policy is later changed or expires. They may be explicitly revoked or cleaned up as before. No silent extension or bulk access change occurs.
- A new grant/renewal binds to the exact current approval, policy revision, underlying terms version and maximum. A pre-D10 record retains a null binding, is never retroactively approved, and remains revocable/cleanable. Replaying an already committed identical command is historical evidence, not a new grant or extension; current actor authority is still required.

## Enforcement and transactions

Grant command and INSERT backstop both require an approved, current, time-valid decision and enforce its maximum. No browser role, GUC or request field supplies authority. Runtime has no direct table privileges. Deferred evidence checks require a completed matching request, audit, inert outbox and exact receipt before commit; direct writes cannot silently create an approval or unrecorded exception.

Lock order is existing IAM SHARE locks → idempotency request → organization/entitlement (grants only) → global policy advisory lock. Policy decision commands **never lock or mutate organizations or entitlements** after acquiring the policy lock. All participating paths therefore preserve the same partial order. Grants hold the policy lock through commit; policy changes serialize before or after them. Revalidate time and authority after waits and at deferred commit checks. Deferred trigger functions are private SECURITY DEFINER functions so their checks execute with the same trusted owner at runtime COMMIT. Commands refuse REPEATABLE READ/SERIALIZABLE transactions: a retained snapshot must never hide a newer append-only policy head after a lock wait; the canonical runtime mutation path already uses READ COMMITTED. Withdrawal does not lock exception organizations or retroactively revoke them.

## API contract

`GET /v1/hq/saas/access-exception-policy` and `POST /v1/hq/saas/access-exception-policy` (human-command marker `saas-access-exception-policy-decision`) use existing identity, human-read/command guards, closed contracts, UUID idempotency and SaaS error mapping. Owners alone decide; independently authorized billing operators may read. School, family, support, delegated/AI and expired/revoked authority are denied independently by database functions.

The existing exception grant input, revocation, cleanup and purchase APIs remain unchanged. New receipt metadata is a server fact, not a client selector. No policy-approval frontend or customer checkout is enabled here.

## Verification and non-effects

Add disposable proof cases for absent/PROPOSED/invalid policies, explicit synthetic approval, enforced limits, immutable history/bindings, direct writes, expected-revision/idempotency races, policy/grant arrival orders, owner revocation/clock expiry while waiting and full rollback. Reuse D9 revoke/cleanup/450-row/Champions/revoke-first regressions with clearly labelled synthetic fixture decisions. Full paid-access terms stay PROPOSED in every test.

Extend the staging manifest through 0186 without changing 0181–0185 hashes; keep network/AI tripwires, shipped-empty decision assertions and before/after posture/cleanup checks. No real policy is approved. Synthetic decision records exist only in fresh marked disposable databases and are removed by fixture cleanup.

Remaining gates: independent code/security review, explicit owner approval of actual exception parameters and decision recording, persistent-database baseline/backups/rehearsal/deployment authorization. Full paid-access/B6B, Stripe, checkout, AI economics and real-school use remain separate gates. Paid access and AI credits remain INACTIVE as shipped.

## C-HQ-1 frontend integration

The explicit-action workspace at `/hq/access-exceptions` is linked from the existing `/hq/revenue` subscription/entitlement review. It starts with blank organization and school UUID inputs and performs no workspace read or command on mount, navigation, focus, language or presentation changes. The minimized school directory remains unchanged: it has no organization UUID and cannot establish this relationship. The manually entered IDs are untrusted selectors; the canonical command checks the exact active school/organization relationship.

The browser uses the existing same-origin `/api/v1` proxy and these canonical contracts from `SaasExceptionPolicyHqController`, `SaasAccessExceptionsHqController`, `SaasAccessExceptionCommandsHqController` and the SaaS subscription reader:

| Action | Existing API | Closed input or response validator |
| --- | --- | --- |
| Verify human HQ owner | `GET /v1/hq/session` | Exact `data: {principalId, hqRole}`; requires `HON_HQ_OWNER` |
| Read latest exception-only decision | `GET /v1/hq/saas/access-exception-policy` | `validateSaasExceptionPolicyView` |
| Read bounded organization exception history and access | `GET /v1/hq/saas/organizations/:organizationId/access-exceptions` | `validateSaasAccessExceptionsView` |
| Read organization/subscription facts | `GET /v1/hq/saas/organizations/:organizationId/subscription` | `validateSaasOrganizationSubscription` |
| Grant now or schedule | `POST /v1/hq/saas/organizations/:organizationId/access-exceptions` | Exact `schoolId`, `purpose`, `reason`, `scopeTier`, `startsAt`, `expiresAt`, `expectedEntitlementVersion`; `validateSaasAccessExceptionGrantInput` / `validateSaasAccessExceptionGrantReceipt` |
| Revoke selected exception | `POST /v1/hq/saas/access-exceptions/:exceptionId/revoke` | Exact `{reason}`; `validateSaasAccessExceptionRevokeInput` / `validateSaasAccessExceptionRevokeReceipt` |

Both commands use a UUID `Idempotency-Key` and the existing `X-HON-Human-Command` value (`saas-access-exception-grant` or `saas-access-exception-revoke`). They retain the real identity/read/command guards and database authorization. Scheduling is a grant with a finite future `startsAt`, not another endpoint. There is no policy-decision, expiry-cleanup, awaiting-first-payment, purchase, payment or AI-spending action in this UI.

New grants require the returned latest decision to be `APPROVED` and its effective status to be `ACTIVE`. The actual `current.maxDays` controls the window; 90 days is only the backend ceiling. Start/expiry inputs are explicitly UTC, with a mandatory expiry, at most 30 days ahead and the server's existing five-minute past-start tolerance. All three purposes are canonical (`INTERNAL_TESTING`, `PRODUCT_DEMONSTRATION`, `APPROVED_PILOT`); none is a test bypass. `CORE` and `COMPLETE` are the existing internal capability-profile codes for one HON OS product, never public tier/price or AI-spend authority. Broader terms remain visibly `PROPOSED`, and paid-access/AI-credit programs remain reported as `INACTIVE`; this integration records no policy approval.

The UI names known blockers from the returned organization/access/subscription state, including awaiting first payment, current access, active/scheduled exceptions and subscriptions. These reads do **not** prove complete eligibility: none of these readers returns the complete pending-checkout/blocker set or establishes the selected school relationship. The canonical command remains responsible for those checks and its actual refusal is shown without exposing backend detail. At most the newest 50 organization exceptions are returned, then filtered for the explicitly selected school. A null or absent historical `governingPolicy` is labelled unverified; it is never displayed as an approved grant.

Each new command requires a fresh human confirmation, current-owner and state preflight, unchanged reviewed policy ID and entitlement version, and a same-owner check after the receipt. The immutable in-memory request captures the original principal, target, exact serialized body and UUID key. A synchronous command lease lasts until the physical request settles, independently of privacy/read epochs; double clicks, late reads, concealment and restoration cannot create a parallel command. A timeout, lost/malformed receipt or uncertain replay retains that exact request with no automatic retry or replacement/discard control. Recovery requires explicit same-owner restoration and another confirmation; committed historical replay is permitted even if policy later expires. The verified receipt is labelled historical; current access needs a separate explicit read.

Blur, hidden visibility, pagehide, shared confirmed 401, school-context change and unmount synchronously hide/inert private DOM, clear visible facts and abort/invalidate reads. Focus does not reveal or fetch. Private retained request data stays only in mounted controller memory and is omitted from concealed markup. A before-unload warning covers in-flight/retained requests; full-document reload/navigation loss cannot recover that memory. No browser storage is used for request data. The persistent live region announces loading, receipt and denial states. English, Korean and Spanish share the same behavior in Modern HON, Classic CRM and Big-Button modes.

The existing D9/D10 command DTOs contain no atomic expected-actor field. Browser pre/post principal checks can detect account changes and withhold results; they cannot atomically bind the last verified browser principal to the server's command transaction. This integration does not invent a body/header or claim to close that backend limitation. Each actual command is still independently authorized as a human HQ owner by the signed-session guard and database. Separate owner policy approval, a reviewed organization/school navigation reader, complete blocker visibility and any stronger atomic actor-binding contract remain explicit dependencies.

Local verification on 2026-11-02 on the isolated `dce550e7` frontend baseline: all 46 focused tests pass (23 controller, 14 HTTP, 9 production view), as do all 1,097 web tests across 141 files, web TypeScript checking, the production build and `git diff --check`. The broader run exposed the missing new-route manifest entry; adding that entry restored all route-equality checks. Parent-owned supported signed-session/disposable-PostgreSQL and mounted browser/accessibility evidence remains pending on the final integrated head; no local socket, database or final-main integration success is asserted here.

Final reconciliation normally includes accepted main `be3a26e097a4ceb355d08d93d57dd73297b6048f` (#95/#113/#114). Combined-tree local validation: 1,237 web tests across 145 files, web typecheck, production build and 183 locked migration hashes pass. The pnpm wrapper failed before running tests because its automatic dependency/store check attempted an unavailable home directory; direct cached Vitest/TypeScript/Next binaries supplied these actual results without installing packages. The dedicated draft-safe workflow separately runs full repository/build checks, all canonical database proofs, the real frontend transport through signed HQ sessions/restricted PostgreSQL, and synthetic mounted browser/axe/screenshot verification. The API proof uses only the exact marked localhost Champions fixture; its clearly labelled synthetic policy/exception changes never approve an operational policy. Real API and browser results must be reported from CI, not inferred from this local evidence.
