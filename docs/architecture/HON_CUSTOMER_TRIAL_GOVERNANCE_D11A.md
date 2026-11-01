# D11-A — customer trial governance foundation

Baseline: `9c1e0ca6021aff86749a9f56ca212356e1d1b1c0` (includes merged D10, HQ restoration and Classic reference). Additive migration **0187**; 0179/0180 remain reserved. This is governance metadata, not a trial launch. No approval or campaign is seeded. The only seeded row is a private program pinned INACTIVE with signup, enrollment and promotional issuance false. There is no activation command.

## Boundaries

Customer trials have a separate policy lineage from D9/D10 exception-only decisions. No D9/D10 function, grant input or entitlement behavior is replaced. Trial approval cannot authorize an exception, and exception approval cannot authorize campaign publication. Legacy Core/Complete new sales remain closed; CORE/COMPLETE here are internal capability-profile identifiers for the same HON OS product. No new public pricing tier or sale is created.

No signup, email verification, invitation/token generation or redemption, school provisioning, trial enrollment, entitlement grant, extension, conversion, AI allowance/ledger, provider execution or payment function is added. No customer agreement/consent or payment evidence is implied by a policy or publication receipt. There are no school/family/public routes. Paid access, normal AI credits and payments retain their existing gates.

## Data and authority

Five private forced-RLS tables:

- `saas_trial_program`: immutable INACTIVE singleton; three false activation flags, no runtime write API.
- `saas_trial_policy_versions`: immutable PROPOSED definitions. Every duration/profile/eligibility/channel, capacity, window and optional promotional bound must be explicitly supplied. Proposing a replacement does not withdraw an existing approval.
- `saas_trial_policy_decisions`: append-only APPROVED/WITHDRAWN/REVOKED decisions with expected global revision, exact proposal ID, finite validity, justification and an additional trial-only approval confirmation. Approval targets the latest proposal. Current approval is determined by the latest decision, not the proposal row's immutable PROPOSED label.
- `saas_trial_campaign_versions`: immutable definitions, monotonically versioned within a server-owned campaign identity. Editing means a new version; prior published terms are never overwritten.
- `saas_trial_publications`: immutable PUBLISHED/WITHDRAWN events, expected revision per campaign, exact campaign version, approved trial decision and preview digest. The current event is the highest revision; historical publication is not current activation.

All writes, including draft creation and withdrawal, require a live, sole direct-human HON_HQ_OWNER with no family context. No delegated publisher is introduced. Independently authorized HON_HQ_OPERATOR + `hq.billing.manage` may read/preview; support, school/family, ambiguous, expired, AI and action/delegated contexts are refused by the existing database authority. A role label or human-command header is not authority. More granular trial permissions are an owner decision before operational rollout.

All records except the closed program bind to a canonical SaaS request. BEFORE INSERT backstops check live authority, sequence, command claims and publication validity. Deferred private SECURITY DEFINER triggers verify live authority, completed exact receipt, audit and inert outbox at COMMIT. Policies, versions, decisions and publications cannot be updated/deleted/truncated, including by ordinary owner DML around the command. Runtime/client roles have no direct table/column privileges and no private-helper execute privilege. Existing audit/outbox allowlists are extended without removing historical values.

## Publication and concurrency

A read-only preview re-evaluates:

- Latest version, no prior publication of that version, exact current APPROVED trial decision, validity and enrollment window.
- Allowed duration/profile/eligibility/channel and exact terms reference.
- Per-campaign capacity/window and promotional metadata maxima.
- Whole-database aggregate planned enrollment capacity, count of current publications and promotional-cost ceilings under that exact decision. It never sums a truncated UI/history list.

The digest binds immutable campaign and policy facts, exact policy decision, prior publication revision and other campaigns' planned exposure. Publication requires an explicit `PUBLISH_TRIAL_CAMPAIGN_DEFINITION_ONLY` confirmation. It rechecks/recomputes after locking. Policy/window expiry before COMMIT rolls everything back.

IAM SHARE locks -> idempotency claim -> one low-volume D11 governance mutex. No tenant, subscription, offer inventory or checkout locks are taken; no network call occurs in a transaction. Authority is checked after waits and at commit. Writes refuse non-READ-COMMITTED isolation so a retained snapshot cannot hide a changed approval. Future enrollment/conversion must have a separately reviewed lock graph respecting existing inventory -> checkout -> organization ordering; this metadata mutex is not an enrollment/spend authority.

Expected revisions reject competing decisions/publications; exact retries return historical receipts without new events. Changed requests under a claimed key fail. Timeouts keep the canonical `SAAS_OUTCOME_UNKNOWN` guidance: explicit identical-request retry, never automatic resubmission.

A new approval does not adopt/re-publish campaigns bound to the previous decision. A fresh campaign version and explicit publication are required. Current published metadata continues to consume its approved planned-exposure limits until replaced/withdrawn, even when its enrollment window has ended. These are prospective publication bounds, not reservations, issued credits or accounting liabilities. Future funding must account for real outstanding obligations independently of policy replacement.

`ready` means ready to publish the definition. Every preview/publication receipt explicitly reports `activationAvailable:false`; previews also report `promotionalCreditsAvailable:false`. PUBLISHED is never ACTIVE. HQ withdrawal remains possible without a valid current policy and preserves history.

## Closed HQ API

All routes start `/v1/hq/saas/trials`, require verified identity, retain existing read/command guards and use fixed database operations. Mutations also require the exact human-command marker, same origin and a UUID Idempotency-Key.

| Method / suffix | Purpose | Marker |
| --- | --- | --- |
| GET `governance` | Policy versions/decisions, campaign versions/publications and actual program gates | — |
| GET `campaigns/:campaignId` | Immutable version/publication history for one campaign | — |
| GET `campaign-versions/:versionId/publication-preview` | No-write readiness/digest | — |
| POST `policy-versions` | Propose a complete immutable policy definition | `saas-trial-policy-propose` |
| POST `policy-decisions` | Explicit owner approval/withdrawal/revocation | `saas-trial-policy-decide` |
| POST `campaign-versions` | Create a campaign or append a version | `saas-trial-campaign-draft` |
| POST `campaigns/:campaignId/publish` | Digest-bound metadata publication | `saas-trial-campaign-publish` |
| POST `campaigns/:campaignId/withdraw` | Withdraw current publication metadata | `saas-trial-campaign-withdraw` |

Reads are explicitly bounded to 100 records per collection, with `hasMore`; they do not claim complete histories or customer statistics. Promotional metadata is USD minor-unit maximum-cost planning and separately named credit limits, not money received, funding approval, credits issued or provider cost evidence. There are no public links/URLs/tokens in responses.

## Owner-decision matrix (not selected or approved by engineering)

| Decision | Foundation representation | Still requires owner decision before operational use |
| --- | --- | --- |
| Trial duration | Explicit allowed subset of proposed 7/14/30/60/90-day values | Which choices, clock start, elapsed UTC vs school-calendar days, scheduling |
| Capabilities/product | CORE/COMPLETE internal profiles; no Essential or public product sales | Which campaign receives which profile; independently gated external capabilities |
| Eligibility | Closed `NEW_ORGANIZATIONS_ONLY` / `HQ_REVIEW_REQUIRED` metadata | Definitions, evidence, repeat trials, existing/pilot/paid customers, multi-school owners, review resolution |
| Channels | PUBLIC/PRIVATE_INVITATION/PROMOTIONAL metadata only | Which channels; recipient binding, single-use/expiry, anti-abuse and verification controls |
| Capacity/window | Explicit per-campaign and total planned capacity, published-campaign count, enrollment window | Actual approved maxima, reservations/waitlist semantics, handling expired campaigns |
| Approval validity | Explicit dates, reason and exact trial-only confirmation | Approved legal/business policy, validity and withdrawal effect on future enrollments/existing trials |
| Delegation | Owner-only writes; existing HQ billing operators read | Narrow trial view/edit/publish roles and delegated bounds, if any |
| Promotional AI | Optional explicit per-enrollment, daily/request, expiry, per-campaign and aggregate USD cost ceilings | Actual amounts, operations/models, verified costs, funding, hold/settlement/unknown outcomes, rollover and concurrency caps |
| Terms/consent | Opaque policy terms reference bound into campaign publication | Actual accepted terms, privacy notice, legal business-owner eligibility and optional marketing consent; no fabricated signatures |
| Extensions/cancellation | Not implemented | Cumulative limits, reasons, repeat approvals, existing trial rights and in-flight work |
| Paid conversion | Not implemented; existing checkout untouched | Seamless vs end-first, exact service dates, founder/refund rules, payment/activation distinction |
| Referral/contest rights | Existing D9/D10/Champions behavior untouched | Trial eligibility must be explicit before trial access is enabled |
| Expiry/privacy | No school or parent data is created here | Read/export/retention, parent access and delivery cancellation policies |
| Release | Program pinned INACTIVE; no activation API | Independently reviewed signup/entitlement/promo contracts, persistent-database rehearsal and separate activation authorization |

Integer/string ceilings (capacity 1,000,000 per campaign; total 1,000,000,000; window 3660 days; USD minor-unit caps and bounded credit counters) are validation/storage limits, not approved commercial values. No operative default policy is inferred from them. Test fixture defaults are conspicuously SYNTHETIC, never migration seeds.

## Verification and remaining limits

API tests cover closed contracts, explicit confirmations, exact markers/keys/origin, expired-session/denied responses, no public/activation paths and false activation flags. The disposable proof runs real API services/restricted-role functions, immutable evidence and full-domain no-effect snapshots, expected revisions, competing decisions/publications, aggregate bounds, both policy/publication lock orders, live authority loss and commit-time expiry. It also proves D9/D10 policy approvals cannot authorize the other scope.

The commercial rehearsal extends to 0187 and asserts empty trial governance plus closed program before and after every simulation, alongside existing network/AI-write tripwires. Full existing PostgreSQL regressions remain required. Exact execution results belong to the draft PR; source checks are not a claim that tests passed.

No D11-B enrollment, verification provider, consent capture, promotional funding/runtime or paid conversion is implemented. No signed-session D11 HTTP-to-database browser proof or populated persistent-database upgrade certification is claimed by service-level fixtures. No migrations are applied to persistent environments and no real provider or school is used.
