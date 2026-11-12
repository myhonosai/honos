# Per-school internal AI cost ceiling and single-school pause (R2, migration 0288)

Status: built (0288). Build step 2 of `AI_MODEL_AND_CONNECTION_PLAN.md` §6. Test providers only. No real provider call, no new
provider, no change to the org-level S4 controls (access decision, budget lock, HQ pause, UNKNOWN handling) or the per-call
$0.08 ceiling.

This is HON's own provider cost for the included AI team. It is never shown to a school as credits, a balance or a charge.

## Problem

S4 limits spend per organization (credits, budget lock, HQ pause). Nothing limits what one school costs HON in a month, and HQ
cannot pause one school's AI without pausing the whole organization.

## Behaviour

1. **Ceiling.** A school may have a monthly internal ceiling. Owner decision 2026-11-12: conversations with the AI team
   have no cap for a paying school, so with no HQ record a paying school has **no ceiling** (HQ reads `NO_CEILING`). Its
   creative and heavier work (images, video, websites) is limited by its 12,000 monthly creative credits (0202), which it
   can top up or wait for next month. While the organization's free trial owns its access (`hon.hon_os_trial_live`,
   0246) the default is $15 (15,000,000 micro-USD, `hon.ai_school_trial_default_ceiling_micros()`); when the trial ends
   no default applies. `hon.ai_school_default_ceiling_for(org, at)` picks it. HQ may still set any ceiling from 0 to
   $1,000 for one school, or pause it, and the HQ read shows `trial` for each school.
2. **Committed cost** (`hon.ai_school_committed_cost_micros`) for the UTC month (`hon.ai_spend_window`) = recorded
   `AGENT_INFERENCE` provider cost in the ledger for the school, plus every counting hold in the four agent invocation tables
   valued at its plan's `max_provider_cost_microunits` ($1 when a hold has no plan). Holds count at their worst case, so
   parallel calls cannot overshoot.
3. **Levels** (`hon.ai_school_cost_level`): `NORMAL`, `WARNING_75` (≥ 75%), `WARNING_90` (≥ 90%), `CEILING_REACHED` (≥ 100%).
   The contracts copy (`aiSchoolCostLevel`) uses the same integer thresholds, and the API refuses a read whose level disagrees.
4. **Decision.** `hon.ai_spend_allowed` = the org decision (the current trial-aware 0246 body, now `hon.ai_org_spend_allowed`) and then the school
   decision for `hon.current_school_id()`. A paused school is refused for every spend class except `HQ_INTERNAL`. At or over
   the ceiling, `AGENT_INFERENCE` is refused. Both refusals reuse `AI_PAUSED_BY_HQ`, so the closed reason enums, HON's reply
   path and the team readiness screen stay valid. Other schools in the same organization are not affected.
5. **The row's own school decides.** SaaS school paths forbid `app.hon_school_id`, so enforcement never relies on the
   session alone. `hon.ai_spend_allowed(org, school, at, class)` takes the school explicitly, and the 0195 three-argument
   form uses `hon.current_school_id()` when the session names one. The guards use the row's `school_id`:
   - agent begin guard (`ai_spend_start_guard`, every agent invocation table);
   - agent reserve guard, after the org decision, budget lock and credit check, so a reservation cannot pass the ceiling
     between planning and reserving;
   - B3 credit reservations (`ai_spend_b3_guard`);
   - creative wallet reservations (new `ai_school_creative_guard` on `saas_creative_reservations`, which every creative
     and studio path inserts), refused as `SAAS_CREATIVE_AI_PAUSED_BY_HQ` like the wallet's own S4 check.
   A school pause takes the organization's creative pause gate exclusively, so it waits for in-flight creative
   reservations, exactly like an organization pause.
6. **HQ command** `hon.command_ai_school_cost_limit(subject, {schoolId, ceilingMicros, paused, reason, expectedVersion}, key)`:
   human HQ owner only (`require_saas_hq_actor(..., true)`); reason 10 to 500 characters; optimistic version
   (`SAAS_VERSION_CONFLICT`); unknown school `AI_SCHOOL_NOT_FOUND`; idempotent replay, and a reused key with a different
   input is `AI_SCHOOL_COST_LIMIT_KEY_REUSED`. Every command is kept in an immutable log; the limit row keeps a version and
   cannot be deleted.
7. **HQ read** `hon.read_ai_school_cost_limits_from_hq(subject)`: HQ billing readers; up to 500 schools, highest use first,
   with ceiling, whether it is the default, paused, reason, version, recorded and committed cost, used basis points, level and
   window.
8. **API.** `GET /v1/hq/ai/school-cost-limits` (SaaS read guard) and `POST /v1/hq/ai/school-cost-limits` (SaaS human command
   guard, command `ai-school-cost-limit`, `Idempotency-Key`). The browser cannot name the actor or the organization.

## Deferred

- The plan's "short answers continue at 100%" carve-out needs a daily cap and reduced-AI mode; it lands with 0245.
- Alerts are levels on the HQ read for now. A notification at 75% and 90% and the HQ screen are follow-up slices.

## Known limits

- The ceiling check runs before a new hold is added, so one call can take a school past its ceiling by at most that
  call's plan maximum (the per-call ceiling, $0.08 today). The next call is refused.
- The HQ read returns the 500 highest-use schools; lower-use schools beyond that are left out of the list.
- A ceiling refusal shows the existing "paused by HQ" reason to the school. Distinct wording is an owner copy decision.

## Deployment note

Once deployed, the $15 default applies to every school on a live trial without an HQ record. A trial school already over $15 in the current month
stops getting new `AGENT_INFERENCE` calls until HQ raises its ceiling or the month rolls over.

## Plan (TDD)

1. AI-0 INV-33 (fails on main): levels; ceiling via HQ commands; Marcus refused at begin with no provider call; HON turn
   refused; other org unaffected; readiness shows `AI_PAUSED_BY_HQ`; hold counts at plan max; reserve guard refuses at 0;
   pause covers `CREATIVE_MEDIA` but not `HQ_INTERNAL`; command authority, version, input, unknown school, replay, key reuse,
   immutable log; runtime ACL.
2. Migration 0288.
3. Contracts (`ai-school-cost-limit.ts`), runtime operations, API controller and HTTP test.
4. Pin checksums, staging manifest and ceiling, runtime grants; run AI-0, `pnpm test`, `pnpm check`, `pnpm build`.
