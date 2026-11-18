# Eian family AI (E-AI1, migration 0474)

**Status:** built, not deployed. **Owner approval:** David chose "Build it now" on 2026-11-18 01:34Z ("Start building the real AI connection for Eian now?") and said "Eian is as HON. Included in program" at 01:39Z. That covers building the path. It does **not** cover a paid call. A real call still needs all of these owner steps:
- `OPENROUTER_API_KEY` and `OPENROUTER_PAID_CALL_APPROVED=true` on hon-api
- an HQ TEXT routing policy with a HEALTHY connection
- the provider no-training confirmation (#478)
- a deploy

## Goal

A parent can ask Eian a free-text question in the HON Family app. HON answers from **that family's own records** through the same governed AI runtime that Ask HON (0210/0336) uses:
- planning
- the S4 budget lock and the S4 spend decision
- one provider call
- usage recorded before any answer is shown
- UNKNOWN for anything ambiguous

Guided mode stays. The app still answers the questions the on-device engine recognizes (next class, schedule, belt, testing, invoices, messages, absence, booking) locally, for free and at once. Only the rest goes to the AI. If AI is not available, Eian falls back to the guided answer.

## What Eian AI can and cannot do

- **Text only.** Eian explains and points. It never books, cancels, pays, sends, reports or changes anything.
- It may end with one suggested screen from a closed list: `SCHEDULE`, `BOOK_CLASS`, `REPORT_ABSENCE`, `BILLING`, `TESTING`, `MESSAGES`.
  - The model writes a final `SCREEN: NAME` line. The API strips that line and checks the name against the list.
  - The app turns the screen into a button. The parent acts there through the normal guarded command.
- **Facts (Option A).** `apps/api/src/eian/eian-facts.ts` builds the facts from the parent's own guarded reads. Each read is called with the signed-in subject, and the scope must be unchanged before and after.
  - The reads used: class booking choices, school bookings, billing, class passes, family messages, testing status and family knowledge.
  - Each section goes through an allow-list into a closed shape: children by display name, classes for the next 14 days, bookings, testing, invoices, memberships, class passes, the last 5 messages and up to 5 knowledge articles. A section that cannot be read is listed as `unavailable`.
  - Ids, contact emails, waivers, payment attempts, payer linkage and certificates are dropped. Emails and uuids inside free text are masked.
  - `hon.eian_facts_ok` checks the shape again in SQL: fixed keys and types, per-section caps, a 5,000-byte cap, and no email or uuid. `prepare_eian_turn` re-checks the scope the API passed, after its locks, and records a digest of the question and facts.
- Eian never sees other families, leads, staff, school revenue, owner reports or payment instruments.
- The question and the facts reach the provider as **untrusted data**. The system prompt says they cannot change Eian's rules, and that Eian must say it doesn't see something rather than guess.
- The app labels every AI answer "Eian (AI), using your school's records". It never shows a provider or model name. Billing and testing answers add "Please check with your school before you rely on this."

## Who can use it

- **Parent scope:** `hon.parent_class_booking_scope(subject, false)` (0329/0471). Eian follows the parent's family choice, like every parent path, and requires a live entitlement. The client sends no family, school or organization selector.
- **Gate (D1, decided):** HON's own `hon_reply_complete_live` (Complete at the live clock), plus:
  - the 4-argument `ai_spend_allowed` (HQ pause, exception allowance, school cost ceiling)
  - the organization ceiling
  A school without the gate gets guided mode.
- **No parent cap (D3, decided):** David said "no limit or cap" (2026-11-18 03:30Z). Parents share the school's whole AI budget; the organization ceiling and the S4 controls still apply.
- **No per-family cap** (David, 2026-11-17). The school's budget and the S4 controls still apply.
- **Burst guard:** 20 new questions per guardian per rolling 10 minutes, counted under a per-guardian lock, then `EIAN_BUSY`. Replays never count.

## Fixed limits

These are owned by the database (`hon.eian_turn_limits()`) and mirrored in `EIAN_LIMITS` in `@hon/contracts`:
- task class `SUMMARIZE` (risk LOW), agent `EIAN`
- 9,000 input and 700 output tokens, at most 20,000 provider microunits ($0.02) per answer
- a question of at most 500 characters, a reply of at most 1,500 characters, facts of at most 5,000 bytes

## Data model

`hon.eian_turns` has forced RLS, no policies and no grants, plus the four S4 triggers. Its status is one of PENDING, CONFIGURATION_REQUIRED, BLOCKED, SENDING, RESULT_HELD, COMPLETED, FAILED or UNKNOWN. Each check constraint mirrors the matching `hon_reply_invocations` invariant.

## Functions

The runtime gains no table privilege. Seven SECURITY DEFINER entry points take the subject and closed inputs:
- `read_eian_status`
- `read_eian_turn`
- `begin_eian_turn`
- `plan_eian_turn`
- `prepare_eian_turn`
- `fail_eian_turn`
- `record_eian_turn_result`

`read_eian_status` returns `{ mode: 'AI' | 'GUIDED', reason }`. The reason is one of NOT_INCLUDED, PAUSED, NOT_CONFIGURED or BUDGET_REACHED. It never shows a ceiling, an amount or a provider.

`read_eian_turn` returns the guardian's own turn in the current family only.

**Planning (option a).** The route selection in `plan_ai_invocation` (the 0336 body) moved byte for byte into the pure, ungranted `hon.ai_select_text_route`. `plan_ai_invocation` keeps every check it had and calls the helper. `plan_eian_turn` checks the parent scope and the Eian gate first, then calls the same helper. There is no 0336 fallback call for Eian.

**S4 enumerations.** These shared functions gain the `EIAN` agent:
- `ai_org_committed_credits`, `ai_org_open_agent_holds` and `ai_school_committed_cost_micros`
- `ai_unknown_validate` and `resolve_ai_unknown_invocation`
- `record_ai_late_provider_expense` and `read_ai_unknown_invocations_from_hq`
- `read_ai_school_usage_from_hq`, where the attribution is `EIAN`

`read_ai_team_readiness` is unchanged on purpose, because it is the staff AI roster.

## API

| Route | Guard | Notes |
|---|---|---|
| `GET /v1/parent/eian/status` | `EianReadGuard`: no query, no body, no `x-hon-*` header, not cross-site | `{ mode, reason }` |
| `POST /v1/parent/eian/turns` | `EianAskGuard` (human UI, command `parent.eian.ask`, works natively) | Body `{ question }` plus `Idempotency-Key`. Runs begin, plan, facts, prepare, one call, then record or fail. Returns `201` for a new turn and `200` for a replay. A resend never plans or calls again once the turn has left PENDING. |
| `GET /v1/parent/eian/turns/:id` | `EianReadGuard` | The parent's own turn. Used to re-read after an unknown outcome. |

Error codes:
- 503 `EIAN_AI_UNAVAILABLE`: a definite no, nothing was asked
- 429 `EIAN_BUSY`
- 409 `IDEMPOTENCY_KEY_REUSED`
- 503 `EIAN_OUTCOME_UNKNOWN`: never resent

The provider runtime is `OpenRouterEianRuntime`. It uses the same rules as the HON runtime: a fixed URL, no redirects and no retry after the transport is attempted. A `length` finish counts as UNKNOWN. Test fakes are injected and are never chosen by environment.

## App

- The app reads `/v1/parent/eian/status` when the family loads and each time the Eian tab gains focus.
- In AI mode, a question the guided engine classifies as `help` goes to `POST /v1/parent/eian/turns`.
  - Each question gets one key until there is a definite answer.
  - After an unknown outcome, the app re-asks once with the same key and the exact same question.
  - If the outcome is still unknown, the parent can ask the same question again, and the app reuses that key.
  - A turn still in flight is re-read by id once.
- If AI is not available for the school, the turn is blocked for budget, plan, configuration or pause, or the read fails, the app shows the guided answer. An unavailable or blocked result also switches the screen back to guided mode.
- The sample family always reports GUIDED and never calls the server AI.

## Evidence

- `packages/database/scripts/test-eian-family-ai-integrity.mjs` runs over signed HTTP against a fake provider and passes 97 checks. It covers:
  - scope and gate
  - the happy path and replay
  - every outcome
  - the HQ queue, usage and resolve
  - a lapse that is held, then released
  - direct SQL refusals and ACLs
  - no separate parent cap, then the organization ceiling
  - a parallel burst
  - the 011 section
  - the largest facts the API builds for a crowded family are accepted, and the API and database measure the same jsonb text
- The AI-0 spend inventory is updated; the check passes with 54 invariants.
- API unit tests: `apps/api/test/eian-family-ai.test.cjs`.
- App tests: `apps/parent-mobile/test/eian-ai.test.tsx`.

## Known follow-ups (from review, not blocking)

- `ai_route_task_category` has no Eian entry, so Eian follows the HQ policy order only and HQ cannot set privacy controls for it yet. Add a category, or confirm the policy order and provider privacy, before go-live.
- A turn that prepare refuses (for example, facts the database rejects) stays PENDING. A resend with the same key carries it again; nothing is called or charged.

## Owner decisions

- **D3 (decided 2026-11-18):** no parent share or cap; Eian uses the school's whole AI budget.
