# Flexible CRM enrollment and family billing policy

**Status:** Owner-approved policy direction on 2026-10-18. The first billing-account implementation slice is delivered through migration `0152_flexible_billing_accounts.sql` and the protected direct-human workbench; adult/guardian-child CRM conversion remains future work. This document does **not** authorize payments, provider calls, real customer data changes, communication delivery, deployment, or automatic identity/family/account changes.

## Product intent

HON must support a connected conventional staff journey:

```text
Lead → Trial → Outcome → Start enrollment → Adult or child path
     → verified family/billing responsibility → membership DRAFT → human review
```

The existing Lead → Trial → Outcome work remains a distinct, completed CRM slice. A trial result or `WON` lead can make the next human workflow available, but is never itself a student, guardian, family, enrollment, payer, membership, payment, consent, eligibility, attendance, or conversion fact.

## Approved billing policy: default reuse plus explicit additional accounts

### Default behavior

1. Each responsible payer has one **canonical active billing account** per school by default.
2. Server-side logic checks for a verified matching payer/account before creating a normal account.
3. A current matching canonical account is recommended and reused; browser code must never invent a duplicate rule.
4. One billing account can support multiple students, memberships and later approved payment schedules.
5. Reuse must not create a duplicate invoice, payment schedule, payment method, payment attempt, provider call, or financial responsibility transfer.

### Additional accounts

1. Authorized direct-human staff may explicitly create an **additional** account for the same responsible payer.
2. The command must include a bounded documented business reason and create immutable audit evidence.
3. The existing responsible payer remains explicit. Accounts are never merged automatically and responsibility is never silently transferred.
4. Additional accounts enable separately authorized arrangements only; they do not by themselves create a membership, schedule, invoice, payment method, payment authorization, collection attempt, provider action, or charge.
5. Historical accounts remain intact. Additive schema changes must classify canonical versus additional accounts deterministically without destructive cleanup.

### Implementation implication

The prior temporary one-account-only policy is superseded. The canonical service must implement server-authoritative default reuse and an explicit audited additional-account command mode. Direct-human transport protection, tenant scope, permission, entitlement, idempotency, audit and RLS remain mandatory.

## Approved CRM conversion policy: adult and guardian-child paths

### Adult path

A staff user may explicitly begin an adult-student path for a current lead after authorization and confirmation. The existing lead-contact person can be reused only if server-side current-school checks establish the exact safe relation. A `WON` lead or completed trial only permits the human to begin this review; it does not prove identity, eligibility, consent, student status, payer responsibility or membership eligibility.

### Guardian-child path

A lead contact may be a guardian rather than the student. The guardian remains the contact/guardian; the actual child is a distinct person/student profile. A verified guardian-child relationship and family record are created or explicitly linked through a bounded current-school process. The guardian may become the responsible payer, and a membership DRAFT may later be created for the child through the separate canonical membership path.

The system must never register a guardian as the student merely because that adult submitted the lead.

### Ambiguity and existing records

The server must preserve original lead source, campaign attribution and trial history. Editable contact facts may be corrected by separately authorized staff actions, but immutable attribution evidence is never overwritten.

If an existing person, student, family or relationship could match ambiguously, return a bounded `NEEDS_STAFF_REVIEW` outcome without revealing unrelated IDs, silently merging records, overwriting identities, or inferring a family relationship. Existing verified links and multi-child convenience are later bounded steps, not an authorization shortcut.

## Membership and payment boundary

Membership, billing status, agreement state and payment authorization remain independent state machines.

- A membership may be activated under the existing approved direct-human activation boundary without an invoice or payment initiation.
- A payment schedule may begin only after a valid payment method, approved schedule and applicable payment authorization exist, or an approved alternative arrangement exists.
- A delayed agreement signature alone does not automatically block an otherwise authorized schedule, but no legal consent, payment authorization, provider requirement or school policy may be bypassed.
- This work does not collect payment credentials, create a payment method, schedule, attempt, charge, provider reconciliation, refund, credit, discount, or customer communication. If later collection infrastructure is unavailable, UI must state that next step truthfully.

## Delivery order

1. **Delivered:** Implement default reuse plus explicit additional-account reason/audit policy over the existing billing-account model.
2. **Delivered:** Expose it through a strict direct-human staff surface with server-authorized selectors and no financial-provider effects.
3. Implement explicit adult lead conversion with preserved lead/trial attribution and bounded duplicate review.
4. Implement explicit guardian-child lead conversion, preserving guardian and child identities separately.
5. Reuse the existing canonical membership-DRAFT path once payer, participant and account relations are verified; do not build a parallel membership model.
6. Add verified existing-record linking and multi-child convenience only after their own ambiguity/review contracts exist.

## Non-negotiables

All work reuses the existing PostgreSQL tenant model, forced RLS, current principal/school permission checks, idempotency, immutable audit/outbox pattern and separate HQ/staff/family contexts. URL and UI values are untrusted selectors, never authority. No generic directory, broad cross-family lookup, raw SQL client path, model-granted authority, external delivery, deployment, payment collection or destructive migration is authorized.

See [HON Master Directive](../HON_MASTER_DIRECTIVE.md), [External Agent Handoff](../EXTERNAL_AGENT_HANDOFF.md), [Owner Launch Lifecycle](OWNER_LAUNCH_LIFECYCLE.md), and the current [TODO](../../TODO.md) for the wider product and collaboration context.
