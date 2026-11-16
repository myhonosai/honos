# Memberships live on the contact card (spec)

Owner request (David, 2026-11-16 05:45Z, with a screenshot of Billing > Memberships):

> Membership is tied to student. So these functions should be under contact card.
> I don't get membership activation.
> This section should let me create membership plans. And we make new/renew/upgrade membership under each student or member card.

## Objective

Staff manage a person's membership from that person's contact card, in plain steps: **New membership**, **Renew**, **Change plan** (upgrade or downgrade), **Pause / Resume**, **Cancel**, **Change dates**, **Record a refund**, and **History**. The word "activation" disappears from the staff experience. Billing > Memberships becomes the place to create and edit **membership plans**, plus a read-only **membership report** whose rows open the person's card.

Success looks like this: a school owner opens a student's card, presses **New membership**, picks a plan, checks the start date, presses **Start membership**, and the card shows the membership as current (or "starts on …"). Nothing in that flow says DRAFT or activation. Renewing a fixed-term membership and changing plan are one dialog each.

## What exists today (main 2948d4d, plus the unmerged contact-card chain)

| Capability | Backend | Staff screen today | Notes |
|---|---|---|---|
| Plan catalog: create, revise, list | 0175 `billing/membership-plans` | Billing > Plans | Owner-only permission `billing.membership_plan.manage`. Kept, becomes the Billing landing page. |
| First membership from a plan (DRAFT) | 0175 adult `crm-adult-membership-drafts/from-plan`, 0176 guardian/child from-plan | CRM enrollment flow | Only for a person converted from a CRM lead, and only when the person has **no membership at all**. Cannot be used for a second, renewed or changed membership. |
| Generic DRAFT | `POST billing/memberships` | none | Free-text `planCode`, not bound to the catalog. Not used here. |
| Activation (DRAFT -> ACTIVE) | 0177 preview digest -> confirm | Billing > Activation | Two-step, with warnings, blocks and override reasons. Source must be one of five known DRAFT origins. |
| Dates and history | 0178 effective-period revisions (CORRECTION / EXTENSION / EARLY_END) | Billing > Dates & history | Keyed by membership id. |
| Pause, resume, cancel, refund record | 0224 / 0231 | Billing > Pause, cancel & refunds | Owner policy: staff only, per-school limits, immediate cancel, manual refunds only. Unchanged. |
| Renewal **review** records | 0372-era `staff/billing/renewals` | Billing > Renewals | Planning notes only; they never create a new term. |
| School-wide list | `billing/memberships` list | Billing > Memberships | Read-only already, with an "Activate" link. |
| Contact card | 0374 (#384, draft), merge/archive 0387 (#390, draft) | People | Has a read-only **Membership** tab: plan, state, dates. |

**Gaps:** (1) a plan-bound membership for any existing student or member, not only a first CRM one; (2) renew = the next term of the same person; (3) change plan = end the current membership and start another in one step; (4) a staff flow that hides the DRAFT -> activation step.

## Design

### Staff experience

**Contact card > Membership tab** (People page). For each membership the tab shows the plan, a plain status (Current, Starts on …, Paused until …, Ended, Cancelled, Not started yet) and dates. Buttons depend on status and permission:

| Status | Buttons |
|---|---|
| No current membership | **New membership** |
| Current, fixed term | **Renew**, **Change plan**, **Pause**, **Cancel**, **Change dates**, **History** |
| Current, open-ended | **Change plan**, **Pause**, **Cancel**, **Change dates**, **History** |
| Paused | **Resume**, **Cancel**, **History** |
| Starts later | **Change dates**, **Cancel**, **History** |
| Not started yet (an older DRAFT) | **Finish starting** (opens the same review step), **History** |
| Cancelled | **Record a refund**, **History** |
| Ended | **Renew** (fixed term), **New membership**, **History** |

**New membership / Renew / Change plan** share one dialog:
1. **Pick a plan.** Available plans from the catalog, with price and term. Renew pre-selects the current plan. Change plan lists the other plans.
2. **Check the dates.** HON suggests them (today; the day after the current term ends for Renew; a staff-chosen change date for Change plan). Fixed-term end dates come from the plan.
3. **Review and start.** Shows the server's warnings in plain words (birth date missing, backdated, etc.), asks for a reason only when the server requires an override, and has one **Start membership** button.

Under the hood step 3 calls the new create command and then the existing 0177 preview + confirm. If confirm fails after the create, the card shows the membership as **Not started yet** with **Finish starting**, which reopens step 3. Staff never see the words DRAFT or activation.

**Billing > Memberships becomes three pages** (David, 2026-11-16 05:50Z: "membership agreement, payment options, auto charge method ... 2-3 pages at most"):

1. **Membership**: everything the school sets up once.
   - **Plans**: create and edit plans, with price, how often they're paid (weekly, monthly, annual, paid in full) and term (the existing 0175 catalog). Offering or retiring a plan is the plan's on/off switch. Plans no longer say "activation".
   - **Payment options** per plan: which payment plans a family can choose for that membership (e.g. monthly autopay, or paid in full).
   - **Auto-charge**: the school's automatic charging setup. That means the connected processor, whether autopay is offered, and the sibling discount. It reuses the tuition-collection pieces (payment processors, saved methods, autopay 0322), and live payments stay off.
2. **Agreement & waiver**: the school's membership agreement and liability waiver templates, versioned. They are signed when staff start a membership on a student's card (and at the walk-in kiosk). There is one shared model with the kiosk thread, and it doesn't duplicate the free waiver text on checkout pages (0269).
3. **Import memberships and balances**: the existing onboarding import, unchanged.

Everything about one person (new, renew, change plan, pause, cancel, dates, refunds, history) is on the contact card. The pages that leave the Billing menu are Activation, Dates & history, Pause/cancel & refunds, Renewals and the school-wide list. Their routes stay as unlisted deep links, each with a line pointing to the card. The school-wide membership list moves to **Reports** as a read-only report whose rows open the card. The renewal-review list moves there as well.

The New membership dialog on the card gains a **How they'll pay** step: choose one of the plan's payment options and, for autopay, one of the payer's saved methods. It also gains a **Sign** step for the agreement and waiver in force. Both are recorded, and no charge is made while live payments are off.

### Backend

**0398: start a membership from a plan for an existing person** (`POST billing/people/:personId/memberships/from-plan`).
- Input: `{ membershipPlanId, membershipPlanVersion, kind: NEW | RENEW, startDate (school-local), renewsMembershipId? , confirmation }`, Idempotency-Key required.
- Works for any active (not archived) person with a student profile at the school. The billing account is the person's own for an adult, or the family's billing contact account for a minor. A minor without a guardian of record is refused (same rule as 0177).
- Plan checks are the 0175 ones: current version, AVAILABLE, open program, account currency.
- Overlap rule (owner decision, one per program): refuse when the new term would overlap another current or scheduled membership of the same person **in the same program**.
- RENEW requires `renewsMembershipId` to be the same person's fixed-term membership; the suggested start is the day after it ends. The link is stored as evidence.
- Creates the DRAFT with a plan selection and a new source row (`CONTACT_CARD_PLAN`). 0177's activation evaluation learns this source (replacement function in 0398, not an edit of 0177), so the existing preview/confirm path activates it with all its rules.
- Permission `billing.membership.create` (existing). Audit + outbox, idempotency, forced RLS, lock order and final authority recheck follow 0175.

**0399: change plan** (`POST billing/memberships/:membershipId/plan-changes`).
- Input: `{ expectedVersion, membershipPlanId, membershipPlanVersion, changeDate, reason, confirmation }`.
- In one transaction: the current membership ends the day before `changeDate` through the 0178 EARLY_END revision rules (same invoice and schedule guards), and a new plan-bound DRAFT for the same person and billing account starts on `changeDate`, linked to the old one. The client then runs preview + confirm on the new one as above.
- Refused for paused, cancelled, ended or not-started memberships, and when the old membership has an ACTIVE payment schedule (same reason as pause: the schedule would keep charging).
- Permissions: `billing.membership.create` and `billing.membership.dates.revise`.

**Nothing here moves money.** No proration, charge, invoice, schedule or refund is created. Price differences on a change of plan are the school's to handle; staff can already record a manual refund on a cancelled membership. Live payments stay off.

## Slices (each its own small PR, tests first)

| Slice | What | Migration |
|---|---|---|
| A | Card Membership tab gets the actions that need no new backend: Pause/Resume, Cancel, Change dates, History, Record a refund, Finish starting (existing DRAFTs). Report rows open the card. | none |
| B | New membership + Renew on the card | 0398 |
| C | Change plan on the card | 0399 |
| D | Billing > Memberships as three pages: Membership (plans + payment options + auto-charge), Agreement & waiver, Import. List and renewals move to Reports | none for the layout; per-plan payment options may need one (ask coordinator) |
| E | Agreement & waiver templates and signed records, shared with the kiosk thread; Sign step in the card dialog | to allocate |

Slice A stacks on the contact-card chain (#384 -> #390). B and C stack on A.

## Boundaries

- **Always:** server decides permissions, warnings and blocks; exact-version (stale) checks; Idempotency-Key on every write; school from the verified session; en/ko/es copy; the three views (Modern, Classic, Big Button).
- **Ask first:** proration or any charge on change of plan; letting members change their own plan; bulk renewals.
- **Never:** move money, call a payment provider, auto-renew, or infer permission from the UI.

## Owner decisions

- **More than one membership at once?** Decided by David 2026-11-16 05:50Z: **one per program**. A student may hold memberships in different programs at the same time, never two overlapping in the same program (plans without a program count as one shared "no program" group). Change plan replaces within the program.

## Testing

- Web: unit tests for the status -> buttons table, the dialog state machine (create ok + confirm fails -> Not started yet), copy completeness for en/ko/es, and the menu catalog.
- API: controller tests for routes, guards, idempotency, validation.
- DB proofs (B, C): permission and school isolation, overlap rule, minor without guardian, stale plan version, RENEW link to another person refused, change plan atomicity (both or neither), payment-schedule refusal, replay and key reuse, and activation of the new source through the unchanged preview/confirm path.
- Screenshots: card Membership tab and the dialog at phone 390 and desktop 1440.
