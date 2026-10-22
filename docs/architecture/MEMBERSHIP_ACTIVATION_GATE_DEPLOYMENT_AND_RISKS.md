# Membership activation gate (0177): deployment plan and remaining risks

Nothing in this PR has been deployed, and no persistent database has been touched. Every step below needs explicit owner approval.

## Deployment plan

1. **Prerequisites.**
   - 0001–0176 are applied.
   - The Codex frontend for two-step activation is merged, or the owner accepts that staff cannot activate from the current workbench until it is.
   - Confirm that no persistent environment has applied unpublished migrations under these numbers.
2. **Back up and inspect, read-only, on the target.**
   - Count DRAFT memberships by source.
   - List roles holding `billing.membership.activate`.
   - Confirm `hon.memberships` has no user triggers: the migration refuses to run otherwise.
   - Confirm every school timezone is a valid IANA name: `SELECT id, timezone FROM hon.schools WHERE timezone NOT IN (SELECT name FROM pg_timezone_names)`. A school with an invalid zone cannot activate (it fails closed with `SCHOOL_TIMEZONE_INVALID`).
3. **Quiet window.** 0177 takes brief exclusive locks on `hon.memberships` (trigger creation and privilege changes) and inserts permission mappings. In-flight activations on the old API finish first; requests that arrive after commit get `400 ACTIVATION_TWO_STEP_CONFIRMATION_REQUIRED`.
4. **Apply** `0177_membership_activation_gate.sql` as the trusted migration owner through `migrate.mjs`. It is one transaction and fails whole if any guard, prerequisite or final default check fails.
5. **Reconcile runtime privileges.** Run `infra/postgres/010_supabase_hon_runtime.sql`. Its 0177 section removes runtime INSERT, UPDATE, DELETE and TRUNCATE on memberships, grants the seven-column DRAFT INSERT, and grants EXECUTE on the three entry points.
6. **Verify** with `infra/postgres/011_verify_supabase_hon_runtime.sql`. Its 0177 section checks the exact function hashes, private evidence tables, the trigger, the D41 privileges and the D30a permissions.
7. **Deploy the API and the Codex frontend together.** The old frontend fails closed (400) against the new API. The new frontend cannot work against the old API: the preview route does not exist there and returns 404.
8. **Smoke test** in a non-production school with fixture data: preview, confirm, replay, cancellation. No real member data.
9. **Rollback.** The evidence tables are immutable by design. Rolling back means a forward migration that restores the old grants and drops the trigger, and existing decisions stay as history. Do not delete evidence.

## Compatibility notes

- **In-flight activation keys** recorded by the pre-0177 API get `409 IDEMPOTENCY_KEY_REUSED` (the fingerprint changed). They are never replayed or re-run. Staff simply preview and confirm again.
- **In-flight cancellation keys** keep working: the fingerprint is byte-identical (proven). Exception: a retry whose path used an upper-case membership id hashes differently and gets `IDEMPOTENCY_KEY_REUSED`.
- **Outbox** `billing.membership.activated` moves to schema v2. No consumer exists today; any future consumer must read v2.
- **Owner-side fixtures and scripts** that wrote ACTIVE or CANCELLED rows directly no longer work, because the transition trigger refuses them. CI proofs were updated. These non-CI manual proofs still insert ACTIVE rows or edit ACTIVE terms directly and need fixture updates, using `membershipFixtureQuery` from `packages/database/scripts/membership-activation-test-support.mjs`, before they are run again. They were not run here:
  - `test-billing-invoice-draft-integrity.mjs`, `test-billing-invoice-issue-integrity.mjs` and `test-billing-renewal-integrity.mjs`;
  - `test-operations-report-security.mjs`, `test-parent-billing-read-integrity.mjs` and `test-parent-testing-status-integrity.mjs`;
  - `retention-attention-integrity.mjs`, `test-retention-review-acknowledgement-integrity.mjs` and `test-revenue-planning-integrity.mjs`.

## Remaining risks and open items

1. **Lifecycle-state readers vs effective dates.** These readers still treat a SCHEDULED (future-start) membership as ACTIVE:
   - the operations report `membershipsActive`;
   - the parent billing view;
   - the command center and health score;
   - retention signals;
   - renewal facts;
   - revenue planning.

   No booking, attendance, ClassPass, kiosk or check-in path reads memberships, so no benefit is granted early (a static guard enforces this). Counts and displays can still overstate, until E1b and Codex align them.
2. **Pre-0177 ACTIVE rows** have no decision or period evidence. Their effective status is UNDATED when they have no start. They are unchanged by design (D13), and E1b date revisions must handle them.
3. **D3 conflict (reported).** The adult CRM registration path does not enforce age 18+. An adult-path DRAFT whose birth date makes the participant a minor, with no guardian family, is **blocked** with `MINOR_GUARDIAN_OF_RECORD_REQUIRED`, so staff must use the guardian/child flow. The owner should decide whether the adult path should refuse minors at registration.
4. **Fixed-term month-end clamping.** Fixed-term ends follow PostgreSQL month addition (Jan 31 + 1 month − 1 day = Feb 27), which matches the 0175 plan helper but may surprise staff. They can adjust with a reason. The owner may prefer "same day next month − 1" semantics for E1b.
5. **Date windows.** Start dates may be at most 730 days ahead of school-local today, and terms at most 3,653 days long. Backdating to 2000-01-01 is allowed with reason text. These are fixed constants until E1c makes them school-configurable (D29).
6. **The trusted owner can still bypass.** The migration owner (BYPASSRLS/superuser) can disable the trigger or write evidence rows. That is inherent to database ownership; operationally it is controlled by credential custody, not by HON code.
7. **Requester ≠ approver** for `billing.membership.change.approve` is a requirement on E1c. The permission exists but nothing uses it yet.
8. **Work items are reminders only.** They have no SLA, assignment or escalation. The identity review stays unresolved until staff act through existing CRM review paths.
9. **CI time.** The new proof adds about 10 seconds; the lock-order matrix now has 1,422 cells. The 25-minute CI database job limit should still hold, but should be watched.
10. **Frontend.** Until Codex ships the two-step UI, the existing activation button returns a 400 error. This is a deliberate fail-closed choice, not a regression to patch in the backend.
