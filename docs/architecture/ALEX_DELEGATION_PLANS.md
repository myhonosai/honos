# Alex delegation plans (P1, migration 0639)

Status: spec + plan, 2026-11-22. Asked for by David ("I want all ai agent backend done and switch them on"). It replaces Alex's
"Coordinate and delegate work across the team: Backend required" line in the Ask HON roster (`apps/web/src/components/hon-command/roster.ts`).
Inventory of every remaining agent capability: `/mnt/project-files/ai-agents-switch-on/INVENTORY_AND_PLAN.md` (project files).

## What it does

The owner (or a manager) gives Alex a goal for the week or the month ("get 10 more trial bookings", "tidy up before the belt test").
Alex reads the same verified school facts he already answers from (0260 `read_specialist_school_facts('alex')`), and the list of
staff who can take tasks, and answers with a short summary and up to 8 tasks. Each task has a title, a description, a priority, an
optional due date (days from today), an optional staff member, and the specialist area it belongs to (Chad, Maya, Marcus, Jordan,
Claire, Lena, or none).

Nothing happens until a person confirms. The requester ticks the tasks they want and presses **Create tasks**: each ticked task
becomes an ordinary human work item (`/staff/work`, 0084 `hon.mutate_human_work`), created by the requester, with the usual
permission checks (assigning someone else needs `work_item.manage`; the assignee needs `work_item.self_manage`). The description
ends with "Suggested by Alex." Alex never sends, books, charges or changes anything else, and an AI agent is never the assignee: the
area only links the person to that specialist's existing workspace.

## Contract

- Kind (0550 shared AI text proposals): `ALEX_DELEGATION_PLAN`, agent `alex`, task class `ANALYZE` (no task-profile category, so
  the school's TEXT policy order routes it, as for Alex's answers), budgets 12,000 in / 3,000 out, max provider cost 80,000
  micro-USD, result at most 12 KB, caller `HUMAN_UI`, subject `SCHOOL`, usage agent `GENERAL_MANAGEMENT` (Alex's existing HQ usage
  line, 0328). No S4 function changes: the 0550 core and its triggers already cover every kind.
- Who asks: a direct human (HUMAN_UI, no delegation, no action request) at the session school with `reporting.view` (Alex's
  capability, 0260), `work_item.create`, `ai.invocation.plan` and an active Complete entitlement. The per-staff agent switch
  `ai.agent.alex.use` (0635) is enforced by the planner for every Alex call. Who reads: `reporting.view` at the school; the list
  shows the school's newest 20 plans.
- Brief: `{goal: 1..500 safe characters, horizon: 'WEEK' | 'MONTH'}`.
- Facts sent to the provider (at most ~10 KB): the brief, the school name, the local date, Alex's 0260 facts, and the staff list as
  aliases only: `[{ref: 'S1', role: 'Owner' | 'Manager' | 'Instructor' | 'Front desk' | 'Staff', openTasks: n}]` (at most 30, people who
  hold `work_item.self_manage` at the school). No staff name, email or phone, and no family, student, lead or payment data leaves HON.
  The API maps `S1…` back to people when it shows the plan; the stored plan keeps the alias and the database resolves it again at
  create time, so a stale alias (the person lost access) refuses that one task with `ASSIGNEE_UNAVAILABLE`.
- Answer: `{summary: ≤300, tasks: 1..8 of {title ≤120, description ≤600, priority LOW|NORMAL|HIGH, assignee 'S<n>' | null,
  dueInDays 0..31 | null, area chad|maya|marcus|jordan|claire|lena|null}}`. Checked in the database (`alex_plan_ok`) and in contracts
  (`validateAlexPlanProposal`, plus no links or email addresses). An answer outside the shape is stored empty and RESULT_REJECTED
  with its usage kept (0550 rule).
- Create: `POST …/alex/plans/:id/create {tasks: [index…]}` with an Idempotency-Key. Requester only, plan RESULT_RECORDED, 1..8
  distinct indexes. One transaction: each index calls `hon.mutate_human_work('CREATE', …)` with key `<idempotency-key>:<index>`,
  then the plan closes APPLIED with the created work-item ids. Any refusal rolls the whole create back. An exact retry replays.
- Dismiss: `POST …/alex/plans/:id/close {status:'DISMISSED'}`.

## API and web

- `apps/api/src/alex-delegation/*`: controller under `organizations/:o/schools/:s/alex/plans` (GET list, POST ask, POST :id/create,
  POST :id/close), each its own same-origin human command guard; service mirrors `CommerceReviewService` (plan → prepare → provider
  → record/fail in separate transactions; UNKNOWN after 90 s held for the HQ owner). Provider: the existing OpenRouter text runtime
  with an Alex profile (temperature 0.3). Readiness follows `OPENROUTER_API_KEY` + `OPENROUTER_PAID_CALL_APPROVED`.
- Web: on Alex's page in Ask HON, a "Plan with Alex" panel: goal + week/month, the answer with tick boxes, staff names resolved,
  area chips linking to the specialist workspace, **Create tasks** and **Dismiss**. The roster line becomes AVAILABLE. English, like the rest of the Ask HON workspace.

## Tests

- DB proof `test-alex-delegation.mjs` (champions fixture): authority (no reporting.view, no work_item.create, not Complete, delegated
  source → refused), facts hold no names/emails, alias mapping, valid answer recorded, bad answer rejected with usage, create makes
  exactly the ticked work items with "Suggested by Alex.", assigning another person without work_item.manage refuses the whole create,
  replay, non-requester cannot create, cross-school isolation, privileges (only the entry points granted to hon_runtime).
- Contracts unit tests for brief/answer/view validators; API service test with a fake provider; web component test.

## Not in this slice

Jordan follow-through (P2), sending messages, Alex assigning work to AI agents, recurring plans.
