# HON OS 14-day free trial (D11-B first slice, migration 0246)

**Status:** source only. Not deployed, not applied to any persistent database. The trial program is **CLOSED** by default
and can only be opened in **TEST_MODE** by the migration owner of a disposable or private test database. No LIVE value.

## Spec

A `REGISTERED` school (0241) starts one free trial from an HQ-published public trial campaign (0187), then uses HON OS
until the trial ends. Owner decisions: 14-day trial, no automatic charge. Trial AI (David, 2026-11-11): "yes with custom ai credit",
"let hq able to set trial setting": the AI credit is the promotional credit budget HQ sets on each trial campaign.

`POST /v1/account/trial` (same-origin human command `hon-os-free-trial`, `Idempotency-Key`), body exactly
`{ schoolId, campaignId, confirmation: "START_HON_OS_FREE_TRIAL" }`. `GET /v1/account/trial` returns the program status,
the caller's school, the public trial they may start (or `null`) and their trial (or `null`).

In one transaction under the 0191 account authority envelope (NOWAIT, so a busy system answers `TRIAL_BUSY`):

1. Trial program must be `TEST_MODE` (else `TRIAL_CLOSED`), checked before and after the writes.
2. Caller must be the registering owner of that school, through their own live owner grant (else 403).
3. Campaign must be the latest `PUBLISHED` publication, under the current `APPROVED` and valid trial policy decision,
   `PUBLIC`, `NEW_ORGANIZATIONS_ONLY`, inside its enrollment window (else `TRIAL_CAMPAIGN_UNAVAILABLE`); under its capacity (else `TRIAL_CAMPAIGN_FULL`).
4. One trial per organization ever (`TRIAL_ALREADY_USED`). The school must still have no access at all: entitlement
   `SUSPENDED`, no access state, subscription, checkout or exception (else `TRIAL_NOT_ELIGIBLE`).
5. Effect: entitlement becomes the campaign profile, `ACTIVE`, `effective_until = start + duration`. Access ends at that
   instant by the clock, like every entitlement window. An immutable enrollment row records exactly what authorized it,
   including a snapshot of the campaign's promotional credit budget (`ai_budget`; JSON null = no trial AI).
6. Receipt: `TRIAL_ACTIVE` / `TRIAL_ENDED` / `SUPERSEDED`, with `automaticCharge`, `paymentMethodRequired`,
   `creativeCreditsIncluded` all `false`; `aiIncluded` true only with a budget, then `aiCredits` = `{credits, dailyCap,
   perRequestCap, expiresAt, used}`. The offer in `GET` carries `aiIncluded` and `aiCredits` = `{credits, dailyCap,
   perRequestCap, expiryDays}`.

No provider, customer, subscription, payment method, invoice, checkout or credit allowance is created. A trial school
cannot open a checkout (`TRIAL_CONVERSION_UNAVAILABLE`) until the reviewed conversion slice exists.

### AI: the HQ-set trial credit

HQ sets the trial AI on the Free Trials screen (0187 campaign `promotionalBudget`, bounded by the approved policy's
`promotionalLimits`): credits per school, daily cap, per-request cap, credit expiry (days, at most the trial length) and a
campaign provider-cost cap.

- `hon.ai_spend_allowed` maps a trial-owned entitlement to `TRIAL_ACTIVE`/`TRIAL_ENDED` and a registered school with no
  trial to `REGISTERED` (`AI_ACCESS_NOT_PAID`).
- `hon.ai_trial_funding_available` (0195 hook, replaced here) is true only for `AGENT_INFERENCE`, while the trial owns
  the entitlement, has a budget and `now < starts_at + creditExpiryDays`. `CREATIVE_MEDIA` is never trial-funded
  (Creative Studio stays wallet-only), so a trial school is refused as `AI_TRIAL_FUNDING_NOT_APPROVED` for media.
- `hon.ai_org_ceiling` (0194, replaced here) is what every agent prepare already compares `committed + estimate` against
  under the `ai.budget:<org>` lock. For a school whose entitlement a trial owns it is 0 unless funded now; when funded it
  is the least of 12000, credits remaining since the trial started, today's (UTC) daily cap, committed + per-request cap,
  and 0 once the campaign's agent provider cost reached its cap (1 USD minor unit = 10000 microunits). Every other
  organization keeps 12000. The HQ usage and readiness screens show this ceiling.
- Promotional and internal: nothing is charged, sold, deducted from a wallet or carried over after the trial.

Note for HQ: agent estimates today are up to 10 credits per request (HON reply), so a per-request cap below 10 refuses
those requests. The campaign cost cap is checked per school under its own budget lock; schools deciding at the same
instant can each still finish one request (at most the per-request cap) past it.

## Evidence

`test-hon-os-trial-runtime-integrity.mjs` (11 groups, real signed sessions → Nest → runtime SQL) runs last on the
champions-club fixture because it records a newer synthetic trial approval.

## Open items

- Pre-launch risk: trial AI spends real provider money once providers are live; review the default campaign budget
  and cost cap before any LIVE program.
- Conversion to paid (trial → checkout → PAYMENT_ACTIVE) waits for billing pieces (#205, 0235) and the 0230 binding path.
- Legal trial terms are not written; the campaign `termsReference` is HQ metadata only.
- From #220 review: 0241 line 149 comment says "current or ended" access blocks sign-up, but only current access does
  (P3-1); no audit/outbox event for sign-up or trial start yet (P3-2); abuse controls before any LIVE program (P3-3).
