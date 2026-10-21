# School membership plan catalog (migration 0175)

**Status:** Branch `claude/project-thread-vf7rij`, not merged, not deployed. Evidence comes from disposable localhost PostgreSQL only. No production migration, payment, schedule, invoice, charge or provider call is part of this work.

## What this is, and what it is not

A **school membership plan** is what one school sells to its own students and families: for example "Adult Unlimited Monthly, $149/month" or "12 months paid in full". It is published per school by that school's authorized staff.

It is **not** HON OS's own Core/Complete SaaS subscription. That catalog (`saas_catalog_offers`, migration 0154) is what a school pays HON. The two catalogs share no table, permission, price or code path.

Each school starts with an empty catalog. No school's pricing or policy, including Ideal Martial Arts, is seeded or hard-coded. Programs come from the school's existing `hon.programs` records.

## Data model

| Table | Holds | Mutability |
| --- | --- | --- |
| `membership_plans` | Stable identity: school, immutable `plan_code` (`^[A-Z0-9][A-Z0-9_-]{0,39}$`, unique per school), `current_version` | Only `current_version` (+1, to an existing version) and `updated_at` change. Never deleted |
| `membership_plan_versions` | One complete set of published terms per version | Append-only, gapless per plan. Never updated or deleted |
| `membership_plan_selections` | The exact plan version one membership was created from | Immutable. Memberships from other paths have no row |

All three are private: RLS enabled and forced, no policy, no runtime table grant. They are reachable only through the five definer functions below.

### Published terms (one version)

| Field | Rule |
| --- | --- |
| `displayName` | 1–120 characters, trimmed, no control characters or `<>` |
| `description` | Optional, up to 500 characters, same character rules |
| `programId` | Optional. A current-school program that is not `CANCELLED` or `COMPLETED` |
| `availability` | `AVAILABLE` (offered to enrollment staff) or `UNAVAILABLE` (kept, not offered) |
| `currency` | ISO 4217 code, upper case |
| `priceMinor` | Integer minor units, 0 to 100,000,000. It is the price **per billing period** |
| `billingFrequency` | `WEEKLY`, `MONTHLY`, `ANNUAL` or `PAID_IN_FULL` (one price for a whole fixed term). These are the cadences the existing `membership_payment_schedules` model can later represent, plus paid in full |
| `termKind` | `OPEN_ENDED` (continues until a separate governed change) or `FIXED_MONTHS` |
| `termMonths` | Required for `FIXED_MONTHS` (1–60), absent for `OPEN_ENDED` |

Cross-field rules: `PAID_IN_FULL` requires a fixed term. An `ANNUAL` fixed term must be a whole number of years.

There is deliberately no field for discounts, registration fees, agreements, payment start dates, auto-renewal, tax, class limits or eligibility. Those need owner decisions (below). The closed contract rejects any such field rather than ignoring it.

## Historical terms

Changing a published price never edits a version. A revision publishes the next version and moves `current_version`. Every membership drafted from a plan stays bound, through `membership_plan_selections`, to the version the staff member reviewed. Its replay keeps returning those terms. Nothing reprices an existing membership.

## Commands and reads

All five functions are `SECURITY DEFINER` with `search_path=pg_catalog, hon`. They are the only runtime `EXECUTE` grants. All of them require a current, active, sole `HUMAN_USER` principal from a direct human UI request. That principal must have no HQ, family, AI, action or delegation context, a staff grant at the exact school, the stated permission and an ACTIVE entitlement. The checks run before locks, after locks and before return.

| Function | Route (`/v1/organizations/:org/schools/:school/billing/…`) | Permission | Effect |
| --- | --- | --- | --- |
| `read_school_membership_plan_catalog` | `POST membership-plans/catalog`, body `{}` | `billing.membership_plan.manage` | Every plan at its current version, plus the school's selectable programs. No DML, no locks |
| `create_school_membership_plan` | `POST membership-plans` + `Idempotency-Key` | `billing.membership_plan.manage` | Plan head and version 1, audit `billing.membership_plan.create`, inert outbox `billing.membership_plan.published` |
| `revise_school_membership_plan` | `POST membership-plans/:planId/revisions` + `Idempotency-Key` | `billing.membership_plan.manage` | Next version (`expectedVersion` must be current), audit `billing.membership_plan.revise` with prior and next terms, inert outbox |
| `read_crm_adult_membership_plan_options` | `POST crm-adult-membership-drafts/plan-options`, body `{}` | `billing.membership.create` (the 0162 DRAFT actor) | `AVAILABLE` plans at their current version whose program is open. No DML, no locks |
| `draft_crm_adult_membership_from_plan` | `POST crm-adult-membership-drafts/from-plan` + `Idempotency-Key` | `billing.membership.create` (the 0162 DRAFT actor) | One adult DRAFT bound to the exact plan version |

`billing.membership_plan.manage` is a new sensitive, staff-assignable permission. 0175 grants it only to existing system `OWNER` roles.

Outbox events carry `executionAllowed: false` and `humanOnly: true`. No consumer acts on them.

### Plan-bound adult DRAFT

The browser sends only selectors: `studentProfileId`, `membershipPlanId`, the `membershipPlanVersion` it displayed, an optional `termStartedAt` and the confirmation `I_CONFIRM_DIRECT_HUMAN_ADULT_CRM_MEMBERSHIP_DRAFT_FROM_PLAN`. The server then:

1. re-derives the adult conversion, person, canonical billing account and currency exactly as the 0162 DRAFT does (`crm_adult_membership_relation`);
2. requires the plan to belong to the current school, `membershipPlanVersion` to equal the current version (`MEMBERSHIP_PLAN_VERSION_STALE` otherwise), the version to be `AVAILABLE` with an open program, and the plan currency to equal the payer account currency;
3. copies the plan's `plan_code` into `hon.memberships.plan_code`. For a fixed term with a start, it derives `term_ends_at` as start + `termMonths` UTC calendar months (end-of-month clamped). Otherwise both ends stay unset;
4. writes the membership in `DRAFT`, the 0162 `crm_adult_membership_draft_sources` row with the ordinary six-key receipt, the plan selection, audit (`billing.membership.create`, receipt plus `membershipPlanId`/`membershipPlanVersion`), inert `billing.membership.drafted` outbox and the idempotency outcome.

Because the receipt and source row have exactly the 0162 shape, the **unchanged** 0163 current-DRAFT confirmation and 0174 registration recovery read a plan-bound DRAFT as an ordinary current DRAFT. Same key and input replay the historical creation, with the original plan version's terms. A fresh key cannot draft the same adult twice, through either route.

It creates no payment schedule, invoice, payment method, charge, provider operation, agreement, discount, credit, communication, automation, AI work or activation.

The existing free-text adult DRAFT route (`POST crm-adult-membership-drafts`, 0162/0169) is unchanged and still accepts any bounded plan code. Retiring it is an owner decision.

## Lock order

The canonical 0169 order gains the catalog between the DRAFT sources and payment schedules:

`… billing_accounts, memberships, crm_adult_membership_draft_sources, membership_plans, membership_plan_versions, membership_plan_selections, membership_payment_schedules, invoices`

- Plan create/revise: key reservation, then IAM SHARE, then `membership_plans` and `membership_plan_versions` in SHARE ROW EXCLUSIVE, then audit and outbox.
- Plan-bound DRAFT: key reservation, then IAM SHARE, then the exact 0169 DRAFT set in SHARE ROW EXCLUSIVE, then `membership_plans` and `membership_plan_versions` in SHARE, then the selection insert, then audit and outbox. SHARE blocks a concurrent revision of the plan until commit and never blocks another DRAFT.
- The two reads take no locks. A stale read is harmless because every command re-verifies the exact version it was given.

The lock-order matrix (`test-crm-owner-launch-lock-order-integrity.mjs`) adds both new commands as workflows paused at every lock stage against every other workflow.

## Evidence

- `test-school-membership-plan-catalog-integrity.mjs` (flexible-billing fixture, local and CI): 208 assertions. It covers exact body/ACL/overload posture, private tables, no seeded plan (every plan and version traces to an audited human command), empty start, publication, replay, key reuse, a duplicate-code race, closed term rules both in the service and directly in PostgreSQL, and permission, school, organization, identity, forged-context and entitlement refusals. It also covers immutable versions (UPDATE/DELETE/gap/TRUNCATE refused), stale and unchanged revisions, AVAILABLE-only options, and the plan-bound DRAFT with a derived fixed term and exact selection, read back through 0163 and 0174. Further cases: replay after a price change keeps the original terms; stale, unavailable, unknown, foreign-school, currency-mismatch and cancelled-program refusals; revision vs DRAFT races in both arrival orders. An ablation shows a DRAFT without the version check binds unreviewed terms. No schedule, invoice or payment row appears anywhere.
- `apps/api/test/school-membership-plans.test.cjs`: closed contracts and verifiers, real Nest guards for all five routes (marker, Fetch Metadata, origin, key rules, closed bodies, query refusal, live-scope permission), service context checks and error mapping, and migration-shape checks.
- `infra/postgres/010` grants only the five functions; `011` pins every 0175 body hash, the triggers, the private tables and the permission.

## Owner decisions required before further implementation

1. **Discounts.** Which kinds exist (family/sibling, multi-program, military or first-responder, promotional codes, staff discretion). Who may apply them, the caps and approvals, whether they stack, and whether a discount is part of a plan version or applied per membership.
2. **One-time fees.** Registration, uniform or testing fees: part of a plan, separate catalog items, or out of scope.
3. **Agreements.** Whether a plan requires a membership agreement, which template, and whether a signature is required before current-DRAFT confirmation, activation or the first payment. The existing policy says a delayed signature alone does not block an otherwise authorized schedule.
4. **Payment start.** When billing starts: at activation, on the first class, on a fixed billing day, or on the term start. Also whether the first period is prorated, and what the term start defaults to when staff leave it blank.
5. **Renewal at the end of a fixed term.** Stop, renew into the plan's current version, renew at the original terms, or convert to open-ended. Also any notice period.
6. **Price changes for existing members.** Implemented default: existing memberships keep their version, nothing reprices. Confirm, and decide whether any later repricing path is wanted.
7. **The free-text DRAFT route.** Keep the 0162 free-text adult DRAFT until Codex switches to plans, then disable it, or keep both. The generic `POST /billing/memberships` and the Owner Launch DRAFT also still take free-text plan codes.
8. **Other cadences.** Every two weeks, quarterly or semiannual would also need the payment-schedule model extended.
9. **Who manages the catalog.** 0175 grants `billing.membership_plan.manage` only to system OWNER roles. Decide whether managers or front desk staff get it.
10. **Tax, eligibility and class limits.** Taxable prices, age or rank eligibility per plan, and classes-per-week limits are not modeled.
11. **Multi-location organizations.** Plans are per school. Decide whether an organization-wide catalog shared across locations is wanted.

## Remaining dependencies

- Codex frontend: catalog management and the plan picker in the adult DRAFT step ([handoff](../CODEX_SCHOOL_MEMBERSHIP_PLANS.md)).
- A read of the plan terms bound to an existing membership (for current-DRAFT confirmation, recovery and activation review) is a small follow-up. Today those reads show the plan code only.
- The guardian/child CRM port (PR #27, 0164–0167, untouched) should use the same plan-bound pattern when it is ported.
- Turning plan terms into payment schedules or invoices is a separate, later milestone that depends on decisions 1–5.
