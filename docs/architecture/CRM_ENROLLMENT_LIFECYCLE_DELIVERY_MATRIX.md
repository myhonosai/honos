# CRM and enrollment lifecycle delivery matrix

**Status:** Current integrated branch map, pending final workspace regression and review. This document describes verified conventional-software boundaries; it does not authorize payment collection, provider connectivity, customer communication, deployment, or AI execution.

## Governing lifecycle

```text
Lead → Trial → Outcome → Human registration
     → separately verified participant / family / payer foundation
     → Membership DRAFT → separate human activation
     → separately governed billing, schedule, attendance, progress, testing, retention and renewal work
```

The arrows show governed handoffs, not automatic commands. Each stage independently resolves the current principal, organization, school, permission, entitlement, tenant context, idempotency, audit/outbox requirements, and RLS boundary. A URL carries at most an untrusted scalar selector and never transfers authority, scope, payer status, receipt data, or a command.

## Implemented, preserved conventional workflow

| Lifecycle boundary | Implemented path and scope | Explicitly not implied |
| --- | --- | --- |
| Lead intake, trial and outcome | Direct-human CRM lead, appointment/trial and outcome workbenches provide the initial bounded CRM journey. | A lead `WON` state or completed trial is not a student, family, enrollment, membership, payer, consent, agreement, payment, attendance or revenue fact. |
| Adult or guardian-child registration foundation | `/staff/crm/register` uses the closed registration command and immutable conversion evidence in `0159_crm_lead_registration.sql`. `ADULT` reuses the exact source contact; `GUARDIAN_CHILD` preserves the guardian and creates a distinct child/student/family foundation. Ambiguity returns ID-free `NEEDS_STAFF_REVIEW`. | No existing-record merge/link, payer inference, billing account, curriculum enrollment, membership, payment, consent, appointment/booking, communication, AI or automation effect. |
| Responsible billing accounts | `/staff/billing/accounts` applies the canonical/additional account policy in `0158_flexible_billing_accounts.sql`: one canonical account per payer/school by default, server-side reuse only for an exact verified payer/currency match, and explicitly audited additional accounts. | An account is not payment authorization, a schedule, invoice, collection, membership, family relation or enrollment outcome. |
| Curriculum enrollment preparation and command | `/staff/curriculum/enrollments` adds the explicit current-school preparation read in `0160_staff_curriculum_enrollment_preparation.sql`, then preserves the existing canonical direct-human curriculum enrollment command. | No student directory, eligibility/readiness/promotion inference, membership/billing/payment, testing, attendance, provider, AI or automation effect. |
| Adult-only membership DRAFT | `/staff/billing/crm-adult-membership-drafts` loads only an untrusted `studentProfileId` prefill and remains idle until a staff member explicitly prepares and confirms. `0161_crm_adult_membership_draft.sql` rederives one immutable `REGISTERED` `ADULT` conversion, matching active student/source contact, and exactly one same-person canonical account before one source-bound `DRAFT` membership. | No guardian-child payer inference, additional-account selection, account creation, schedule, invoice, payment method, charge, provider call, agreement, discount, credit, activation, communication, AI or automation effect. The generic membership POST remains unchanged and unused. |
| Membership activation | The existing `/staff/billing/memberships` direct-human known-ID workbench can activate one observed current `DRAFT` membership after its own authorization/version confirmation. | It is not an enrollment wizard or a continuation command. It does not create an agreement, billing schedule, invoice, payment method, collection authority, charge, reminder or provider outcome. |

## Implemented relation and handoff rules

1. A verified registration receipt can expose a normal same-origin link only after closed client receipt verification. The curriculum and adult membership DRAFT handoffs carry **only** `studentProfileId`; the separate billing-account candidate handoff carries **only** `sourceContactPersonId`.
2. Every destination begins idle. Query data causes no lookup, scope resolution, idempotency-key allocation, command, retry or disclosure.
3. The adult membership DRAFT relation is deliberately stricter than a generic membership command. The browser cannot supply a conversion, family, person, payer, billing account, payment schedule, amount, authorization, agreement or provider field.
4. Current context loss, edits, access failure, discard, reload and unmount clear stale preparation/receipt/retry state. Exact idempotent retry is held in memory only after an uncertain command result.
5. Existing Action Engine, automation, provider, billing/collection and communication boundaries remain separate. No new CRM path invokes them.

## Missing or deliberately deferred work

| Next capability | Why it is not already implied by the delivered slices | Dependency / owner boundary |
| --- | --- | --- |
| Guardian-child source-bound membership DRAFT | The current adult relation requires the participant and canonical responsible payer to be the same person. A guardian may not be inferred as a child’s payer. | Requires a dedicated durable, reviewable payer-designation contract and its own source/relation proof. |
| Existing-record linking, contact correction and multi-child convenience | Automatic matching or merging can cross person/family/school boundaries or overwrite attribution. | Requires a separate ambiguity-review, authorization, audit and provenance contract. |
| Membership plan catalog and enrollment terms policy | The DRAFT accepts its deliberately closed bounded plan/term input but does not establish a school plan catalog, pricing, term authority, contract/legal policy or entitlement package. | Requires a canonical school membership-plan/terms policy and staff authority model; do not substitute a UI catalog for policy. |
| Agreement and consent workflow | Membership state, agreement status and consent are independent. | Requires approved legal/consent meaning, documents/e-signature boundary and separate audit/receipt lifecycle. |
| Payment method, payer authorization, schedule, invoice and collection | A billing account or active membership never authorizes collection. | Requires provider-flexible billing policy, tokenized method handling, authorization, idempotent provider reconciliation, failure/unknown-outcome handling, and explicit owner approval before live provider use. |
| Child/family enrollment orchestration | A family foundation is not a broad operational enrollment. | Must compose the reviewed guardian payer designation, student participation, curriculum, membership and family-safe views without cross-family shortcuts. |
| Post-activation operational onboarding | Class scheduling, attendance, progress/testing, communications and retention have separate current boundaries. | Each can receive only its own authorized human handoff after a dedicated contract; no one enrollment page should auto-create downstream facts. |
| Provider communications, AI and autonomous action | The entire current lifecycle is conventional-human software first. | A future governed Action Engine tool/approval/policy path, communication consent/queue/delivery receipts, provider health and explicit owner approval are required. |

## Next safe implementation sequence

1. **Complete this branch integration and review.** Maintain all `main` SaaS/Champions work and verify the reconciled `0158`–`0161` chain only on fresh/main-lineage disposable fixtures.
2. **Design the canonical membership-plan and enrollment-terms boundary.** It must be an explicit policy/data/service contract, not a visual selector or a payment shortcut. It can make plan choices trustworthy before any scheduling, invoice or provider work.
3. **Obtain or formalize the guardian payer-designation decision before implementation.** The child path remains intentionally blocked from membership DRAFT creation until that relation is explicit and auditable.
4. **Add reviewed existing-record and family-linking work only after the payer boundary.** Preserve CRM conversion provenance and reject ambiguous matches by default.
5. **Treat agreement, tokenized payment authorization/schedules, invoices and provider integration as separate commercial/security milestones.** Activation must remain independent and truthful until those milestones are approved and implemented.

## Reconciliation note

The feature migrations were renumbered after current `main` claimed `0152`–`0157`. See [CRM enrollment migration lineage reconciliation](CRM_ENROLLMENT_MIGRATION_LINEAGE_RECONCILIATION.md). This renumbering is prospective only: it must never be applied with the ordinary runner to a database that recorded the former feature filenames.
