# Jordan follow-through (P2, migration 0640)

Status: spec + build, 2026-11-22. Asked for by David ("I want all ai agent backend done and switch them on"). It replaces Jordan's
"Operational task follow-through: Backend required" line in the Ask HON roster (`apps/web/src/components/hon-command/roster.ts`).
Built the same way as Alex delegation plans (`ALEX_DELEGATION_PLANS.md`, 0639) and reuses its line, key and immutability helpers.

## What it does

A team manager asks Jordan to look over the school's **overdue** tasks or **all open** tasks, with an optional note ("the belt test is
Saturday"). Jordan reads the same operations facts it already answers from (0260 `read_specialist_school_facts('jordan')`), the
staff who can take tasks, and up to 30 open human tasks, and answers with a short summary and up to 10 suggestions, at most one per
task:

- **RESCHEDULE**: a new due day (0..31 days from today, 17:00 school time).
- **REASSIGN**: give the task to another staff member.
- **REPRIORITIZE**: LOW, NORMAL or HIGH.
- **FOLLOW_UP**: add a check-in task for the requester ("Follow up: <title>"), optionally due on a day.

Nothing happens until the person ticks suggestions and presses **Apply**. Each ticked suggestion runs through the ordinary human
work path (0084 `hon.mutate_human_work`) as that person: an UPDATE of the task at the exact version Jordan read (only the named field
changes) or a CREATE of the follow-up task. A task that changed after Jordan read it refuses the whole apply (`VERSION_CONFLICT` →
`JORDAN_FOLLOW_UP_TASK_CHANGED`), and so does a finished task or an assignee who lost access. Everything is one transaction; an exact
retry replays. Jordan never sends, books, charges, completes or deletes anything.

## Contract

- Kind (0550): `JORDAN_FOLLOW_UP`, agent `jordan`, task class `ANALYZE`, budgets 12,000 in / 3,000 out, max provider cost 80,000
  micro-USD, result at most 12 KB, caller `HUMAN_UI`, subject `SCHOOL`, usage agent `OPERATIONS` (Jordan's existing HQ usage line).
  No S4 function changes.
- Who asks: a direct human at the session school with `schedule.session.manage` (Jordan's capability, 0260), `work_item.manage`,
  `work_item.create`, `ai.invocation.plan` and an active Complete entitlement. The per-staff agent switch `ai.agent.jordan.use`
  (0635) is enforced by the planner. Who reads: `schedule.session.manage` and `work_item.manage` (the lists show team task titles,
  which only team task managers see in Work).
- Brief: `{focus: 'OVERDUE' | 'OPEN', note: '' or 1..300 safe characters}`.
- Facts sent to the provider (at most ~10 KB): the brief, school name, local date, Jordan's 0260 facts, staff as aliases only
  (`S1..S30`, role, open task count) and tasks as `W1..W30` with title, status, priority, assignee alias (`OTHER` when outside the
  first 30 staff, null when unassigned), `dueInDays` (negative when overdue) and `daysSinceChange`. Task titles are staff-written
  and sent as untrusted text; task descriptions, staff names, emails and phones, and family, student, lead or payment records are
  never sent. The aliases and the task versions are fixed at prepare time in `hon.jordan_follow_up_refs`.
- Answer: `{summary ≤300, suggestions: 1..10 of {item 'W<n>', action, reason ≤300, dueInDays, assignee, priority}}`, where each
  action carries exactly its own field (others null). Checked in the database (`jordan_follow_up_ok`, plus every alias must be one
  Jordan was given) and in contracts (`validateJordanFollowUpProposal`, plus no links or email addresses). Outside the shape: stored
  empty and RESULT_REJECTED with its usage kept.
- Apply: `POST …/jordan/follow-ups/:id/apply {suggestions: [index…]}` with an Idempotency-Key; each step keyed
  `<idempotency-key>:<index>`; then the list closes APPLIED with the touched work-item ids.
- Dismiss: `POST …/jordan/follow-ups/:id/close {status:'DISMISSED'}`.

## API and web

- `apps/api/src/jordan-follow-through/*`: controller under `organizations/:o/schools/:s/jordan/follow-ups` (scope resolved with
  `schedule.session.manage`), service as for Alex, provider profile at temperature 0.2.
- Web: on Jordan's page in Ask HON, a "Follow through with Jordan" panel: overdue/all open, optional note, suggestions by task title
  in plain words with tick boxes, **Apply** and **Dismiss**. The roster line becomes AVAILABLE.

## Tests

- DB proof `test-jordan-follow-through.mjs`: custody, facts (OVERDUE vs OPEN, no names or descriptions), apply through 0084 as the
  requester (only the named field, history actor), follow-up tasks, version conflict all or nothing, rejected answers, UNKNOWN hold
  and HQ queue, OPERATIONS usage, gates (team task management, AI planning, Complete, readers), isolation, append-only evidence, 011.
- API unit test, contracts validators, web test.
