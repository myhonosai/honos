# Adult CRM registration to membership DRAFT

**Status:** Implemented and validated on the isolated `manus/crm-enrollment-workflow` branch. This is an adult-only conventional staff workflow following a verified CRM lead-registration receipt. It does not authorize guardian-child payer inference, payment collection, schedules, invoices, charges, provider calls, messages, AI execution, activation, or deployment.

## Intent

A staff member who has completed the bounded `ADULT` CRM lead-registration command may prepare an ordinary, unactivated membership for that exact newly registered adult. The flow is deliberately narrow:

```text
verified REGISTERED ADULT conversion
  → explicit current-school preparation
  → human chooses bounded membership term/plan and confirms
  → one receipt-backed DRAFT membership
```

The flow improves continuity after a human registration without declaring enrollment, payment, agreement, eligibility, or revenue success.

## Preconditions and relation proof

The only browser selector is an untrusted `studentProfileId` UUID, optionally carried by a normal same-origin link from a verified `REGISTERED` `ADULT` receipt. It triggers no request or command by itself.

A fixed database preparation routine must independently derive and require all of the following under transaction-local tenant context and forced RLS:

1. exactly one current-school immutable `crm_lead_registration_conversions` record for the selected student with `registration_path = ADULT` and `status = REGISTERED`;
2. an active selected student profile that still points to the conversion’s original lead-contact person; and
3. exactly one current-school `CANONICAL` billing account with that same person as responsible payer.

The returned preparation data is limited to the adult student display label, a derived readiness posture, and the existing canonical account currency. It does not disclose conversion, person, account, family, lead, trial, history, payment, or membership identifiers. Absence, ambiguity, a noncanonical/additional account, `GUARDIAN_CHILD`, or any disallowed context fails closed with no matching-record information and no write.

## Direct-human command

A separate endpoint—not generic `POST /billing/memberships`—will use the existing `hon.memberships` model and its DRAFT persistence semantics. It must require a current active sole `HUMAN_USER` from an explicit direct-human UI transport, exact current school, live `billing.membership.create` permission, active entitlement, trusted origin, JSON, same-origin Fetch Metadata, a closed `X-HON-Human-Command` marker, exact confirmation, and UUID idempotency key. HQ, family, AI, agent/action, automation, integration, delegation, mixed principals, revoked/expired grants, and stale context are denied.

The closed input contains only the selected student UUID, a bounded plan code, optional bounded term start/end, and direct-human confirmation. The service rederives the conversion, person, participant, canonical billing account, and currency inside its transaction; none are browser authority. It writes only one membership in `DRAFT`, normal audit evidence, idempotency outcome, inert `billing.membership.drafted` outbox evidence, and an immutable conversion-to-membership link/evidence. It creates no payment schedule, invoice, payment method, charge, provider operation, communication, agreement, discount, credit, automation, AI work, curriculum enrollment, or activation.

The source conversion, canonical account, memberships, idempotency, and immutable relation/evidence must be locked and revalidated before commit. The same idempotency key with identical closed input replays the stored receipt; changed input is rejected. A distinct key cannot create a second DRAFT membership for the same conversion.

## Explicit exclusions

`GUARDIAN_CHILD` is excluded until a dedicated durable, reviewable payer-designation contract establishes who is responsible. Additional billing accounts are excluded. This workflow neither creates nor chooses an account, changes a payer, infers a family relation, changes `is_billing_contact`, or creates a curriculum enrollment. The already delivered billing-account workbench remains the separate path when an adult canonical account does not exist.

## Implementation shape

The new code should remain localized: shared closed contract, fixed PostgreSQL preparation/relation verifier and additive immutable source link, strict API guard/controller/service that reuses canonical membership persistence where safely factored, a current-school staff page/client workbench, and focused API/browser/database integrity proofs. It must not change shared visual components, avatar assets, the generic membership endpoint, payment providers, or Claude’s experimental work.

## Validation evidence

Migration `0155` was applied through fresh disposable PostgreSQL fixtures. The dedicated adult CRM membership proof passed 116 assertion groups and 216 all-organization-table no-effect snapshots, including canonical verifier, source immutability, relation/account ambiguity, same-key replay, different-key concurrency, authority revocation, rollback, generic-membership non-regression, and zero provider/financial/family/automation effects. Focused API and browser transport/workbench/route/handoff suites passed, followed by `pnpm db:check` at 155 migrations, the complete guarded 10-proof local dispatcher across 5 fixtures, root workspace tests/check/build, and a clean whitespace check. No remote database, provider, payment, communication, deployment, shared visual component, portrait, or Claude experiment was changed.

See [Flexible CRM enrollment and family billing policy](FLEXIBLE_CRM_ENROLLMENT_FAMILY_BILLING_POLICY.md), [Human CRM lead registration](HUMAN_CRM_LEAD_REGISTRATION.md), [Human flexible billing accounts](HUMAN_FLEXIBLE_BILLING_ACCOUNTS.md), and the [Master Directive](../HON_MASTER_DIRECTIVE.md).
