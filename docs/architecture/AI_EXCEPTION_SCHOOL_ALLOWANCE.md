# AI on free-access schools under a monthly limit (0353)

**Owner decision (David, 2026-11-14):** "Go ... a", option (a): allow AI on a school that has a free HQ access
exception, but only when the HQ owner sets a monthly dollar limit for that school (example $25 a month). This narrows
AI-D1 (2026-10-31, "HQ access exceptions grant no AI by default"): an exception still grants **no AI by itself**.

## Behavior

| Situation | Agent AI (HON and the AI team) | Image / video |
|---|---|---|
| Live exception, no limit set (default) | Refused, `AI_EXCEPTION_NO_AI` (unchanged) | Refused |
| Live, started exception with a limit for its own school | Allowed until this month's agent AI cost reaches the limit, then `AI_PAUSED_BY_HQ` | Refused (`AI_EXCEPTION_NO_AI`) |
| Limit cleared, exception revoked/expired/superseded, or a new exception | Refused again at once; a new exception never inherits an old limit | Refused |

- The limit is HON's **internal provider cost** (micro-USD) for agent inference, counted exactly as the R2 per-school
  ceiling (0288) counts it: verified ledger cost in the UTC-month window plus every counting hold at its plan maximum.
  It is never a customer balance, credits or a charge, and it touches no wallet or payment.
- The school's effective ceiling is the **lower** of its 0288 ceiling (if any) and the exception limit. A 0288 school
  pause and the HQ organization/platform pause (0195) still come first.
- The limit is bound to the exact exception id and to the exception's own school. Other schools of the organization,
  and decisions that name no school, stay refused.
- Range $1 to $1,000 a month. The HQ screen suggests $25 (`hon.ai_exception_default_allowance_micros()`); nothing is set
  automatically.

## Interfaces

- `POST /v1/hq/ai/exception-allowances` (SaaS human command `ai-exception-allowance`, `Idempotency-Key`):
  `{ schoolId, ceilingMicros: number | null, reason, expectedVersion }`. `null` clears. HQ owner only (database
  `require_saas_hq_actor(subject, true)`, re-checked after every lock wait). Setting needs a granted, unexpired
  exception for this school that still owns the entitlement (`AI_EXCEPTION_NOT_LIVE`, 422); clearing an unset limit is
  `AI_EXCEPTION_ALLOWANCE_NOT_SET` (422). Versioned (`SAAS_VERSION_CONFLICT`), idempotent (same key + body replays; a
  different body is `IDEMPOTENCY_KEY_REUSED`).
- `GET /v1/hq/ai/exception-allowances` (HQ readers): every granted, unexpired exception (at most 500) with its school's
  limit, whether AI is allowed now, this month's cost and level, and the $25 suggestion.
- HQ School Access screen: an "AI on free-access schools" panel under the organization list. Owner-only Turn on AI with a
  limit / Change limit / Turn off AI, each with a reason; unknown outcomes keep the exact request for Try again.

## Database

- `hon.ai_exception_school_allowances` (one row per school, versioned, immutable except through the command) and
  `hon.ai_exception_school_allowance_commands` (append-only audit and idempotency log: actor, time, school, exception,
  limit, reason). Both forced RLS, no runtime table privilege.
- `hon.ai_exception_allowance_micros(org, school)`: the live limit or NULL.
- `hon.ai_org_spend_allowed_for_school(org, school, at, class)`: the 0288 organization decision, except
  `AI_EXCEPTION_NO_AI` becomes allowed for `AGENT_INFERENCE` when that school has a live limit.
- Replaced bodies (from 0288): `hon.ai_school_spend_decision` (ceiling = least of 0288 ceiling/default and the limit),
  `hon.ai_spend_allowed(org, school, at, class)` and `hon.ai_spend_reserve_guard()` (the first decision names the row's
  own school). The 3-argument `hon.ai_spend_allowed` delegates through these unchanged, so every agent begin, prepare,
  readiness and reserve path applies the rule. 0341 saas schedule/access guard functions are not touched.
- Only `hon.command_ai_exception_school_allowance` and `hon.read_ai_exception_school_allowances_from_hq` reach the
  runtime (`infra/postgres/010_supabase_hon_runtime.sql`).

## Proof

AI-0 INV-43 (`packages/database/scripts/test-ai-spend-authority-baseline.mjs`): no limit refuses; HQ-owner-only set; HON
answers with one provider call; image/video, other schools and no-school decisions stay refused; at the limit the next
request is refused with no provider call and raising it restores AI; a lower 0288 ceiling wins; clearing refuses again
(including the reserve guard); revoke makes the limit inert and a new exception starts with none; shape, versions,
idempotency, immutable tables and runtime ACL.

## Known limits / follow-ups

- The HQ AI usage page (0288 read) and the 0343 cost alerts still show the 0288 ceiling only, so an exception school
  appears there as "no ceiling"; the exception panel on the School Access screen shows the live limit and level.
- Like 0288, the last admitted request can overshoot the limit by at most one call's plan maximum.
- Nothing here deploys, turns on paid AI calls or changes production; the first use (the owner's own school) needs the
  migration applied to that environment and real provider calls approved separately.
