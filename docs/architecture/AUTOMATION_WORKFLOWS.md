# Automation workflows and contact tags (AU-1, migration 0367)

Design: [docs/superpowers/specs/2026-11-15-automation-builder-design.md](../superpowers/specs/2026-11-15-automation-builder-design.md).
This piece stores and versions workflow definitions and the shared contact tags. **Nothing runs.** The engine (AU-2,
0368) consumes events, turns workflows on and executes steps.

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

DRAFT and ARCHIVED only in this piece. Saving appends an immutable version (at most 500); restore appends a copy of an
older version. Concurrency uses the workflow `revision`. Only a DRAFT can be archived, and an archived workflow never
changes again. ACTIVE and PAUSED (with `active_version`) are set only by the engine; editing a running workflow appends a
version and keeps the active one until someone turns on the new version. At most 100 workflows that are not archived per school.

## Contact tags

`hon.contact_tags (organization_id, school_id, person_id, tag, tag_key, added_by_principal_id, added_source, added_at)`,
unique on `(organization_id, school_id, person_id, tag_key)` where `tag_key = lower(tag)`; index
`(organization_id, school_id, tag_key, person_id)` for list filters. Up to 20 tags per person and 200 distinct per school.
Every add and remove is recorded in `hon.contact_tag_events` and emits `contact.tag.added` / `contact.tag.removed`
outbox events (ids and tag key only). Staff use the commands below; the engine will call the private
`hon.contact_tag_apply` with source AUTOMATION and its run id. A later migration's private definer read may join
`contact_tags` for a tag filter, after checking `contact.tag.read` and COMPLETE access.

## Authority and API

Permissions (OWNER by default, staff-assignable): `automation.workflow.read`, `automation.workflow.manage`,
`automation.workflow.activate` (used by the engine), `contact.tag.read`, `contact.tag.manage`. Every call needs a
direct human with the exact permission at the session school, an active organization and school, and an active
COMPLETE entitlement. Delegation and Action Engine contexts are refused.

| Route (`/v1/organizations/:org/schools/:school/...`) | Command header | Permission |
|---|---|---|
| `GET automations`, `GET automations/:id`, `GET automations/:id/versions/:v` | none | workflow.read |
| `POST automations` `{name, definition}` | `automation.workflow.create` | workflow.manage |
| `POST automations/:id/versions` `{expectedRevision, name, definition}` | `automation.workflow.save` | workflow.manage |
| `POST automations/:id/restore` `{expectedRevision, fromVersion}` | `automation.workflow.restore` | workflow.manage |
| `POST automations/:id/archive` `{expectedRevision}` | `automation.workflow.archive` | workflow.manage |
| `GET contact-tags`, `GET people/:personId/tags` | none | tag.read |
| `POST contact-tags/lookup` `{personIds ≤200}` (read, no key) | `contact.tag.lookup` | tag.read |
| `POST people/:personId/tags` `{tag}` | `contact.tag.add` | tag.manage |
| `POST people/:personId/tags/remove` `{tag}` | `contact.tag.remove` | tag.manage |

Commands need an `Idempotency-Key`; replay returns the first answer, other content under the same key is refused.
Audit and outbox payloads carry ids, versions and trigger kinds only, never message text.

## Validation

- `packages/database/scripts/test-automation-workflows-integrity.mjs` (champions-club fixture, 8 groups).
- `apps/api/test/automation-workflows.test.cjs` (mocked boundary).
