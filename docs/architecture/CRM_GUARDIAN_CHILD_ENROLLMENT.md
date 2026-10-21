# CRM guardian/child enrollment (migration 0176)

Status: implemented on branch `claude/project-thread-xsrj9t`, not merged, not deployed. No production migration was run.

This milestone takes one verified GUARDIAN_CHILD CRM registration (0160/0169) to one plan-bound membership **DRAFT** per child, under one explicitly designated guardian payer. It ports the unique behaviour of PR #27 (migrations 0164–0167) onto the 0169 canonical lock order and the 0175 plan catalog, and extends it to more than one child under the same verified guardian. PR #27 was read only; none of its files, numbers or bodies are reused.

Nothing here creates a payment schedule, invoice, charge, payment method, agreement, consent, provider call, communication, activation, Action Engine/AI or automation effect.

## Flow

1. **Registration (unchanged).** Staff register a WON lead on the `GUARDIAN_CHILD` path (0160). The lead's contact is the guardian; the child is a new, separate person with a STUDENT profile, both in one new family. 0176 adds an `AFTER INSERT` trigger on `crm_lead_registration_conversions` that records an immutable child snapshot (`crm_guardian_child_enrolled_children`, origin `CRM_REGISTRATION`) inside the same transaction. It checks that the profile, person and family members were created in that transaction. There is **no backfill**: registrations recorded before 0176 have no snapshot and read as `NEEDS_STAFF_REVIEW`.
2. **Billing account (unchanged command).** Staff create the guardian's canonical billing account with the existing billing-account command. 0176 never creates an account.
3. **Payer designation (new).** `designate_crm_guardian_child_payer` records, once per family, that the source guardian pays through that canonical account, after a direct-human confirmation. It sets `is_billing_contact` on the guardian's family member row and writes audit `billing.guardian_payer.designate` and outbox `billing.guardian_payer.designated` (`executionAllowed: false`).
4. **Additional children (new, optional).** `add_crm_guardian_child_additional_child` adds a new child person, STUDENT member and profile to the same family, with the family's lead attribution (`source_lead_id`, `conversion_id`). The family limit is 10 children (`CRM_GUARDIAN_CHILD_LIMIT`).
5. **Child DRAFT from plan (new).** `draft_crm_guardian_child_membership_from_plan` creates one `DRAFT` membership per child. The membership is billed to the designated guardian's canonical account, with the child as participant. It is bound to the exact current published plan version through the 0175 `membership_plan_selections`, using the same stale, unavailable, currency and fixed-term rules as the adult plan-bound DRAFT.
6. **Read (new).** `read_crm_guardian_child_enrollment` returns the family state and every child's state for Resume Setup.

## Identity, payer and relationship rules

- **Separate people.** The guardian and every child are separate `people` rows. A child is never the lead contact, and the guardian is never a STUDENT member. The snapshot pins the child's person, member, profile, name and birth date; any later difference is staff review.
- **Nothing inferred from lead contact data.** The guardian relation comes only from the staff-attested GUARDIAN_CHILD registration. Payer responsibility needs two more explicit staff acts: the account command and the designation. A lead that was never registered, or was registered as an adult, can never be designated (404). The designation input has no person, account or relationship field; the server picks the only eligible account.
- **Only the canonical account.** The designation uses the guardian's `CANONICAL` account. An `ADDITIONAL` account is never selected. With no canonical account the command returns `CRM_GUARDIAN_CHILD_BILLING_ACCOUNT_REQUIRED` and writes nothing.
- **Exact family shape.** The family must be ACTIVE and contain exactly the source guardian plus children recorded in the snapshot table for this conversion. The guardian must belong to only one family. No member other than the guardian may be a billing contact. A co-guardian, an unknown member, a second family, a cleared or competing billing-contact projection, a changed lead contact or an archived family makes the family `NEEDS_STAFF_REVIEW`. Nothing is relinked, merged or chosen.
- **Ambiguous new children.** Adding a child whose normalized given and family name matches any person at the school, or whose family name and birth date match any student profile, returns `{ outcome: 'NEEDS_STAFF_REVIEW' }`. The whole transaction rolls back, including the key reservation, so nothing is written. Twins of an enrolled child therefore always go to staff review (see owner decisions).
- **Existing memberships.** A child who already has a membership that was not created by this workflow reads as `NEEDS_STAFF_REVIEW` and cannot be drafted. PR #27's generic membership insert trigger is not ported.

## Read states

Family `workflowState`:

| State | Meaning | Extra fields |
| --- | --- | --- |
| `NOT_REGISTERED` | WON lead, not registered, no existing record for the contact | none |
| `NEEDS_STAFF_REVIEW` | Not registered but the contact already has a profile or family membership, or the registered family no longer matches its recorded shape | none |
| `ADULT_REGISTRATION` | Registered on the ADULT path; use the 0174 adult recovery | none |
| `BILLING_ACCOUNT_REQUIRED` | Registered family, the guardian has no canonical account | receipt, guardian, children |
| `PAYER_DESIGNATION_REQUIRED` | Canonical account exists, no designation yet | + `billingAccount` |
| `PAYER_DESIGNATED` | Current designation | + `payerDesignation` |

Child `workflowState`: `AWAITING_PAYER_DESIGNATION`, `READY_FOR_DRAFT`, `CURRENT_DRAFT` (the creator sees the receipt and the bound plan version), `CURRENT_DRAFT_BY_OTHER_STAFF` (yes/no only, no receipt, membership id or creator), or `NEEDS_STAFF_REVIEW`. `historicalRegistrationReceipt` is the immutable registration response, never proof of current state. `billingAccount` discloses only classification and currency.

The adult 0174 recovery is unchanged and still returns `NEEDS_STAFF_REVIEW` for a guardian/child lead; the guardian/child read never discloses adult workflow details. All six adult Resume Setup states are preserved. The 0163 creator-only confirmation is not modified or broadened.

## Authority

Every function requires the 0160 GUARDIAN_CHILD registration actor (`crm.lead.read`, `crm.lead.register`, `student.profile.manage`, `people.create`, `family.create`, `family.member.manage`) who is also the adult DRAFT actor (`billing.membership.create`, `billing.account.create`), as a direct HUMAN_UI principal with no action request or delegation, in the current organization and school, with an active entitlement. Authority is re-checked after the locks, on replay and before return. Suspended entitlement, revoked grants, a family-portal extra role, another school or organization, or a forged session setting are refused. The URL scope is only a selector; the API resolves the live registration scope from the signed identity.

## Idempotency, audit and lock order

Commands reserve their own key row first (`INSERT … ON CONFLICT DO NOTHING`), never lock `idempotency_records`, and refuse a reused key with different input (`IDEMPOTENCY_KEY_REUSED`) before any domain fact is evaluated. A replay returns the stored historical receipt with `replayed: true`. Then, in the 0169 canonical order:

| Workflow | Lock sequence |
| --- | --- |
| Family read | IAM SHARE → people … memberships, then `crm_guardian_child_enrolled_children`, `crm_guardian_child_payer_designations`, `crm_guardian_child_membership_draft_sources`, `membership_payment_schedules`, `invoices` SHARE |
| Payer designation | key → IAM SHARE → people … `billing_accounts`, `crm_guardian_child_payer_designations` SRE → insert, member projection update → audit, outbox → key update |
| Additional child | key → IAM SHARE → exactly the 0169 registration set (people … conversions) plus `crm_guardian_child_enrolled_children` SRE → inserts → audit, outbox → key update |
| Child DRAFT from plan | key → IAM SHARE → the 0169 DRAFT set people … `memberships` SRE → enrolled children, designations SHARE → child DRAFT sources SRE → `membership_plans`, `membership_plan_versions` SHARE → inserts (membership, source, selection) → audit, outbox → key update |

All three new tables are private (forced RLS, no policies, no runtime grants) and immutable (update, delete and truncate guards). The runtime role can execute only the four entry points.

## Evidence

- `test-crm-guardian-child-enrollment-integrity.mjs` (flexible-billing fixture, CI): 266 assertions covering posture, snapshot capture, every read state, designation, additional children, per-child DRAFTs, refusals, drift, immutability, races and a family-proof ablation, with zero schedule, invoice or payment rows.
- `test-crm-owner-launch-lock-order-integrity.mjs`: four new workflows; all 1,332 interleavings of 18 workflows commit with 0169 bodies. The pre-0169 matrix stays at the 14 legacy workflows (756 cells, 30 expected failures).
- `apps/api/test/crm-guardian-child-enrollment.test.cjs`: contracts, real Nest guards, service mapping and migration text checks.

## PR #27 inventory and reuse

| PR #27 piece | Decision |
| --- | --- |
| 0164 per-conversion payer designation | Reused as a concept: explicit staff designation of the source guardian through the canonical account. Re-implemented per family (so all children share one payer), with IAM in SHARE instead of SHARE ROW EXCLUSIVE, the key reserved first and evidence last |
| 0165 child DRAFT source | Reused as a concept, now plan-bound only (no free-text plan code), one per child |
| 0165 generic membership insert guard trigger | Not ported. It changed every membership insert path; a pre-existing child membership is instead a staff-review outcome |
| 0166 creator confirmation | Folded into the read: creator sees the receipt and plan, other staff see yes/no only. 0163 is not touched |
| 0167 source-facts capture trigger | Reused as a concept for the child snapshot, without backfill |
| `CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT.md` | Superseded by this document |
| Single-child limit | Extended: up to 10 children per family |

## Owner decisions (open)

1. Co-guardians and choosing a payer other than the registration contact (deferred; such families are staff review).
2. A staff-review resolution path (link an existing person, confirm twins, retire a stale family). Today staff review is terminal in the product.
3. Whether to backfill snapshots for GUARDIAN_CHILD registrations recorded before 0176.
4. Family limit of 10 children.
5. Activation, payment schedules, sibling discounts, agreements and guardian consent for children's memberships (all out of scope).
6. Whether to offer a free-text child DRAFT (not provided; the plan-bound route is the only one).

## Residuals

- CI database-proof job timeout raised from 15 to 25 minutes; the new matrix cells add about 3.5 minutes.
- No frontend in this PR; see the [Codex handoff](../CODEX_CRM_GUARDIAN_CHILD_ENROLLMENT.md).
- The plan options read is the existing adult `plan-options` route; its authority (`billing.membership.create`) matches the child DRAFT actor.
