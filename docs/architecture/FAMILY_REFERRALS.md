# Family referrals (0604)

Owner ask (2026-11-20, David): "referral section [in the HON Family app]. Where they get link to send to contacts. Track
how many they referred. What reward they get. Which is link to crm referral system."

This is the **school's own family referral program** (a family refers a friend to the school). It is a different thing
from HON Champions Club (0148-0157) and the 0325 founder credit, which are HON-to-school.

## What existed on main before this work

| Area | State |
| --- | --- |
| CRM lead source | `crm_leads.source_code` (free text) and immutable creation-time attribution (0073). Demo data uses `REFERRAL` as a source. |
| Campaigns | 0073 school campaigns with a `REFERRAL` channel; aggregate attribution only. |
| Public lead forms | 0075 published forms with hardened public intake (`hon.submit_public_form`): rate limits, 24 h replay receipts, duplicate-payload handling, entitlement, pipeline and campaign checks. |
| Family referrals | **Absent.** No per-family link, no referral record, no reward record, no staff screen, nothing in the app. |

So this work adds the referral program on top of the public lead form intake instead of a second lead intake.

## What it does

1. **Staff turn it on** (Marketing > Referrals). They pick one of the school's PUBLISHED public lead forms (the form the
   friend fills in), write the reward the referring family gets ("One free month of classes"), optionally an offer for the
   friend ("Free trial week") and the rules ("Given after your friend's first paid month"), and a default share message.
2. **A family opens More > Refer a friend** in the app. The first time, the app asks the school for the family's personal
   link (one per family per school). The family shares it with the phone's share sheet (text, email, any app).
3. **The friend opens the link** (`<HON site>/refer/<code>`): a page with the school's name, the friend offer and the
   form. Sending it creates a normal CRM lead through the same intake as the public form (same pipeline stage and
   campaign as that form) and records that this family referred that lead.
4. **The family sees** how many friends they referred, how many joined, how many rewards were given, the school's reward
   and rules, and a list of their referrals with the date, status and reward state. **No friend's name or contact is shown.**
5. **Staff see** every referral (family, friend, lead status, flags) and record the reward decision: *Reward given* or
   *Not eligible* (with an optional note), or put it back to *Not decided yet* (with no note).

## Rules

| ID | Rule |
| --- | --- |
| F1 | Reward is the school's own words. Recording *Reward given* is a record only: **no money, invoice credit, tuition credit or HON credit moves**. The school gives the reward its own way. No new commercial policy. |
| F2 | Family scope comes only from the verified session (0530 path, `resolve_parent_journey_scopes`, exactly one current family). No school or family selector is accepted. Issuing a link needs a GUARDIAN grant; reading works for any live grant (a VIEWER sees the program and counts but never gets or creates the link). |
| F3 | One code per (school, family): 16 lowercase hex characters (64 bits taken from the SHA-256 of two random UUIDs). Issuing is idempotent (the same family always gets the same code). The code names no person. |
| F4 | A link works only while: the program is ON, its form is PUBLISHED and readable by `hon.read_published_form` (which also needs a live school entitlement), and the family is ACTIVE with a live grant at the school. Otherwise the public page answers "not available" (same answer for every reason). |
| F5 | The public submission calls `hon.submit_public_form` **unchanged**. A referral is recorded only for a lead that this same transaction created (first touch): a replay, or a submission that 0075 folds into an existing lead, records nothing new and never moves an existing lead to a referrer. |
| F6 | Flags for staff, set at intake: `SELF` (the friend's email or mobile matches a person in the referring family) and `EXISTING_CONTACT` (another person at the school already has that email or mobile). `SELF` referrals are not counted or listed for the family. Staff decide rewards. |
| F7 | Extra public rate limit per code: 30 attempts per hour (on top of 0075's per-form and per-contact limits), using 0075's rate table. In front of SQL, submissions share the per-client `book` allowance used by other public submissions (agreement links, bookings). |
| F8 | Family status of a referral comes from the lead: OPEN = *Interested*, WON = *Joined*, LOST or ARCHIVED = *Didn't join*. |
| F9 | Staff permissions: `crm.referral.read` (see program and referrals) and `crm.referral.manage` (change the program, record rewards). Granted to the system OWNER role. Same human-UI actor rules as other staff commands. Changes are versioned (expected version), idempotent per actor and key, audited and put on the outbox (`internalOnly`). |
| F10 | Turning the program OFF stops new referrals at once; existing records and reward decisions stay. |
| F11 | Runtime gets EXECUTE on the entry functions only. New tables are forced-RLS with no runtime table privilege. |
| F12 | Staff and family counts leave out `SELF` referrals in every figure. Staff still see `SELF` rows in the list, flagged. The staff list shows names as one clean display line (control characters removed, capped); stored names are unchanged. Lock order everywhere: org, school, program, form. |

## Interfaces

| Who | Endpoint | Database |
| --- | --- | --- |
| Family | `GET /v1/parent/referrals` | `hon.read_parent_referrals(text)` |
| Family | `POST /v1/parent/referrals/link` (no body) | `hon.issue_parent_referral_link(text)` |
| Public | `GET /v1/public/referrals/:code` | `hon.read_public_referral(text)` |
| Public | `POST /v1/public/referrals/:code/submissions` (same body as public forms, `Idempotency-Key`) | `hon.submit_family_referral(text,jsonb,text)` |
| Staff | `GET /v1/organizations/:org/schools/:school/marketing/referrals` | `hon.read_school_referrals(text)` |
| Staff | `POST /v1/organizations/:org/schools/:school/marketing/referrals/program` (`Idempotency-Key`) | `hon.configure_school_referral_program(text,jsonb,text,uuid,uuid)` |
| Staff | `POST /v1/organizations/:org/schools/:school/marketing/referrals/:referralId/reward` (`Idempotency-Key`) | `hon.decide_family_referral_reward(text,uuid,jsonb,text,uuid,uuid)` |

The share link is `HON_PUBLIC_ORIGIN + "/refer/" + code`, built by the API on each read, never stored.

## Not in this work

- Automatic rewards (credit to the family's invoices, tuition credit, gift cards). Would need David's commercial decision.
- Referral contests and leaderboards for families (vision 14.2).
- Sending messages to the friend. HON sends nothing; the family shares the link themselves.
- Showing the referrer in the CRM lead card. The staff Referrals page names each friend and their lead status; staff open the lead from Leads.

## Slices

| PR | Content |
| --- | --- |
| A | Migration 0604, API, contracts, DB proof, API tests. |
| B | Web: staff Marketing > Referrals page and public `/refer/[code]` page. |
| C | App: More > Refer a friend (playful style, current menus kept), sample family data. |

Not deployed. Deploys together with the rest of the HON Family work on the owner's OK.
