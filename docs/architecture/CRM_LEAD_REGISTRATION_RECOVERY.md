# CRM lead registration recovery (migration 0174)

**Status:** Backend contract on branch `claude/project-thread-4l0l7t`. Not deployed. Evidence comes from disposable localhost PostgreSQL only. No frontend files are changed; Codex owns the screen integration below.

## Problem

PR #42 connects a freshly returned adult registration receipt to the billing-account and membership DRAFT steps, but keeps every identifier in memory. After navigation, refresh, inactivity or a lost session, staff can only start again from the lead row, and re-running registration returns `NEEDS_STAFF_REVIEW` because the lead is already converted. The registration receipt and `studentProfileId` are gone, so the remaining steps are unreachable.

## Contract

```text
POST /v1/organizations/:organizationId/schools/:schoolId/crm/leads/:leadId/registration-recovery
X-HON-Human-Command: crm-lead-registration-recovery
Content-Type: application/json
Origin: <configured public origin>, Sec-Fetch-Site/Mode: same-origin, Sec-Fetch-Dest: empty
(no Idempotency-Key, no query string, no other X-HON-* header)
body: {}
```

Response (`200`, `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`):

```json
{ "data": <CrmLeadRegistrationRecovery>, "meta": { "requestId": "uuid", "correlationId": "uuid", "replayed": false } }
```

`CrmLeadRegistrationRecovery` is one closed variant (`packages/contracts/src/crm-lead-registration-recovery.ts`, verifier `verifyCrmLeadRegistrationRecovery(value, selectedLeadId)`):

| `workflowState` | Extra fields | Meaning | Next step for the existing UI |
| --- | --- | --- | --- |
| `NOT_REGISTERED` | none | No conversion for this lead, and its contact has no student profile or family relation | Explicit registration (existing command; it still applies the Won / completed-trial gate) |
| `NEEDS_STAFF_REVIEW` | none | Anything unsafe or out of scope: guardian/child conversion, malformed or drifted conversion, inactive or duplicated student profile, family relation, more than one billing account, non-canonical account, a membership not created from this conversion, or a DRAFT that is no longer the exact current DRAFT (activated, changed, scheduled, invoiced) | Stop. No identifiers, counts or reasons are returned |
| `BILLING_ACCOUNT_REQUIRED` | `historicalRegistrationReceipt` | Adult registration recorded; the contact has no billing account | Existing billing-account create/reuse with `historicalRegistrationReceipt.sourceContactPersonId` |
| `READY_FOR_DRAFT` | `historicalRegistrationReceipt`, `billingAccount: { classification: "CANONICAL", currency }` | Exactly one canonical account, no DRAFT source and no membership for the adult | Existing preparation read, then DRAFT command, with `historicalRegistrationReceipt.studentProfileId` |
| `CURRENT_DRAFT` | `historicalRegistrationReceipt`, `billingAccount`, `currentMembershipDraft: { state: "RECORDED_DRAFT", receipt }` | This staff member created the DRAFT from this conversion and it is still the exact current DRAFT now (0163 confirmation) | Show as current with its receipt; offer no create command |
| `CURRENT_DRAFT_BY_OTHER_STAFF` | `historicalRegistrationReceipt`, `billingAccount`, `currentMembershipDraft: { state: "RECORDED_DRAFT" }` | Another staff member created the DRAFT from this conversion and it is still the exact current DRAFT now | Show "a current DRAFT exists, created by another staff member"; offer no confirm, create, change or activation action |

`historicalRegistrationReceipt` is the immutable 0160 creation response, verbatim (`outcome: "REGISTERED"`, `leadId`, `sourceContactPersonId`, `registrationPath: "ADULT"`, `studentProfileId`, `familyId: null`, `recordedAt`). It is a record of what happened, never evidence of current state. For the creator, `currentMembershipDraft` is produced only by calling the existing 0163 creator-owned current-DRAFT confirmation inside the same locked read. For any other authorized staff member it comes from the private `hon.crm_adult_membership_draft_is_current(student)` check, which applies the same current-state conditions as 0163 without the creator filter, returns only true/false, takes no lock, has no DML and is not callable by the runtime role; the response then carries only `{ "state": "RECORDED_DRAFT" }` (no plan, term, membership id, creator or timestamp). The stored DRAFT command receipt is never treated as current. No account id, payer id, membership version, amount, schedule or invoice is returned.

Errors: `403 CRM_LEAD_REGISTRATION_RECOVERY_FORBIDDEN` / `STAFF_SCOPE_DENIED` / `HUMAN_UI_REQUIRED` (identity, permission, entitlement or transport), `404 CRM_LEAD_REGISTRATION_RECOVERY_UNAVAILABLE` (no such lead in the verified school, including another school's or organization's lead), `400` (malformed path, body or query), `409 IDEMPOTENCY_KEY_NOT_ACCEPTED` or `CRM_LEAD_REGISTRATION_RECOVERY_CONFLICT` (lock conflict), `503` (timeout, unverifiable row, or origin not configured). No error implies any workflow state.

## Authority

- The URL organization, school and lead are selectors only. The controller resolves scope from the signed identity with the existing `resolve_crm_lead_registration_scope` and refuses a mismatched URL scope.
- The database function requires, before its locks, after its locks and before it returns: the 0160 registration actor (`crm.lead.read`, `crm.lead.register`, `student.profile.manage`, direct `HUMAN_UI`, no Action Engine or delegation, no family/HQ/platform role, active organization and school, active Essential/Core/Complete entitlement) and the 0162 adult DRAFT actor (`billing.membership.create`, same principal, external subject matching the session). Both must resolve to the same principal.
- The lead is looked up only inside the verified organization and school. Everything else (conversion, student, account, source, membership) is derived from that lead through the immutable conversion. A browser-supplied student, receipt, account or membership id is never accepted.
- Registration recovery is available to any staff member who holds both authorities at the school, so a second staff member can continue a registration.
- Owner decision (2026-10-20): other authorized staff at the same school may see that a DRAFT is current, but visibility grants nothing. The 0163 confirmation endpoint, the DRAFT command and activation keep their existing permissions; 0163 is not changed or re-granted, and a noncreator still receives `CRM_ADULT_MEMBERSHIP_UNAVAILABLE` from it.

## Effects, locks and idempotency

The function contains no DML and writes no audit, outbox or idempotency record, consistent with the existing preparation and confirmation reads. It is naturally idempotent: repeated and concurrent calls return identical results. It takes the 0163 confirmation's lock set in `SHARE` mode, in the canonical 0169 order (IAM, then `people` … `invoices`), and never locks `audit_events`, `outbox_events` or `idempotency_records`. The service runs it in an ordinary scoped transaction with a 5 s statement and 3 s lock timeout.

## Evidence

- `packages/database/scripts/test-crm-lead-registration-recovery-integrity.mjs` (flexible-billing fixture, CI and local): exact body/ACL posture; session recovery through all four positive states using the real registration, account and DRAFT services, each read in a new request; every read wrapped in an 18-table effect snapshot; six concurrent reads identical; fresh-key registration and DRAFT retries after recovery create nothing; creator versus noncreator (noncreator sees only `CURRENT_DRAFT_BY_OTHER_STAFF`, no receipt/membership/creator data, and still gets unavailable from 0163 and the DRAFT command; the private check is not runtime-callable); noncreator drift (plan, version, term, activation, extra account, archived student) reported as review to both; a noncreator read blocked by an uncommitted DRAFT change reports the committed outcome (commit and rollback); concurrent activation with noncreator reads never deadlocks and only the activation writes; drift cases (activation, extra account, archived student, foreign membership, guardian/child, pre-existing profile) fail closed; revoked, expired, inactive, missing-permission, missing-billing-permission and suspended-entitlement reads refused; forged source, Action Engine, delegation, principal type, subject and organization settings refused at the runtime role; cross-school and cross-organization leads unavailable; ablations that trust the stored DRAFT receipt (creator path) or only the existence of a source row (noncreator path) are each shown to misreport an activated membership.
- `test-crm-owner-launch-lock-order-integrity.mjs` now includes the recovery read as a twelfth workflow, paused at five lock stages and run against every other workflow in both arrival orders.
- `apps/api/test/crm-lead-registration-recovery.test.cjs`: closed contract, real Nest guard and global whitelist, service context rejection and error mapping, and a static check that 0174 is read-only and uses the canonical lock statement.
- `infra/postgres/010` grants runtime `EXECUTE` only; `011` verifies the body hash, ACL, signature and absence of overloads.

## Frontend integration requirements (Codex)

1. Call the endpoint only on an explicit staff action from an authorized, freshly loaded lead row (for example a **Resume setup** button), never on mount, focus or visibility change.
2. Send exactly the request above. Do not send a student, receipt or account id. Do not store the response in browser storage, URLs or telemetry.
3. Verify the response with `verifyCrmLeadRegistrationRecovery(data, row.id)` and also require `historicalRegistrationReceipt.sourceContactPersonId === row.primaryPersonId` before using it.
4. Map states to the existing in-memory panel: `NOT_REGISTERED` opens step 1; `BILLING_ACCOUNT_REQUIRED` seeds `registered` from the receipt and opens step 2; `READY_FOR_DRAFT` seeds `registered` and marks the account step done using only `billingAccount.currency` (the existing `AdultAccount.id` is not returned and must not be required), then requires the existing explicit preparation read before the DRAFT command; `CURRENT_DRAFT` shows a current-DRAFT card from `currentMembershipDraft` and offers no create command; `CURRENT_DRAFT_BY_OTHER_STAFF` shows that a current DRAFT exists and was created by another staff member, with no receipt details, no confirmation button and no create, change or activation action; `NEEDS_STAFF_REVIEW` shows the staff-review message with no later step.
5. Label the registration receipt as historical. Show the DRAFT as current only from `currentMembershipDraft`, never from a cached command receipt.
6. Treat `401/403` as access loss (clear the panel), `404` as an unavailable lead (return to the list), `409/503` as a retryable read with no state assumed. Every new command after recovery still uses a fresh idempotency key and the existing uncertainty handling.

## Out of scope

Guardian/child recovery or enrollment, plan catalog or pricing, payment, subscription, activation, PR #27, production database access and deployment.
