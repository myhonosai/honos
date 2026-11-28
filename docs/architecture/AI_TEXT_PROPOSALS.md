# Shared AI text proposals (0550) and website AI edits (WB5)

## Why one table
Several features need "an AI writes a bounded text answer that a person reviews". Each used to need its own caller table,
and each new caller table had to be wired into every S4 spend function (org and school committed credits, open holds,
the HQ UNKNOWN queue and resolution, late provider expenses, HQ per-school usage). 0550 adds one shared caller table,
`hon.ai_text_proposals`, wired into S4 once. A new kind adds a row in `hon.ai_text_kinds`, its own entry points, a facts
reader and a validator. It does not touch S4 again.

## Kinds
| kind | agent / task class | budgets (in/out tokens, max cost) | caller | usage agent |
|---|---|---|---|---|
| WEBSITE_EDIT (0550) | marcus / DRAFT_MARKETING (live MARCUS_MARKETING route) | 16,000 / 4,000, 150,000 micro-USD | HUMAN_UI | WEBSITE_EDIT |
| MERCH_IDEAS (0596) | marcus / DRAFT_MARKETING | 6,000 / 3,000, 80,000 micro-USD | HUMAN_UI | MERCH_IDEAS |
| COMMERCE_REVIEW (0615) | marcus / DRAFT_MARKETING | 9,000 / 2,500, 80,000 micro-USD | HUMAN_UI | COMMERCE_REVIEW |
| RANK_CHART (0636) | kai / DRAFT_TEACHING (KAI_TEACHING route) | 16,000 / 5,000, 150,000 micro-USD | HUMAN_UI | RANK_CHART |
| DESIGN_DRAFT (0705) | marcus / DRAFT_MARKETING (MARCUS_MARKETING route) | 6,000 / 3,000, 40,000 micro-USD | HUMAN_UI | DESIGN_DRAFT |
| Customizer CM-3 (0382), Conversation AI CA2b (0383), goal planner | later migrations | | | |

Kind rows are immutable. The plan must match the kind's agent, task class and budgets.

## Lifecycle (core functions, no runtime grants)
`ai_text_begin` (advisory lock per kind and origin key; exact replay or 23505) -> `ai_text_planning_reference` ->
`plan_ai_invocation` (API) -> `ai_text_prepare` (organization budget lock FIRST, then the row; route freshness; the kind's
own block such as SUBJECT_STALE or GATE_CLOSED; `ai_spend_allowed`; the organization ceiling; SENDING with reserved credits) ->
provider call (API) -> `ai_text_record` (evidence only: one ledger row with `source_invocation_id`, AGENT_INFERENCE; then
RESULT_RECORDED, RESULT_REJECTED when the kind's validator found problems, or FAILED/RESULT_BUDGET_EXCEEDED) or `ai_text_fail`
-> `ai_text_close` (APPLIED or DISMISSED). A paid answer that does not validate keeps its usage and is RESULT_REJECTED, never
UNKNOWN. A SENDING row older than 90 seconds reads as UNKNOWN (provider calls time out at 60) and keeps its hold for the HQ
owner, where it appears with agent `TEXT_PROPOSAL`.

The S4 triggers `ai_spend_start_guard`, `ai_spend_reserve_guard(_insert)` and `zz_ai_hold_origin` run on the table, so an HQ
pause, ended access or the school's cost ceiling refuses the start itself (the API answers `SCHOOL_WEBSITE_AI_SPEND_STOPPED`).

## WEBSITE_EDIT
- Who: a direct human with `website.edit`, `marketing.assistant.use` and `ai.invocation.plan` at the session school, and an
  active Complete entitlement. Only the requester prepares, applies or dismisses; anyone with `website.edit` reads.
- Input: `{expectedRevision, request}` (request up to 1,000 characters of safe text). A new request must name the current
  draft revision.
- What Marcus sees: the owner request and an outline of the current draft (name, theme, pages, section ids and props,
  shortened to at most 10 KB). A website document holds no visitor, lead, student, family or billing data.
- What Marcus may answer: `{summary, edits}` with up to 25 edits from a closed list (setText, addSection, removeSection,
  moveSection, addPage, removePage, setPage, setTheme), at most 24 KB. The contracts validator refuses any image, form,
  booking page or campaign choice (the AI can neither set nor clear one) and any link that leaves the site.
- Apply: the API applies the edits to the current draft and, in ONE transaction, calls the 0361 draft save and closes the
  suggestion APPLIED. A suggestion that no longer fits is refused with its problems; nothing changes.
- Runtime role: EXECUTE on exactly seven entry points (`begin_`, `school_website_ai_edit_planning_reference`, `prepare_`,
  `fail_`, `record_`, `read_school_website_ai_edits`, `close_`); no table privilege; forced deny-all RLS on both tables.

## Spend inventory
AI-0 `ai-spend-entrypoints.json` gains `ai_text_proposals` as a spend table, `ai_text_record` as a ledger writer and
`ai_text_prepare/record/fail` as reservation writers. This was built on the owner-approved live text route; it goes on the
pre-launch final-review list.

## Operator note
The HQ routing policy and the MARCUS_MARKETING task profile must allow `unit_cost x 20,000 tokens` within their max cost,
or WEBSITE_EDIT plans are refused as NO_ELIGIBLE_ROUTE (nothing is sent).
