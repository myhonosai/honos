# Rank setup and plain curriculum pages

Owner ask (David, 2026-11-21, live HON on main 981feb8): "i don't understand these. make it simpler and where is rank setup?"
Screens: Curriculum progress, Private curriculum library, Teaching studio, Achievements.

## 1. What was found

- The menu item **Rank setup** (school shell catalog key `ranks`) only opened four pages: library, progress, teaching studio and
  achievements. No screen created a program (curriculum), its belts or placed a student on a belt.
- The server already had: `POST .../curricula` and `POST .../curricula/:id/ranks` (inline SQL, no human-UI guard, no entitlement
  check, no edit or reorder), and the guarded `hon.mutate_curriculum_progress` (0070) for requirements, `ENROLL`, `SET_RANK`, `OBSERVE`.
- So Curriculum progress shows "No students with an active curriculum match": nobody can be placed on a belt from the app.
- The four pages still use the old light stylesheets and wording written for engineers ("Exact current enrollment read",
  "Enter record IDs instead", "ASCII HTTPS DNS URLs only", UUID read-outs, enum codes).

## 2. Goals

1. A real **Rank setup** page, first in the Ranks menu group, where a school owner or manager:
   - creates a program (for example "Kids Taekwondo") and renames it;
   - adds belts in order with a color, renames or recolors a belt, moves a belt up or down;
   - lists what each belt requires and adds or edits a requirement;
   - sees the students in the program with their current belt, places a new student on a belt and changes a student's belt.
2. Curriculum progress, Curriculum library, Teaching studio and Achievements in plain words and the dark `--hon-*` look
   (docs/architecture/SCHOOL_APP_CONSISTENT_LOOK_SPEC.md). No UUIDs, enum codes, record-ID boxes or engineering warnings.
3. Rank setup and Parent app > Curriculum link to each other: Rank setup owns the belt ladder; Parent app > Curriculum owns what
   families see (rank-based or cycle-based material). Nothing is duplicated.

Non-goals: deleting belts or programs (history and enrollments point at them; rename instead), promotion (stays in Testing),
AI, any external call.

## 3. Database (migration 0622, coordinator-allocated 2026-11-21)

Functions only; no table changes.

- `hon.read_staff_rank_setup(p_subject)`: `curriculum.manage` actor (0070 `require_curriculum_actor`, checked before and after the
  read). Returns `{ programs: [{ id, name, version, ranks: [{ id, name, color, order, version, students,
  requirements: [{ id, code, kind, label, description, required, version }] }] }], students: [...] | null }`.
  `students` (active enrollments of active students: enrollment id, program id, student id, given/family name, current belt id,
  enrollment version) is returned only when the actor also holds `curriculum.progress.record`, else `null`. Programs not ARCHIVED,
  capped at 100; belts capped at 60 per program; students capped at 1000.
- `hon.mutate_rank_setup(p_subject, p_operation, p_curriculum, p_target, p_input, p_key, p_request, p_correlation)`, closed operations:
  - `PROGRAM_CREATE` `{name}`: `p_curriculum` and `p_target` null; new curriculum `model_code='LINEAR'`, `lifecycle='PUBLISHED'`.
  - `PROGRAM_RENAME` `{name, expectedVersion}`.
  - `RANK_ADD` `{name, color}`: appended after the last belt.
  - `RANK_UPDATE` `{name, color, expectedVersion}` on `p_target`.
  - `RANK_MOVE` `{direction: 'UP'|'DOWN', expectedVersion}` on `p_target`: swaps order with its neighbour; both belts' versions bump.
  Names: 1 to 120 characters, trimmed, no control characters or `<>`, unique per school (programs) or per program (belts), case-insensitive.
  Color: `#RRGGBB` or null. Lock order: 0132 `lock_curriculum_resource_actor` (organization, school, actor, grants, roles,
  permissions, entitlement), receipt lookup, curriculum `FOR UPDATE`, its belts by id `FOR UPDATE`, then the actor is re-checked.
  Receipts reuse `hon.curriculum_command_requests` (0070, keyed by principal and idempotency key). Each command writes an
  `hon.audit_events` row (`curriculum.rank_setup.<op>`). Returns the program's projection.
- Requirements and student placement keep using `hon.mutate_curriculum_progress` (REQUIREMENT_CREATE/UPDATE, ENROLL, SET_RANK),
  which already carries history, audit, outbox and the deferred evidence trigger.

## 4. API

`staff/schools/:schoolId/rank-setup` (identity guard + human-UI guard with command `rank-setup`, no query selectors):
`GET` read; `POST programs`; `POST programs/:curriculumId/versions` (rename); `POST programs/:curriculumId/ranks`;
`POST programs/:curriculumId/ranks/:rankId/versions` (edit); `POST programs/:curriculumId/ranks/:rankId/move`.
Organization comes from the verified scope (`curriculum.manage`). Contracts in `@hon/contracts` `rank-setup.ts` with closed verifiers.
Requirements, ENROLL and SET_RANK go through the existing `organizations/:org/schools/:school/curricula/:id/...` routes.

## 5. Pages

- `/staff/curriculum/ranks` **Rank setup**: program list on the left (name, belts, students), detail on the right (belts as
  colored cards with up/down, edit, "What this belt needs" list and add form; "Students in this program" with change-belt
  select and "Add a student" picker + starting belt). Links: "Choose what families see" -> `/staff/parent-app/curriculum`,
  "Track a student's progress" -> `/staff/curriculum/progress`.
- **Curriculum progress**: pick a student, see their program and belt and each requirement with plain status buttons
  (Not started, Practicing, Shown in class, Met, Not yet). Optional private note. Empty state points to Rank setup.
- **Curriculum library** ("Videos and links"): add a video or link to a program or belt, for staff or families; list with
  Edit and Remove. Keeps the server rules; the UI states them in one plain line ("Use a full https:// web address").
- **Teaching studio** and **Achievements**: same features, dark look, plain wording (no version numbers, no record-ID boxes in
  the school shell, category and age labels in words).
- Menu group `ranks` lists: Rank setup, Curriculum progress, Videos and links, Teaching studio, Achievements.

## 6. Delivery

- PR A: migration 0622 + API + contracts + Rank setup page + menu. Needs the coordinator's merge slot (after 0621).
- PR B: plain dark rewrite of the four pages (frontend only). Merges on independent review GO + green CI.

## 7. Tests

- DB proof `test-rank-setup-integrity.mjs`: create/rename program, add/edit/move belts, receipts replay and key reuse, version
  conflicts, name clashes, color validation, cross-school isolation, missing permission, lapsed entitlement, students hidden
  without `curriculum.progress.record`, audit rows.
- API unit tests for input validation and error mapping; contract verifier tests; web UI tests for Rank setup and each rewritten page.
