# AI Customizer: custom tools (CM-1, migration 0362)

A school can build its own HON OS tool, for example a Demo Team, Leadership Points or Tournament Scoring section, without
code. A tool is a **closed, versioned definition** that fixed, reviewed HON code runs. Nothing in a definition is code,
SQL, a security policy or a permission, so neither an AI model nor a person can use it to change protected HON behaviour.
CM-1 is the framework (database, API, contracts). The screens (CM-2) and HON proposing tools (CM-3) build on it.

## Definition, schema version 1

| Part | Rules |
| --- | --- |
| `name`, `description` | Labels in English (required), Korean and Spanish; plain text, 80 / 400 characters. |
| `icon` | One of 12 fixed icons. |
| `entities` (1-10) | Record types, each with 1-40 fields. Field types: TEXT, LONG_TEXT, INTEGER, NUMBER, BOOLEAN, DATE, CHOICE, MULTI_CHOICE, STUDENT_REF, STAFF_REF, RECORD_REF (to another record type of the same tool). Options: `required`, `maxLength`, `min`/`max`, `choices` (1-50). |
| `views` (1-20) | TABLE (columns, sort), FORM (fields), DASHBOARD (COUNT, SUM, AVERAGE, LEADERBOARD grouped by a student, staff, choice or record field). |
| `navigation` (1-12) | The view keys shown as the tool's own section tabs. |
| `access` (0-20) | Per school role: VIEW, CREATE, EDIT, ARCHIVE (VIEW required). Parent, guardian, student, family, HQ and platform roles can never be named. |

Every key set is closed. `customToolDefinitionProblems` in `@hon/contracts` mirrors the rules so screens and HON can name a
problem; `hon.custom_tool_check_definition` is the authority and also checks that roles are usable at the school and that
**a field never changes type (or link target) between versions**. That rule makes restoring any earlier version safe.

## Authority

| Permission | Who | Allows |
| --- | --- | --- |
| `custom_tool.design` | Sensitive, OWNER backfill, assignable | Create and change drafts, preview, publish, discard, restore, archive. Designers have every capability on records. |
| `custom_tool.use` | OWNER backfill, assignable | Base gate for published tools. The tool's own access rules then decide VIEW / CREATE / EDIT / ARCHIVE. |

A direct human from HUMAN_UI only, with a live organization, school and entitlement, re-checked after every write.
Delegation, Action Engine, AI and HQ principals are refused. Route ids are selectors, never authority. Creating a tool
never grants anyone anything: staff only get what an access rule names for one of their live roles.

## Lifecycle

- One open DRAFT and one PUBLISHED version per tool. Saving changes the open draft or opens a new one. Publishing
  supersedes the previous published version; a published version never changes.
- RESTORE copies any earlier non-draft version into a new DRAFT (access rules whose role is gone are dropped); the open
  draft must be published or discarded first. ARCHIVE hides the tool and stops live writes; records are kept.
- Preview: a designer can write preview records against the open draft. They never mix with live records and become
  unreadable when the draft is published or discarded.
- Records are validated against the published definition on every write, under a share lock that a publish waits for.
  Links must point to this school's own student, staff member or a live record of the same tool. Values of a field taken
  out of the definition are hidden and kept, and come back if a version with that field is restored.
- Limits: 25 tools per school, 32 KB per definition, 8 KB per record, 50,000 live records per tool, 2,000 preview records.

## Storage and evidence

Five FORCE-RLS deny-all tables (`custom_tools`, `custom_tool_versions`, `custom_tool_records`,
`custom_tool_record_events`, `custom_tool_commands`) behind eight SECURITY DEFINER entry points. A guard trigger blocks
deletes, truncation and any change to a published version, record history or command receipt. Commands are idempotent
with exact replay. Audit and `outbox_events` carry identifiers only. Live record changes emit
`custom_tool.record.created|updated|archived|restored` (schema version 1, `{toolId, toolKey, entity, recordId,
publishedVersion}`) for Automation to use as a "custom tool event" trigger; nothing consumes them yet.

## API

`/v1/organizations/:org/schools/:school/custom-tools`: `GET` list; `POST drafts`; `GET :toolId[?version=]`;
`POST :toolId/changes`; `GET :toolId/records?entity=&preview=&archived=&limit=`; `POST :toolId/records`;
`GET :toolId/dashboards/:viewKey[?preview=]`; `GET :toolId/link-options?kind=STUDENT|STAFF|RECORD&entity=&search=`.
Writes need `X-HON-Human-Command` (`custom_tool.draft.save`, `custom_tool.change`, `custom_tool.record.write`) and an
`Idempotency-Key`.

## Evidence

`test-custom-tools-integrity.mjs` (8 groups, champions fixture) and `apps/api/test/custom-tools.test.cjs`.

## Not in this slice

Screens and the custom tools navigation entry (CM-2); HON proposing and changing tools (CM-3, 0363); fields on existing
records such as the student profile (CM-4); printable templates (CM-5); parent app and public forms (CM-6);
Automation triggers and tool actions (CM-7); marketplace sharing (CM-8). No AI provider, message, payment or deployment.
