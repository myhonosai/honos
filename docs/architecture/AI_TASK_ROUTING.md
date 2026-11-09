# AI task routing by task class (R1, migration 0242)

Status: built (0242). Spec + plan for build step 1 of `AI_MODEL_AND_CONNECTION_PLAN.md` §6. Test providers only. No real provider call, no new
provider, no change to S4 spend controls, budgets or the per-call $0.08 ceiling.

## Problem

`hon.plan_ai_invocation` (0212) picks the **first** model of the school's TEXT routing policy (by ordinal) whose estimated cost fits.
HQ task profiles (0113) already record a default, fallbacks and an advanced model per agent and task category, but nothing reads
them. So HON Standard and HON Detailed, Claire, Marcus, Chad and Kai all use the same model.

## Behaviour

1. **Route category is code-owned.** `hon.ai_route_task_category(agent_key, task_class)` maps a planned call to a task profile
   category. Callers and HQ cannot nominate a category for a call.

   | Agent | Task class | Category |
   |---|---|---|
   | hon | SUMMARIZE (HON Standard) | `HON_STANDARD` (new) |
   | hon | ANALYZE (HON Detailed) | `HON_DETAILED` (new) |
   | claire | ANALYZE (Business Performance) | `BUSINESS_PERFORMANCE` (new) |
   | marcus | DRAFT_MARKETING | `MARCUS_MARKETING` |
   | chad | DRAFT_FOLLOW_UP | `CHAD_SALES` |
   | kai | DRAFT_TEACHING | `KAI_TEACHING` (new; the stored legacy `CLAIRE_TEACHING` value is left as it is and no longer routes) |
   | anything else | | none: legacy policy order |

2. **Profile lookup.** After the single active TEXT policy is found, the planner looks for task profiles on that policy with the
   same agent key and category that are `active`, `cost_unit = 'TOKEN'` and effective now.
   - None: unchanged legacy behaviour (policy candidates by ordinal). Existing schools keep working.
   - More than one: `NO_ELIGIBLE_ROUTE` (ambiguity fails closed, as for policies).
   - Exactly one: candidates are the profile's **DEFAULT, then FALLBACKs by ordinal**. ADVANCED is never chosen automatically
     (it needs a later, explicit user or HQ choice).
3. **Eligibility of a profile candidate** = every legacy check (catalog active and effective, TOKEN, TEXT capability and modality,
   provider connection HEALTHY, estimated cost within the policy ceiling and the request ceiling) **plus** the profile's own
   limits: estimated cost within `max_cost_micros`, provider in `allowed_provider_ids`, catalog capabilities/modalities cover
   the profile's required lists, and the catalog's `privacy_controls` include every control the profile requires.
4. **No silent escape.** When a profile exists but none of its candidates is eligible the result is `NO_ELIGIBLE_ROUTE`; the
   planner never falls back to a policy model HQ did not pick for that task. (Reduced-AI mode is a later slice.)
5. **Recorded on the plan.** `ai_invocation_plans` gains `task_profile_id`, `task_profile_version` and `route_selection`
   (`POLICY_ORDER`, `PROFILE_DEFAULT`, `PROFILE_FALLBACK`), all immutable like the rest of the plan. Existing rows read as
   `POLICY_ORDER`.
6. **HQ can configure it.** The HQ control plane write and the shared validators accept agent keys `hon` and `kai` and the
   four new categories. Nothing else about the HQ write changes (HQ owner only, versions, audit).

Claire's ANALYZE route is live: 0229 binds `claire` to `reporting.view` in `hon.ai_agent_capability_permission`, and AI-0
INV-32 step 3 plans a real Claire turn through `BUSINESS_PERFORMANCE`.

## Not changed

Spend authority (access decision, org budget lock, evidence, UNKNOWN handling), the per-mode token budgets and $0.08 ceiling,
prepare/record functions, provider runtimes, plan summary shape, customer-visible text. No paid call.

## Plan (TDD)

1. AI-0 INV-32 (fails on main): legacy order without a profile; HON Standard and Detailed use their own profile defaults;
   Claire uses `BUSINESS_PERFORMANCE`; default ineligible (inactive, unhealthy cost, privacy, provider not allowed) uses the
   first eligible fallback and records `PROFILE_FALLBACK`; no eligible candidate and two active profiles give
   `NO_ELIGIBLE_ROUTE` and no provider call; inactive or expired profile falls back to legacy order; advanced is never used.
2. Migration 0242: category function, constraint extensions, plan columns, `hq_ai_validate_write` lists, `plan_ai_invocation`.
3. Contracts/domain: `AI_TASK_PROFILE_AGENT_KEYS`, four new categories; unit tests for the validator.
4. Pin checksums, staging manifest and ceiling; run AI-0, `pnpm test`, `pnpm check`, `pnpm build`.
