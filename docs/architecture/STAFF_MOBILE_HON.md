# HON Staff app S2 — HON tab and per-staff agent switches (spec)

Status: S2a (server, migration 0635) built 2026-11-22; S2b (app HON tab) next PR. Owner asks: David, 2026-11-22
("make all agents available but will be given permission per staff"; decision card "Keep today's access"; "Go" for S2).
Plan: `/mnt/project-files/staff-app/STAFF_APP_PLAN.md` section 3 and phase S2. Builds on S0/S1
(`STAFF_MOBILE_SIGN_IN.md`, `STAFF_MOBILE_TODAY.md`). **Security-material: changes who may use each AI agent and
widens the staff app route allow-list; goes on the pre-launch risk list with S0 and S1.**

## Agent switches (0635)
Nine staff-assignable permissions, one per school agent, shown in Staff > Roles & permissions under "AI team":

| Switch | Agent | Capability it also needs (unchanged, 0212/0284) |
|---|---|---|
| `ai.agent.hon.use` | HON (questions; paper import reading plans as HON) | `ai.invocation.plan` |
| `ai.agent.kai.use` | Kai, teaching and curriculum | `teaching.assistant.use` |
| `ai.agent.marcus.use` | Marcus, marketing drafts (website AI edits, merch ideas and the commerce review plan as Marcus) | `marketing.assistant.use` |
| `ai.agent.chad.use` | Chad, lead follow-up drafts | `crm.assistant.follow_up_draft` |
| `ai.agent.claire.use` | Claire, business performance | `reporting.view` |
| `ai.agent.alex.use` | Alex, general management | `reporting.view` |
| `ai.agent.jordan.use` | Jordan, operations | `schedule.session.manage` |
| `ai.agent.lena.use` | Lena, creative and commerce | `marketing.campaign.read` |
| `ai.agent.maya.use` | Maya, at-risk students | `retention.review.read` |

- **Two keys.** An agent works for a person only while they hold both its switch and its capability at that exact
  school. A switch never gives more than the person could do by hand. Every request still needs `ai.invocation.plan`,
  the Complete entitlement and the S4 spend guards, unchanged.
- **Per staff** = through the person's role, as with every other permission. The owner ticks an agent on a role.
- **Keep today's access (owner decision).** 0635 gives every existing role the switches of the capabilities it already
  holds, so nobody gains or loses an agent on deploy. System owner roles get all nine; new schools' owners get every
  permission at sign-up (0241). Roles created later get an agent only when the owner ticks it. The teaching-staff preset
  (`TEACHING_STAFF_ROLE_PRESET`) now carries the HON and Kai switches so Kai keeps working for teaching-only staff.
- HQ agents and Eian (family app) are unchanged: HQ agents are never plannable at a school; Eian has its own plan path.

## Where it is enforced (server only)
1. **The AI planner**, which every school AI request passes (HON chat on web and app, the Kai, Marcus and Chad pages,
   paper import, website AI, merch ideas, commerce review): `require_ai_agent_capability` before the planner's locks and
   `hold_and_recheck_ai_planning_authority` after them, which now also holds the switch rows FOR SHARE. A switch removed
   while a plan waits refuses that plan. A refused plan uses the existing paths (HON replies record
   `AI_ACCESS_REFUSED`; specialists record `AGENT_NOT_AUTHORIZED`).
2. **Starting a HON turn**: `begin_hon_turn` refuses an agent whose switch is off with 403 `HON_AGENT_OFF` before any
   turn is recorded. It is the 0284 function, unchanged, renamed `begin_hon_turn_0284` (no runtime grant) behind a
   wrapper with the same signature and grant.
3. **The agent list** (`read_ai_team_readiness`, used by the web Ask HON panel, the AI team page and the app): a
   switched-off agent shows `authorized=false`, `available=false`, `blockedBy=NOT_AUTHORIZED`. Same wrapper pattern
   (`read_ai_team_readiness_0284`). HON suggests only agents the person has switched on (`hon_reply_allowed_suggestions`).

Hiding a button is never the protection; the app and web only show what the server says.

## Staff app routes added (S2a)
`STAFF_MOBILE_ROUTES` in `apps/api/src/foundation/hon-identity.service.ts`, exact methods, anchored, UUID segments:

| Method | Path under `/v1/organizations/:org/schools/:school` | Re-decided live |
|---|---|---|
| GET | `/hon/readiness` | `ai.invocation.plan`; each agent's two keys |
| GET, POST | `/hon/conversations` | `ai.invocation.plan`; own conversations only |
| GET | `/hon/conversations/:conversation` | `ai.invocation.plan`; owner of the conversation |
| POST | `/hon/conversations/:conversation/turns` | `ai.invocation.plan`; the agent's two keys; S4 |

The plan's `GET /v1/me/agents` is not added: the existing per-school readiness read already answers "which agents can
I use here" from the database, so the app uses it (one less route). Still refused from the app (403
`MOBILE_SESSION_SCOPE`): tone, briefing, school notes, orchestrations, the AI team, Kai, Marcus and Chad pages.

Transport: `HonConversationHumanUiGuard` is unchanged. GETs pass; a native POST already has the M2 rule (no Origin, no
Sec-Fetch-Site, exact `X-HON-Human-Command: hon-conversation`, JSON) and needs an Idempotency-Key as on the web.

## S2b app (next PR)
A HON tab: the agent strip from readiness (switched-off agents not shown, with a one-line "Ask your owner to turn on
more agents"), one conversation, typed questions to HON or an analysis agent, answers from the turn receipt, one
idempotency key per unsent turn reused on retry, 403 `HON_AGENT_OFF` and spend refusals shown in plain words. Voice:
the phone keyboard's own dictation for now; a dedicated mic button later.

## Tests
- DB proof `packages/database/scripts/test-staff-ai-agent-switches.mjs` (ai-spend-baseline fixture, real API services,
  fake providers): catalog and grants, the 011 section, the backfill keeps today's access, two keys at the planner for
  all nine agents, the re-check after the planner's wait (fresh and replay), turns refused before any record, readiness
  and suggestions, the teaching-staff preset.
- AI-0 baseline (`test-ai-spend-authority-baseline.mjs`) passes; INV-27 now expects HON_AGENT_OFF (no turn) for the
  teaching-staff Marcus/Chad turns that used to be recorded and then FAILED.
- API `apps/api/test/staff-mobile-hon.test.cjs`: routes and methods admitted and refused, family refused, native POST
  rule, `HON_AGENT_OFF` mapping.
