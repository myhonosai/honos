# HON analysis specialists (migration 0260)

Status: source only, not deployed. Test/fake providers only; the real runtime stays behind
`OPENROUTER_PAID_CALL_APPROVED`.

## What it is

Claire's read-only Business Performance turn (0229) generalized into "analysis specialists". Each specialist is
one row of code-owned mapping, not another copy of the HON turn functions:

| Agent | Area | Capability (0212 binding) | Facts |
|---|---|---|---|
| Claire | Business performance | `reporting.view` | Command Center metrics (unchanged from 0229) |
| Alex | General management | `reporting.view` | Command Center metrics, plus `operations` and `creativeCommerce` sections, each `NOT_AUTHORIZED` unless the human also holds that section's permission |
| Jordan | Operations | `schedule.session.manage` | Next 7 days of class sessions (scheduled, cancelled, capacity, booked seats, waitlist, full, no instructor), last 30 days attendance and rate, planned absences awaiting review |
| Lena | Creative & commerce | `marketing.campaign.read` | Campaigns by status (and active ones ending in 14 days), membership plans available/unavailable with single-currency price range, Creative Studio requests in the last 30 days by phase |

Facts are aggregate counts only: no names, contacts, family, student or payment rows.

## Turn shape

A delegation `{ agentKey: 'claire' | 'alex' | 'jordan' | 'lena' }` asks that specialist. It is one DETAILED
single-step reply invocation, task class ANALYZE, no history, no suggestions, never continued. All S4 guards are
unchanged (budget lock first, HQ pause, access decision, reserve/settle, UNKNOWN resolution).

Authority is checked in `begin_hon_turn`, again in `prepare_hon_reply` before and after the fact reads, and again
by the API just before the provider call. The permissions the facts used are stored on the invocation
(`hon_reply_invocations.source_permissions`); `hon_reply_source_allowed` conceals the answer when any of them, or
AI access, lapses later.

## Plug-in points

- `hon.hon_analysis_specialist(agent)`: true for analysis specialists.
- `hon.ai_agent_capability_permission(agent)`: the one capability for the agent.
- `hon.read_specialist_school_facts(subject, agent, org, school)`: returns `{facts, sourcePermissions}` and
  re-checks authority itself. A new specialist (for example Maya, 0262) adds a branch here instead of redefining
  `begin_hon_turn` / `prepare_hon_reply`.

The internal fact builders `hon.hon_school_operations_facts` and `hon.hon_school_creative_commerce_facts` are
revoked from PUBLIC and the runtime roles.

## Overlap

PR #201 (0234) also redefines `hon.begin_hon_turn`. Whichever lands second rebases and keeps both bodies.
Task routing (0242) and HQ attribution (0238) entries for the new agents are added in a later migration of ours
once those land on main; their migrations are never edited.

## Evidence

AI-0 INV-36 (happy path per agent with the fake provider, plan agent/task class pinned, no record names in facts,
refusal without capability, Alex sections NOT_AUTHORIZED, lapse at prepare BLOCKED, lapse after answer conceals,
bad input, table constraints, internal fact functions, readiness), plus INV-23/26/27 updated for 8 agents.
