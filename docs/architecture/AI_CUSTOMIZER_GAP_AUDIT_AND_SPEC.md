# AI Customizer / Tool Maker: gap audit and spec

Main checked at `fbc9102` (2026-11-15). Migrations allocated by the coordinator: **0362 (CM-1)**, **0363 (CM-3, reserved)**.

## 1. Gap audit (section 9 of David's 2026-11-15 handoff)

| Area | State | Evidence |
| --- | --- | --- |
| AI Customizer itself (custom records, views, nav, module publish/rollback) | **Absent** | No code, table, route or API. Only policy text: `docs/HON_MASTER_DIRECTIVE.md` §46, `docs/architecture/HON_CORE_PLATFORM_ARCHITECTURE.md` §13.9, `TODO.md` §8 (unchecked). |
| Custom fields on existing records (student behaviour score, extra trial status) | **Absent** | Student, lead and trial tables have fixed columns; no extension storage. |
| Custom printable documents with data bindings | **Partial, different purpose** | 0062-0064 document templates are static acknowledgement texts (no data bindings, no print layout). Testing certificates are records, not printable templates. |
| School-scoped tenancy, RLS, roles, permission grants | **Verified, reusable** | `hon.staff_member_eligible`, role grants, FORCE RLS pattern, `require_*_actor` resolvers (e.g. 0335). School roles are editable (`HUMAN_STAFF_ROLE_ADMINISTRATION.md`). |
| Idempotent commands, audit, outbox | **Verified, reusable** | `*_commands` claim/replay pattern, `hon.audit_events`, `hon.outbox_events` (0335, 0330). |
| School navigation | **Verified, static** | `apps/web/src/components/school-shell/catalog.ts` is a closed list. Custom sections need a dynamic, server-verified entry. |
| Parent surface | **Verified, reusable** | `hon.resolve_parent_family_scope` and 0329/0330 family scope. |
| AI proposals (AI interprets a request, proposes a design) | **Partial, reusable** | AI invocation planning, task routing (0242/0287), per-school ceiling (0244/0288), stand-in providers. No customizer task class yet. Real provider calls still need David's OK. |
| Automation triggers on custom tool events | **Absent** | Automation thread owns the engine. CM-1 emits `custom_module.record.created/updated` v1 for it. |
| Marketplace sharing of tools | **Partial (descriptive only)** | 0085 marketplace is browse/save; no install. Install of a module copy needs a later slice. |
| Action Engine for consequential actions | **Verified, reusable** | Custom tools get no Action Engine catalog entries in CM-1; domain-backed actions arrive as a closed catalog later. |

## 2. Core design: a controlled extension framework

The AI never writes code or SQL. Everything a school builds is a **module definition**: a closed, versioned JSON document checked by the same validator in SQL and TypeScript. The platform runs definitions with fixed, reviewed code.

### Definition (schema version 1)

- `name`, `description`, `icon` (closed set), labels in en/ko/es (en required).
- `entities` (1-10): `key`, `label`, `fields` (1-40). Field types: TEXT, LONG_TEXT, INTEGER, NUMBER, BOOLEAN, DATE, CHOICE, MULTI_CHOICE, STUDENT_REF, STAFF_REF, RECORD_REF(entity). Options: required, choices (1-50), min/max, max length.
- `views` (1-20): TABLE (columns, sort), FORM (fields), DASHBOARD (cards: COUNT, SUM, AVERAGE, LEADERBOARD grouped by a ref field), each on one entity.
- `navigation`: ordered view keys shown as tabs of the module's own section.
- `access`: per school role id, capabilities among VIEW, CREATE, EDIT, ARCHIVE. Owners (designers) always have all. No rule ever grants a platform permission.

### Rules

- **Field key/type stability**: once a field key exists in any version of a module, its type cannot change. Removing a field hides it but keeps stored values. This makes **restore of any earlier version always safe**.
- Records are validated against the **published** version on every write; refs must resolve to this school's own students/staff/records.
- Draft versions are editable only before publication; published versions are immutable. Publishing supersedes the previous published version. Restore = new draft copied from an older version, then publish.
- Preview: a draft can hold **preview records** that never mix with live records and are discarded when the draft is published or abandoned.
- Permissions: `custom_module.design` (sensitive, OWNER backfill) to design/publish/restore; `custom_module.use` (staff-assignable, OWNER backfill) as the base gate for records, plus the module's own access rules.
- Live school, organization and entitlement required; authority re-checked after writes. Identifier-only audit; outbox events for record changes.
- Limits: 25 modules per school, 50,000 live records per module, 32 KB per definition, 8 KB per record.

## 3. Slices (small PRs)

1. **CM-1 (0362)** DB + API + contracts: modules, versions, validator, publish/restore, records with per-module access, preview records, audit/outbox, DB proof.
2. **CM-2** Web: Tool Maker workspace (list, plain-language design review, preview, publish, version history, restore) and the runtime section `/staff/tools/[key]` (table, form, dashboard), plus a dynamic "Custom tools" nav entry from the API.
3. **CM-3 (0363)** AI proposals: "describe a tool" and "change my tool" through the AI invocation path (stand-in provider until David approves real calls); the output is only a draft definition through the same validator. Ask HON hook.
4. **CM-4** Customize existing features: extension entities attached to a student/lead (one record per student) and placements on the student profile and dashboard.
5. **CM-5** Print templates with data bindings (e.g. 8 students per page testing sheet, ID cards, certificates).
6. **CM-6** Parent app surface (parent-visible fields, own children only) and controlled public forms.
7. **CM-7** Automation: custom tool events as triggers, closed catalog of custom-tool actions.
8. **CM-8** Marketplace: share a definition (never records) and "Use in my school" installs a draft copy.

Acceptance (section 8): an owner requests a new module, reviews it, publishes it as its own section, creates real records, then modifies and restores it. CM-1 to CM-3 together meet this; CM-1 proves it at the database and API level.
