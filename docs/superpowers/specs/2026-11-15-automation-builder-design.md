# Automation Builder: design

Status: design for owner review, 2026-11-15. Source: David's "HON OS Complete AI Platform Handoff", section 4 (with
its share of sections 5 to 8). Gap audit: `/mnt/project-files/automation/AUTOMATION_GAP_AUDIT.md`.

## 1. Intent

A school owner automates repetitive sales, admin and retention work without programming. They either describe
the outcome to HON ("whenever someone submits a free evaluation form, text them right away, tell my staff, and
if they don't book within 24 hours send a follow-up") or build it by hand. Both produce **the same workflow
record**. The owner reviews the whole flow before it goes live. After that the server runs it on real school
events. It never depends on a browser tab, and the owner can always see what ran, why, and whether it worked.

## 2. Owner decisions this design follows

| Date | Decision |
|---|---|
| 2026-11-15 08:04Z | Active workflows **send automatically** when their preset conditions are met, AI-written messages included (the same as Conversation AI live replies). Only SMS or email **blasts** that AI helps write need approval; that is the campaign path, not this engine. |
| 2026-11-15 08:04Z | AI agents can create automations. **Our reading:** an agent (or HON) creates a DRAFT workflow; an authorized human turns it on. Activation is the owner's authorization for everything the workflow sends later. |
| Standing | No real provider sends or paid AI calls without David's OK. The existing switches (`*_SEND_APPROVED`, `OPENROUTER_PAID_CALL_APPROVED`) stay the gates. Tests use the fake providers. |
| Standing | Financial changes, destructive actions and policy exceptions go through Action Center approvals and are never direct workflow actions. |

## 3. Goals, non-goals, anti-goals

**Goals**
- Durable server-side execution: persistent run state, wait timers, retries, idempotency, execution log.
- Triggers from real school events plus time-based triggers and a manual staff trigger.
- Conditions, waits, yes/no branches, stop rules, entry and exit rules.
- Actions: send text or email (fixed wording with merge fields, or AI-written), staff task, assign, tags, CRM
  stage, notify staff, request approval, start another workflow, custom-tool action.
- 13 editable starter templates (handoff table).
- Automations section: active, draft and paused workflows, templates, the editor, the HON creator, run history,
  failed and scheduled steps, performance, versions and restore.
- English, Korean, Spanish; Modern, Classic and Big Button.

**Non-goals (this stream)**
- Bulk blasts and campaigns (existing marketing path, with approval).
- A free-form drawing canvas. The editor is a vertical step list with branches (works on a phone and in Big Button).
- New providers. Sends use the 0047 queue and the 0243 delivery worker only.

**Anti-goals (a failure even if it "works")**
- A family gets duplicate or looping messages, or messages without consent, or during quiet hours.
- A workflow acts with more authority than the person who activated it, or touches another school's data.
- A workflow changes money, memberships, refunds or discounts directly.
- AI output is executed as code, SQL or a free-form tool call. The model only fills a closed JSON shape that the
  same validator checks.
- A screen that looks like it works while nothing actually runs.

## 4. Approaches considered

1. **Extend the inert 0078 rules.** Rejected: its contract (and doc) forbids execution, and its closed
   two-trigger schema would need to be replaced anyway.
2. **External workflow service (Render Workflows, a queue product).** Rejected: a new paid service, a second
   place for tenant data, and it duplicates the lease and outbox patterns HON already proves.
3. **Chosen: an in-database engine that consumes `hon.outbox_events`, driven by a leased in-API scheduler**
   (same shape as `CommunicationDispatchScheduler`). Business events already land in the outbox inside the
   same transaction as the change. Most actions are database-only and run atomically inside one
   security-definer step function, so they can never end half done.

## 5. Design

### 5.1 Workflow record (one model for the visual and HON builders)

- `hon.automation_workflows`: identity per school; `status` DRAFT, ACTIVE, PAUSED, ARCHIVED;
  `active_version`; `activated_by_principal_id`; pause reason.
- `hon.automation_workflow_versions`: immutable. `definition jsonb` (below), `source` HUMAN_UI, HON_ASSIST or
  AI_AGENT, author principal, request id. Restore = append a copy of an old version.
- Definition (schema version 1, closed keys, validated identically in TypeScript and SQL):
  `trigger` {kind, config}, `entry` {reentry: ONCE_EVER | ONCE_PER_DAYS n | EVERY_TIME, conditions[]},
  `exitWhen[]` (for example "booked a trial", "replied", "enrolled"), `steps[]`, each
  `{id, type, config, next | yes/no}`. At most 50 steps, no cycles, every path ends.
- Merge fields only from a closed list (`first_name`, `school_name`, `program_name`, `trial_time`,
  `booking_link`, ...). No templating language.

### 5.2 Closed catalogues (v1)

**Triggers** (event to outbox type): new lead (`crm.lead.created`), form lead (`marketing.form.lead_received`,
`marketing.zernio.lead_received`), trial booked/cancelled, trial outcome (attended / no-show), class or event
booking created/cancelled, membership activated/cancelled, missed call, conversation message received /
escalated (Conversation AI thread), testing registration submitted, custom tool record created/updated
(`custom_module.record.*`, CM-1). **Time-based** (daily school-local scan): absent N days, membership ends in N
days, birthday, membership anniversary, scheduled date or weekly recurring time. **Manual** staff start.
Payment failed waits until billing emits a stable event; it stays listed as "coming" and does not appear in the editor.

**Conditions:** lead stage/status, booked a trial since the run started, has consent on channel, in program, membership
ends within N days, has tag, replied since run start, attendance count in last N days, custom field equals.

**Actions:** send text / send email (fixed wording or AI-written), create staff task (work item), assign lead,
add/remove tag (new small `hon.contact_tags`), move CRM stage, notify staff, request approval (Action Center,
run waits for the decision), start another workflow, run an approved custom-tool action.
**Flow:** wait (duration, until a school-local time, or until an event with a timeout), if/else, stop.

### 5.3 Engine

- `hon_automation_worker` login (like `hon_communication_worker`): no superuser, no BYPASSRLS, no table
  grants, only fixed security-definer functions:
  `consume_automation_events(limit)` (own cursor over the outbox, never the delivery queue),
  `scan_automation_time_triggers(limit)`, `claim_automation_steps(limit, lease)`,
  `record_automation_step_result(step, lease, outcome)`.
- `hon.automation_runs`: unique (workflow, trigger key, subject person), which blocks duplicate runs.
  `hon.automation_run_steps`: unique (run, step id, iteration); status PENDING, WAITING, RUNNING, DONE, SKIPPED,
  FAILED, UNKNOWN; `due_at`, lease, closed `outcome_code`, references (message id, work item id), and a short
  "why" code that the history screen shows.
- Database-only actions execute inside the step function in one transaction. A message is created
  `QUEUED` in `hon.communication_messages` by the school's AUTOMATION principal, and 0243 delivers it with its
  consent, quiet-hours and STOP checks. Consent is also checked when the step runs.
- AI-written messages: the step calls the shared school-knowledge facts builder and the provider **outside**
  any transaction, then records the result. If the provider gate is off (the default), it uses the fake provider
  in tests or falls back to the step's fixed wording. A lost answer becomes UNKNOWN and is never retried automatically.
- Retries: bounded with backoff for retryable failures only. A lost lease is UNKNOWN, shown in Failed with a
  "check and retry" control for staff.

### 5.4 Safety rails

- Authority re-checked at every step: school ACTIVE, active COMPLETE entitlement, and the activator still holds
  `automation.workflow.activate` there. If any check fails, the workflow pauses with a visible reason.
- Caps: automated messages per contact per day across all workflows (default 3, owner can lower it); runs per
  workflow per day (default 500); auto-pause when 20% or more of the last 50 steps fail.
- Loop guard: events caused by the automation principal never re-trigger the same workflow; "start another
  workflow" chains at most 3 deep.
- Tenant isolation: forced RLS on organization + school for every table; the worker only sees rows through
  its functions; cross-school proofs.
- Permissions (new, staff-assignable, owner by default): `automation.workflow.read`, `.manage` (edit drafts),
  `.activate` (turn on, pause, restore), `.run` (manual start), `.history.read`.

### 5.5 HON and AI agents as builders

"Describe it to HON" sends the request to HON with the trigger, condition and action catalogue. HON returns a
definition JSON, which goes through the same validator and opens in the editor as a DRAFT with a plain-language
summary ("When a free evaluation form arrives: text right away; tell staff; wait 24 hours; if no trial booked,
send follow-up"). Agents (Chad, Maya, ...) create DRAFTs the same way. A human reviews and activates.
Fake provider by default.

### 5.6 Screens (`/staff/automations`)

Tabs: Active, Drafts, Paused, Templates, History, Failed, Scheduled. Editor: trigger card, entry rules, vertical
steps with yes/no branches, "Test with a sample contact" (dry run, no sends), versions with restore, a Turn on /
Pause control. A run detail page shows each step, when it ran, why, and the message or task it created. A
performance strip shows runs, completed, messages sent and goal reached (for example trial booked). It gets a nav
entry next to Marketing, plus an "Ask HON" entry.

### 5.7 Added by David 2026-11-15 08:23Z (Manus CRM ideas #10 to #12, "apply all")

- **Results card** (campaigns and each workflow's send steps): accepted, delivered, skipped (with reason: no
  consent, cap, quiet hours, duplicate household), failed, not delivered, all read from 0243 receipts.
  "Read" is shown as *not available for SMS*, never guessed.
- **Audience by household**: audience chips for active students, all contacts, prospects, trial, former students, or one person,
  filtered by belt rank and tag. Recipients are deduplicated to one per household using the primary number or email
  by default, and the screen shows the count after deduplication ("157 numbers after household deduplication").
  Used by blasts (which still need approval when AI helps write them) and by time-based/scheduled workflow triggers.
- **Catch-up list**: leads that arrived before a workflow (or Conversation AI auto-texting) was switched on are
  listed. Staff pick some and send the first message once. Consent and STOP still apply, each lead can be caught up
  only once per workflow, and leads arriving after activation never appear (they get the live workflow).

## 6. Pull requests (each with tests; migration numbers from the coordinator)

| PR | Content |
|---|---|
| AU-1 | Workflow + version tables, validator (TS = SQL), permissions, CRUD/version/restore API. No execution. |
| AU-2 | Engine: worker login, event consumer, runs/steps, scheduler, DB-only actions (text/email queue, task, notify, assign, tag, stage), waits, branches, caps, loop guard, history read. Proof: real `crm.lead.created` leads to a fake-provider delivery. |
| AU-3 | Time triggers (absence, membership ends, birthday, anniversary, schedule) and manual start. |
| AU-4 | Automations screens: lists, editor, run history, failed/scheduled, versions, 13 templates, nav. |
| AU-5 | HON / agent builder and AI-written message step (fake provider). |
| AU-7 | Results card, household audience (belt rank, tag, dedup count), catch-up list for older leads. |
| AU-6 | Cross-system: conversation and custom-tool triggers, request-approval step, start-another-workflow, end-to-end journey with the Website and Conversation AI threads. |

## 7. Acceptance (handoff section 8)

An owner describes a workflow, inspects and edits it visually, activates it. A real qualifying event (a form
lead created through the public form service) starts it, and the durable execution log shows each step. This is
verified after reload, with retries, a cross-school isolation proof, and permission denial for staff without
`.activate`. All of this runs with the fake provider until David approves live sending.

## 8. Left to the builder

Exact column names, index shapes, scheduler interval, default cap values within the stated bounds, template wording.
