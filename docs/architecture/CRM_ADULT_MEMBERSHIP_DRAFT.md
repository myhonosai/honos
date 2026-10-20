# Adult CRM registration to membership DRAFT

**Status:** Implemented and validated on the isolated `manus/crm-enrollment-workflow` branch. This is an adult-only conventional staff workflow following a verified CRM lead-registration receipt. Its historical creation receipt is distinct from the later explicit source-bound current-DRAFT confirmation. It does not authorize guardian-child payer inference, payment collection, schedules, invoices, charges, provider calls, messages, AI execution, activation, or deployment.

## Intent

A staff member who has completed the bounded `ADULT` CRM lead-registration command may prepare an ordinary, unactivated membership for that exact newly registered adult. The flow is deliberately narrow:

```text
verified REGISTERED ADULT conversion
  → explicit current-school preparation
  → human chooses bounded membership term/plan and confirms
  → one historical receipt-backed DRAFT membership
  → separate explicit current-DRAFT confirmation before activation review
```

The flow improves continuity after a human registration without declaring enrollment, payment, agreement, eligibility, or revenue success.

## Preconditions and relation proof

The only browser selector is an untrusted `studentProfileId` UUID, optionally carried by a normal same-origin link from a verified `REGISTERED` `ADULT` receipt. It triggers no request or command by itself.

A fixed database preparation routine must independently derive and require all of the following under transaction-local tenant context and forced RLS:

1. exactly one current-school immutable `crm_lead_registration_conversions` record for the selected student with `registration_path = ADULT` and response `outcome = REGISTERED`;
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

## Separate activation handoff

Only a successful current source-bound adult DRAFT confirmation may display a normal same-origin link to the existing membership-activation workbench. A historical creation receipt never proves current state and cannot display the link. The link carries exactly one untrusted `membershipId` UUID. The activation route accepts that scalar as initial form text only; it does not receive organization/school, student, source conversion, payer/account, plan/term, receipt metadata, authority, scope, or command state. It remains inert until a staff member supplies the organization and school, explicitly loads the current membership, and completes the unchanged current-human, permission, entitlement, state/version, and direct-human activation confirmation boundary.

The link is not an activation wrapper and is absent for missing, invalid, uncertain, non-DRAFT, or unverified states. It creates no enrollment, membership/term alteration, account, agreement, schedule, invoice, payment method, charge, provider, communication, curriculum/attendance, AI, Action Engine, or automation effect. The activation workbench retains its memory-only clearing and exact uncertain-command retry behavior.

## Validation evidence

Migrations `0162` and `0163` were applied through fresh disposable PostgreSQL fixtures. The dedicated adult CRM membership proof passed 153 assertion groups and 284 organization/all-table no-effect snapshots, including canonical verifier/body hash/signature/ACL/no-overload checks; source immutability; creator-only current confirmation; relation/account ambiguity; same-key historical replay; different-key concurrency; active/plan/schedule/invoice drift refusal; authority revocation; rollback; generic-membership non-regression; and zero provider/financial/family/automation effects. Focused API (4 tests) and browser transport/workbench/route/handoff (5 files / 20 tests) suites passed. The reconciled branch then passed `pnpm db:check` at 163 migrations, the guarded 17-proof local dispatcher across 5 fixtures with forced RLS verified across 240 tracked operational tables, root `pnpm test` (440 tests), `pnpm check`, `pnpm build`, and clean staged/unstaged whitespace checks. An independent read-only review found no confirmed issue. No remote database, provider, payment, communication, deployment, shared visual component, portrait, or Claude experiment was changed.

See [Adult CRM membership DRAFT current confirmation](CRM_ADULT_MEMBERSHIP_DRAFT_CONFIRMATION.md), [Flexible CRM enrollment and family billing policy](FLEXIBLE_CRM_ENROLLMENT_FAMILY_BILLING_POLICY.md), [Human CRM lead registration](HUMAN_CRM_LEAD_REGISTRATION.md), [Human flexible billing accounts](HUMAN_FLEXIBLE_BILLING_ACCOUNTS.md), and the [Master Directive](../HON_MASTER_DIRECTIVE.md).
