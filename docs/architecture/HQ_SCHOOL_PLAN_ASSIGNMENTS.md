# HQ school plan assignments (migration 0676)

Status: source only, not deployed. Records a plan; **charges nothing**. Owner ask 2026-11-24 (David): open or add a school in
HQ and give it a published HON OS offer or a custom plan, change it, or remove it, like GoHighLevel's "assign SaaS plan" and
"special price" for one sub-account. Spec: `/mnt/project-files/plan-assignment/SPEC.md`.

## Owner decisions (2026-11-24 05:35Z, decision cards)
1. Custom price: any amount from $0 to $100,000; a free plan may last forever (end date optional).
2. Price change for a paying school: applies right away, the part-period difference charged or credited (billing piece B).
3. Remove for a paying school: renewals stop, access until the paid time runs out, no refund (billing piece B).
Decisions 2 and 3 need the billing piece; this piece only records the plan.

## Model
`hon.hq_school_plan_assignments`: append-only rows per organization (`revision` 1, 2, …). `ASSIGN` from an offer of the
**published, not stopped** offer set freezes its kind, interval, price, founder flag and set version; `ASSIGN` custom stores
name, MONTHLY/ANNUAL, price and an optional `free_until` (only when price is 0, after today, within three years). `REMOVE`
clears the plan. Current plan = latest revision. Table CHECKs back every rule. `hon.hq_school_plan_requests` stores exact
receipts for idempotent replay (actor + key; same key with a different body is refused). Both tables: forced RLS, no grants,
UPDATE/DELETE/TRUNCATE refused by trigger even for the owner role.

Assigning a founder offer does **not** reserve a founder spot; spots are still counted at first payment (founder piece 4).
A new offer price version never changes an assigned plan; the retired offer can no longer be newly assigned.

## Authority and API
| Route | Who | Function |
|---|---|---|
| `GET /v1/hq/schools/:schoolId/plan` | HQ owner, or HQ operator with `hq.billing.manage` (read only, `viewer.canManage=false`) | `read_hq_school_plan` |
| `POST /v1/hq/schools/:schoolId/plan/assign` (`hq-school-plan-assign`) | HQ owner | `assign_hq_school_plan` `{expectedRevision, plan, note}` |
| `POST /v1/hq/schools/:schoolId/plan/remove` (`hq-school-plan-remove`) | HQ owner | `remove_hq_school_plan` `{expectedRevision, note}` |

`plan` is `{source:'OFFER', offerId}` or `{source:'CUSTOM', name, billingInterval, priceMinor, freeUntil}`. Commands need an
`Idempotency-Key` UUID and the same-origin human-command header. Refusals: `SAAS_VERSION_CONFLICT` (409),
`HQ_SCHOOL_PLAN_OFFER_NOT_AVAILABLE`, `HQ_SCHOOL_PLAN_NO_CHANGE`, `HQ_SCHOOL_PLAN_NONE`, `HQ_SCHOOL_PLAN_SCHOOL_ARCHIVED`,
`HQ_SCHOOL_PLAN_FREE_END_INVALID`, `HQ_SCHOOL_PLAN_END_DATE_ONLY_WHEN_FREE` (422). The read also returns what the school is on
today from existing records (`onNow`: TRIAL/MONTHLY/ANNUAL/ONE_TIME/NONE), the assignable offers, and `effect: RECORD_ONLY`,
`charging: OFF`. Contracts: `packages/contracts/src/hq-school-plans.ts`.

## Not in this piece
School-facing view of the assigned plan, a checkout at the assigned (custom) price, proration on change, stop-renewal on
remove. That is billing piece B and needs David's explicit merge approval. No subscription, checkout, schedule binding,
entitlement, access exception, founder reservation, credit or offer is created or changed here.

## Evidence
- `packages/database/scripts/test-hq-school-plans.mjs` (disposable Champions Club fixture, 7 groups).
- `apps/api/test/hq-school-plans.test.cjs` (contracts + HTTP wiring and error mapping).
- `infra/postgres/010`/`011` blocks, `verify-rls.mjs` tables, staging manifest pinned at 0676.
