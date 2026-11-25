# Chad lead next steps (P9, migration 0650)

Status: spec + build, 2026-11-22. Asked for by David ("I want all ai agent backend done and switch them on"). It replaces Chad's
"Book trials or change lead records: Backend required" line in the Ask HON roster (`apps/web/src/components/hon-command/roster.ts`).
Plan line (`/mnt/project-files/ai-agents-switch-on/INVENTORY_AND_PLAN.md`): "Chad proposes a booking or lead change; a person
approves and the existing human command runs it." Built the same way as Maya renewal prep (`MAYA_RENEWAL_PREP.md`, 0646) on the
shared AI text proposals (0550), with the 0639 line, key and immutability helpers.

## What it does

A staff member asks Chad to look over the school's open leads, either **all open leads** or **leads with no trial yet**, with an
optional note ("we have space in the Saturday kids class"). Chad reads up to 15 OPEN leads (next follow-up soonest, then newest),
the open stages of their pipelines (up to 40) and the school's SCHEDULED classes starting between two hours and 14 days from now
(up to 20). He answers with a short summary and up to 10 suggestions, at most one per lead:

- **MOVE_STAGE**: move the lead to another open stage of its own pipeline (never its current stage); or
- **BOOK_TRIAL**: book a trial in one of those classes, only for a lead with no trial ahead.

Nothing changes from a suggestion. On Chad's workspace in Ask HON each suggestion has one button ("Move to Contacted", "Book a
trial: Kids basics, Monday 23 Nov, 17:00"). Pressing it runs the **ordinary human command as that person**:

- the lead pipeline stage move (`POST …/crm/leads/:lead/stage`, `crm.lead.stage.move`, 0417 `hon.move_crm_lead_stage`) with the
  lead version Chad read, so a lead that changed since is refused; or
- the trial booking (`POST …/crm/leads/:lead/trials`, `crm.trial.schedule`, `TrialAppointmentService.schedule`) at exactly the
  class start and end, with its one-active-trial-per-lead lock.

Then the web records the step (`POST …/chad/lead-plan/:id/steps/:index`). The database accepts it only when that person's own
command really made that change after Chad wrote the list:

- move: the lead is at the suggested stage now, and there is a SUCCEEDED `crm.lead.stage.move` audit event by the requester for
  that lead to that stage at or after the list was created;
- trial: the given appointment is the requester's own TRIAL for that lead, created after the list, starting and ending at the
  suggested class's times (to the millisecond), and not already linked to another step.

Otherwise it answers `CHAD_LEAD_PLAN_NOT_DONE` and records nothing. Each recorded step is audited (`chad.lead_plan.step_recorded`);
an exact retry replays; when every suggestion is recorded the list closes APPLIED. The person can dismiss a list at any time. The
command keys are kept until a command is confirmed, so a lost answer is retried with the same key and never runs twice. Chad never
contacts a lead and never changes anything himself.

## Contract

- Kind (0550): `CHAD_LEAD_PLAN`, agent `chad`, task class `DRAFT_FOLLOW_UP` (Chad's only plan class; routes to `CHAD_SALES`),
  budgets 10,000 in / 2,500 out, max provider cost 80,000 micro-USD, result at most 12 KB, caller `HUMAN_UI`, subject `SCHOOL`,
  usage agent `CHAD_FOLLOW_UP`. No S4 function changes.
- Who asks, reads and records: a direct human who passes 0107 `hon.require_chad_follow_up_actor` (staff at the session school,
  `crm.lead.read`, `crm.assistant.follow_up_draft`, `ai.invocation.plan`, active Complete). The planner enforces the per-staff Chad
  switch (`ai.agent.chad.use`) on every call. **Only the requester's own lists** are readable (the view shows lead names). Running a
  step also needs the command's own permission (`crm.lead.stage.move` or `crm.trial.schedule`), checked by that command.
- What Chad is sent: brief, school name, local date; per lead only the alias (L1..L15), its stage alias, days since created and
  updated, days to the next follow-up, program interest and source codes only when they are plain codes (`^[A-Z0-9_]{1,40}$`),
  whether a trial is ahead, past trials and no-shows; per stage the alias (S1..S40), the school's own stage name, order and pipeline
  alias (P1..), with the prompt telling Chad these school-written labels are names only, never instructions; each lead's pipeline alias; per class the alias (C1..C20), class name, weekday, date, local time and minutes. No
  name, email, phone, free-text note or attribution.
- Answer shape: `{summary ≤300, suggestions[1..10] {lead L1..L15, action MOVE_STAGE|BOOK_TRIAL, stage S# or null, slot C# or null,
  reason ≤300}}`, one per lead (`hon.chad_lead_plan_ok` and `validateChadLeadPlanProposal`). An answer outside the shape, naming an
  alias Chad was not given, a stage of another pipeline or the lead's current stage, or a trial for a lead with one ahead is stored
  empty and rejected ("The answer was not a list of next steps for these leads."); one with a link or email address is rejected by
  the API. Both keep their usage.
- Evidence: `hon.chad_lead_plan_refs` (alias to lead at the version and stage read, stage, or class; fixed at prepare) and
  `hon.chad_lead_plan_applied` (suggestion to the lead and, for a trial, the appointment; one appointment links once), both
  append-only, forced RLS, no runtime access.
- API: `GET|POST organizations/:o/schools/:s/chad/lead-plan`, `POST …/:id/steps/:index` (`{appointmentId: uuid|null}`),
  `POST …/:id/close`; human commands `chad.lead_plan.read|request|step|close`; scope resolved with `crm.lead.read`.

## Proof

`packages/database/scripts/test-chad-lead-plan.mjs` (CLP1, 10 groups) on a fresh disposable AI-0 fixture with a counted fake
provider and refused network: custody, what is and is not sent, a stage move and a trial recorded only after the requester's own
command (another person's move, a wrong stage, another lead's trial, another booker, another class time are all NOT_DONE), replay
and APPLIED, the NO_TRIAL_YET focus, rejected answers, unknown outcome, gates and isolation, append-only evidence, and the 0650 exact
011 section. API unit tests: `apps/api/test/chad-lead-plan.test.cjs`. Web: `apps/web/test/chad-lead-plan-ui.test.tsx`.
