# Automation workflows, contact tags and the engine (AU-1 0416, AU-2 0423)

Design: [docs/superpowers/specs/2026-11-15-automation-builder-design.md](../superpowers/specs/2026-11-15-automation-builder-design.md).
0416 stores and versions workflow definitions and the shared contact tags. 0423 adds the engine: staff turn a workflow
on or pause it, qualifying events start runs, and due steps run with durable per-step history. See "Engine (0423)".

## Definition (schema version 1)

One model for the visual editor and for workflows HON or an AI agent proposes:

- `trigger {kind, config}`: event triggers (lead created, form lead, Meta lead, trial booked/cancelled/attended/no-show,
  class and event bookings, membership activated/cancelled, missed call, conversation message/escalation, testing
  registration, tag added, custom tool record), time triggers (absent N days, membership ends in N days, birthday,
  anniversary, schedule with an audience by group, tag and rank) and manual start.
- `entry {reentry, reentryDays, conditions[≤10]}`, `exitWhen[≤5]`, `steps[1..50]`, each `{id, type, ...}` with `next`
  or `yes`/`no` links. The first step is the start; every step must be reachable and no path may loop.
- Step types: SEND_SMS, SEND_EMAIL (fixed wording, or AI-written with fixed fallback wording), CREATE_TASK,
  NOTIFY_STAFF, ASSIGN_LEAD, ADD_TAG, REMOVE_TAG, MOVE_STAGE, START_WORKFLOW, WAIT, WAIT_FOR, IF, REQUEST_APPROVAL, STOP.
- Text is plain, trimmed, without control characters; the only `{{...}}` allowed are `first_name`, `school_name`,
  `program_name`, `trial_time`, `booking_link`, `staff_name`. No expressions, code, SQL, URLs, recipients or tool calls.
- `validateAutomationDefinition` (`@hon/contracts`) and `hon.validate_automation_definition` implement the same rules;
  the database proof runs a shared corpus (`packages/database/scripts/automation-definition-corpus.mjs`) through both.
  The 64 KB size limit is measured on JSON text in TypeScript and on jsonb text in PostgreSQL, so very near the limit
  the database can be the stricter one.

References inside steps (stage, program, staff, workflow ids) are checked when the engine turns a workflow on, not here.

## Lifecycle

Saving appends an immutable version (at most 500); restore appends a copy of an older version. Concurrency uses the
workflow `revision`. DRAFT or PAUSED → ACTIVE through "turn on" at one version; ACTIVE → PAUSED by staff or by the engine
(`STAFF_PAUSED`, `AUTHORITY_LOST`, `FAILURE_RATE`). A DRAFT or PAUSED workflow can be archived (open runs are cancelled);
an archived workflow never changes again. Editing a running workflow appends a version and keeps the active one until
someone turns on the new version. At most 100 workflows that are not archived per school.

## Contact tags

`hon.contact_tags (organization_id, school_id, person_id, tag, tag_key, added_by_principal_id, added_source, added_at)`,
unique on `(organization_id, school_id, person_id, tag_key)` where `tag_key = lower(tag)`; index
`(organization_id, school_id, tag_key, person_id)` for list filters. Up to 20 tags per person and 200 distinct per school.
Every add and remove is recorded in `hon.contact_tag_events` and emits `contact.tag.added` / `contact.tag.removed`
outbox events (ids and tag key only). Staff use the commands below; the engine calls the private
`hon.contact_tag_apply` with source AUTOMATION and its run id (carried as `automationRunId` in the outbox payload). A later migration's private definer read may join
`contact_tags` for a tag filter, after checking `contact.tag.read` and COMPLETE access.

## Authority and API

Permissions (OWNER by default, staff-assignable): `automation.workflow.read`, `automation.workflow.manage`,
`automation.workflow.activate` (turn on, pause), `contact.tag.read`, `contact.tag.manage`. Every call needs a
direct human with the exact permission at the session school, an active organization and school, and an active
COMPLETE entitlement. Delegation and Action Engine contexts are refused.

| Route (`/v1/organizations/:org/schools/:school/...`) | Command header | Permission |
|---|---|---|
| `GET automations`, `GET automations/:id`, `GET automations/:id/versions/:v` | none | workflow.read |
| `POST automations` `{name, definition}` | `automation.workflow.create` | workflow.manage |
| `POST automations/:id/versions` `{expectedRevision, name, definition}` | `automation.workflow.save` | workflow.manage |
| `POST automations/:id/restore` `{expectedRevision, fromVersion}` | `automation.workflow.restore` | workflow.manage |
| `POST automations/:id/archive` `{expectedRevision}` | `automation.workflow.archive` | workflow.manage |
| `POST automations/:id/activate` `{expectedRevision, version}` | `automation.workflow.activate` | workflow.activate |
| `POST automations/:id/pause` `{expectedRevision}` | `automation.workflow.pause` | workflow.activate |
| `GET automations/:id/runs` (latest 100 + counts), `GET automations/runs/:runId` (steps) | none | workflow.read |
| `GET contact-tags`, `GET people/:personId/tags` | none | tag.read |
| `POST contact-tags/lookup` `{personIds ≤200}` (read, no key) | `contact.tag.lookup` | tag.read |
| `POST people/:personId/tags` `{tag}` | `contact.tag.add` | tag.manage |
| `POST people/:personId/tags/remove` `{tag}` | `contact.tag.remove` | tag.manage |

Commands need an `Idempotency-Key`; replay returns the first answer, other content under the same key is refused.
Audit and outbox payloads carry ids, versions and trigger kinds only, never message text.

## Engine (0423)

**What runs today.** Turning on refuses, by name (`422 AUTOMATION_NOT_AVAILABLE_YET` with `part`), anything this engine
does not run yet: triggers other than lead created, form lead, Meta lead, trial booked/cancelled/attended/no-show, class
booking, membership activated/cancelled, testing registration and tag added; the REPLIED exit, wait and condition;
IN_PROGRAM and CUSTOM_FIELD_EQUALS conditions; ASSIGN_LEAD and REQUEST_APPROVAL steps; LEAD_ASSIGNEE as a staff target;
and the `program_name`, `trial_time`, `booking_link` and `staff_name` merge fields. Stage, form and START_WORKFLOW ids
must belong to the school (`422 AUTOMATION_REFERENCE_INVALID`); a workflow cannot start itself. AI wording is not called:
AI-mode messages send their fixed fallback wording (`QUEUED_FALLBACK_WORDING`).

**Events.** `hon.consume_automation_events(limit)` reads outbox events of ten types from the last 7 days that occurred
after a matching workflow was turned on, resolves the contact from the event's own records (lead, appointment, booking,
membership, registration, person), never from the payload, and writes one receipt per event
(`hon.automation_event_receipts`) under a per-event lock, so each event is consumed once even with two engines. Each
event runs in its own subtransaction: one that errors is receipted `EVENT_ERROR` with nothing it started kept, and the
events behind it still run; serialization failures and deadlocks end the batch instead and are retried. A run
starts only when the workflow is ACTIVE, its activator still may run it, the contact is at the school, there is no open
run for that contact, the trigger key (`lead:`, `appt:…:STATUS`, `book:`, `mact:`/`mcan:`, `test:`, `tag:<event>`,
`run:<parent>`) has not started one before, the reentry rule allows it, the workflow started fewer than 500 runs in the
last day (counted under a per-workflow lock) and the entry conditions hold. A tag event caused by a workflow's own run never starts that workflow.

**Steps.** `hon.run_due_automation_steps(limit)` takes due steps (`FOR UPDATE SKIP LOCKED`) of RUNNING runs of ACTIVE
workflows; a workflow a staff command has locked is skipped for that batch, never waited on. Before each step it
re-proves the activator (active human staff with `automation.workflow.activate` and `communication.message.queue` at the
school, the same check as at turn-on, active organization and school, active COMPLETE entitlement; otherwise the workflow pauses `AUTHORITY_LOST`) and
the exit rules (trial booked, enrolled, lead closed, opted out → run EXITED `EXIT_<rule>`). Each step runs in its own
subtransaction; an error fails that run only (`STEP_ERROR`; serialization failures and deadlocks are re-raised, not counted), and when at least 20% of the workflow's last 50 finished
steps (at least 10) failed the workflow pauses `FAILURE_RATE`.

- SEND_SMS / SEND_EMAIL: checked at send time for OPTED_IN consent on the channel, an address, at most 3 automated
  messages per contact per 24 hours (counted under a per-contact lock) and length; then one QUEUED `hon.communication_messages` row with
  `origin_kind='AUTOMATION'`, `origin_id` = the run step and (email) `email_subject`, created by the fixed AUTOMATION
  principal `00000000-0000-4000-8000-000000000368`. The 0243 delivery worker sends it with its own consent, address,
  quiet-hours and STOP checks. A skipped send records why (`NO_CONSENT`, `NO_ADDRESS`, `DAILY_CAP`, `TEXT_TOO_LONG`).
  Since 0424 (CA1b) the delivery worker reads `email_subject` for the email it is sending (`hon.communication_email_subject`)
  and SendGrid uses it; an email without one keeps the standard subject "A message from <school>".
- CREATE_TASK / NOTIFY_STAFF: one READY HUMAN_UI work item (with its history row) for the school's owners.
- ADD_TAG / REMOVE_TAG (20-tag limit → `TAG_LIMIT_REACHED`), MOVE_STAGE (open lead in that stage's pipeline only, never to a hidden (0417) stage, through the 0417 single-lead stage guard; one identifier-only `crm.lead.stage_moved` audit row per lead with
  prior and next stage, run and workflow),
  START_WORKFLOW (at most depth 3; never a workflow already in the chain: `CHAIN_LIMIT`).
- WAIT (minutes, or the next school-local time), WAIT_FOR trial booked / enrolled (re-checked every 5 minutes until the
  timeout, then the `no` branch), IF, STOP.

Runs and steps only move forward (`hon.guard_automation_run`); receipts never change. History reads return the contact's
first name only and step outcomes, branches, message and task ids and delivery status, never message text.

**Worker.** The engine functions are callable only by the `hon_automation_worker` login (`infra/postgres/014_supabase_hon_automation_worker.sql`:
NOSUPERUSER, NOBYPASSRLS, NOINHERIT, EXECUTE on the two functions only). The API runs them in-process only when both
`HON_AUTOMATION_WORKER_DATABASE_URL` and `HON_AUTOMATION_ENGINE_INTERVAL_SECONDS` (15–3600) are set; it refuses a URL
reused from the runtime, migration or communication worker login (`AUTOMATION_WORKER_ROLE_REUSED` in deployment
configuration) and a role that is a superuser, bypasses RLS or inherits. Nothing is switched on by default.

## Validation

- `packages/database/scripts/test-automation-workflows-integrity.mjs` (champions-club fixture, 8 groups).
- `packages/database/scripts/test-automation-engine-integrity.mjs` (champions-club fixture, 15 groups, incl. the 011
  exact verification for 0416 and 0423 and drift refusals).
- `apps/api/test/automation-workflows.test.cjs`, `apps/api/test/automation-engine.test.cjs` (mocked boundary, worker,
  scheduler and deployment configuration).
