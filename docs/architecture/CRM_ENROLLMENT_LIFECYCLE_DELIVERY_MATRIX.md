# CRM and enrollment lifecycle delivery matrix

**Status:** Current integrated branch map with validated workspace regression and review. This document describes verified conventional-software boundaries; it does not authorize payment collection, provider connectivity, customer communication, deployment, or AI execution.

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
| Adult or guardian-child registration foundation | `/staff/crm/register` uses the closed registration command and immutable conversion evidence in `0160_crm_lead_registration.sql`. `ADULT` reuses the exact source contact; `GUARDIAN_CHILD` preserves the guardian and creates a distinct child/student/family foundation. Ambiguity returns ID-free `NEEDS_STAFF_REVIEW`. | No existing-record merge/link, payer inference, billing account, curriculum enrollment, membership, payment, consent, appointment/booking, communication, AI or automation effect. |
| Responsible billing accounts | `/staff/billing/accounts` applies the canonical/additional account policy in `0159_flexible_billing_accounts.sql`: one canonical account per payer/school by default, server-side reuse only for an exact verified payer/currency match, and explicitly audited additional accounts. | An account is not payment authorization, a schedule, invoice, collection, membership, family relation or enrollment outcome. |
| Curriculum enrollment preparation and command | `/staff/curriculum/enrollments` adds the explicit current-school preparation read in `0161_staff_curriculum_enrollment_preparation.sql`, then preserves the existing canonical direct-human curriculum enrollment command. | No student directory, eligibility/readiness/promotion inference, membership/billing/payment, testing, attendance, provider, AI or automation effect. |
| Adult-only membership DRAFT | `/staff/billing/crm-adult-membership-drafts` loads only an untrusted `studentProfileId` prefill and remains idle until a staff member explicitly prepares or asks for a separate current source-bound confirmation. `0162_crm_adult_membership_draft.sql` rederives one immutable `REGISTERED` `ADULT` conversion, matching active student/source contact, and exactly one same-person canonical account before one source-bound `DRAFT` membership. `0163_crm_adult_membership_draft_confirmation.sql` allows only the original direct-human creator to verify the exact immutable source still points to one unchanged current `DRAFT`. | No guardian-child payer inference, additional-account selection, account creation, schedule, invoice, payment method, charge, provider call, agreement, discount, credit, activation, communication, AI or automation effect. The generic membership POST remains unchanged and unused. |
| Guardian-child payer designation and membership DRAFT | `/staff/billing/crm-guardian-child-payer-designations` and `/staff/billing/crm-guardian-child-membership-drafts` accept only an inert child selector and remain idle until explicit preparation. `0164`–`0167` require a fresh immutable `REGISTERED` `GUARDIAN_CHILD` conversion-time child-fact record, exact original source guardian/current family relation, current direct-human dual authority, and one frozen/revalidated canonical guardian account while ignoring additional accounts. The first command records an immutable operational payer designation/current billing-contact projection; the second creates one source-bound child `DRAFT`. Only its DRAFT creator may separately confirm the exact current record. | No arbitrary guardian/account selector, backfill from mutable data, existing-record link, co-guardian choice, correction/transfer, account creation/reclassification, schedule, invoice, payment method, charge, provider call, agreement, activation, communication, AI or automation effect. A database trigger rejects a generic membership insert for the guarded child source. |
| Membership activation | The existing `/staff/billing/memberships` direct-human known-ID workbench can activate one observed current `DRAFT` membership after its own authorization/version confirmation. Only a successful adult **or guardian-child** CRM source-bound current-DRAFT confirmation may provide one inert `membershipId` UUID as initial text; organization and school remain blank and the workbench performs no I/O until staff deliberately loads the membership. A historical DRAFT creation receipt cannot supply the link. | It is not an enrollment wizard or a continuation command. It does not create an agreement, billing schedule, invoice, payment method, collection authority, charge, reminder or provider outcome. |

## Implemented relation and handoff rules

1. A verified registration receipt can expose a normal same-origin link only after closed client receipt verification. The curriculum, adult membership DRAFT, and guardian-child payer-designation handoffs carry **only** `studentProfileId`; the separate billing-account candidate handoff carries **only** `sourceContactPersonId`.
2. Every destination begins idle. Query data causes no lookup, scope resolution, idempotency-key allocation, command, retry or disclosure.
3. The adult and guardian-child membership DRAFT relations are deliberately stricter than a generic membership command. The browser cannot supply a conversion, family, person, payer, billing account, payment schedule, amount, authorization, agreement or provider field; the guardian-child path also has a source-provenance database insert guard.
4. Current context loss, edits, access failure, discard, reload, focus/visibility change and unmount clear stale preparation/current-confirmation/historical-receipt/retry state without refetch. Exact idempotent retry is held in memory only after an uncertain command result.
5. Existing Action Engine, automation, provider, billing/collection and communication boundaries remain separate. No new CRM path invokes them.

## Missing or deliberately deferred work

| Next capability | Why it is not already implied by the delivered slices | Dependency / owner boundary |
| --- | --- | --- |
| Co-guardian selection, payer transfer/correction and multi-child payer convenience | The delivered guardian-child path is intentionally restricted to the original immutable source guardian and a fresh source graph. | Requires a separately approved relationship-verification, correction/supersession, transfer, audit and provenance policy; no current record may be silently rebound. |
| Existing-record linking, contact correction and multi-child convenience | Automatic matching or merging can cross person/family/school boundaries or overwrite attribution. | Requires a separate ambiguity-review, authorization, audit and provenance contract. |
| Membership plan catalog and enrollment terms policy | The DRAFT accepts its deliberately closed bounded plan/term input but does not establish a school plan catalog, pricing, term authority, contract/legal policy or entitlement package. | Requires a canonical school membership-plan/terms policy and staff authority model; do not substitute a UI catalog for policy. |
| Agreement and consent workflow | Membership state, agreement status and consent are independent. | Requires approved legal/consent meaning, documents/e-signature boundary and separate audit/receipt lifecycle. |
| Payment method, payer authorization, schedule, invoice and collection | A billing account or active membership never authorizes collection. | Requires provider-flexible billing policy, tokenized method handling, authorization, idempotent provider reconciliation, failure/unknown-outcome handling, and explicit owner approval before live provider use. |
| Child/family enrollment orchestration | A family foundation is not a broad operational enrollment. | Must compose the reviewed guardian payer designation, student participation, curriculum, membership and family-safe views without cross-family shortcuts. |
| Post-activation operational onboarding | Class scheduling, attendance, progress/testing, communications and retention have separate current boundaries. | Each can receive only its own authorized human handoff after a dedicated contract; no one enrollment page should auto-create downstream facts. |
| Provider communications, AI and autonomous action | The entire current lifecycle is conventional-human software first. | A future governed Action Engine tool/approval/policy path, communication consent/queue/delivery receipts, provider health and explicit owner approval are required. |

## Next safe implementation sequence

1. **Design the canonical membership-plan and enrollment-terms boundary.** It must be an explicit policy/data/service contract, not a visual selector or a payment shortcut. It can make plan choices trustworthy before any scheduling, invoice or provider work.
2. **Add reviewed existing-record and family-linking work only after the payer boundary.** Preserve CRM conversion provenance and reject ambiguous matches by default.
3. **Treat co-guardian selection, payer correction/transfer and multi-child convenience as separate relationship/financial-responsibility policy work.** The source-guardian path must remain immutable and fail closed until then.
4. **Treat agreement, tokenized payment authorization/schedules, invoices and provider integration as separate commercial/security milestones.** Activation must remain independent and truthful until those milestones are approved and implemented.

## Reconciliation note

The feature migrations were renumbered after current `main` claimed `0152`–`0157`. See [CRM enrollment migration lineage reconciliation](CRM_ENROLLMENT_MIGRATION_LINEAGE_RECONCILIATION.md). This renumbering is prospective only: it must never be applied with the ordinary runner to a database that recorded the former feature filenames.
