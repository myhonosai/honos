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
  read). Returns `{ programs: [{ id, name, version, ranks: [{ id, name, color, order, version, classes, days, students,
  requirements: [{ id, code, kind, label, description, required, version }] }] }], students: [...] | null }`.
  `students` (active enrollments of active students: enrollment id, program id, student id, given/family name, current belt id,
  enrollment version) is returned only when the actor also holds `curriculum.progress.record`, else `null`. Programs not ARCHIVED,
  capped at 100; belts capped at 60 per program; students capped at 1000.
- `hon.mutate_rank_setup(p_subject, p_operation, p_curriculum, p_target, p_input, p_key, p_request, p_correlation)`, closed operations:
  - `PROGRAM_CREATE` `{name}`: `p_curriculum` and `p_target` null; new curriculum `model_code='LINEAR'`, `lifecycle='PUBLISHED'`.
  - `PROGRAM_RENAME` `{name, expectedVersion}`.
  - `PROGRAM_SETUP` `{name, ranks: [{name, color, classes, days}]}` (quick setup, owner direction 2026-11-22): 1 to 60 belts
    in order, each a closed object, names unique within the list; the program and all its belts are one command, one receipt
    and one audit row, so a failed save leaves nothing behind.
  - `RANK_ADD` `{name, color, classes, days}`: appended after the last belt.
  - `RANK_UPDATE` `{name, color, classes, days, expectedVersion}` on `p_target`.
  - `RANK_REMOVE` `{expectedVersion}` on `p_target`: only a belt nothing depends on. A belt with any requirement (0070 keeps
    requirement history for good) or any row pointing at it (students, promotions, tests) is refused `RANK_IN_USE` (409) and
    nothing changes; otherwise the belt is deleted and later belts move up one place (their versions bump).
  - `RANK_MOVE` `{direction: 'UP'|'DOWN', expectedVersion}` on `p_target`: swaps order with its neighbour; both belts' versions bump.
  Names: 1 to 120 characters, trimmed, no control characters or `<>`, unique per school (programs) or per program (belts), case-insensitive.
  Color: `#RRGGBB` or null. Lock order: 0132 `lock_curriculum_resource_actor` (organization, school, actor, grants, roles,
  permissions, entitlement), receipt lookup, curriculum `FOR UPDATE`, its belts by id `FOR UPDATE`, then the actor is re-checked.
  Receipts reuse `hon.curriculum_command_requests` (0070, keyed by principal and idempotency key). Each command writes an
  `hon.audit_events` row (`curriculum.rank_setup.<op>`). Returns the program's projection.
- `classes` (0 to 2000) and `days` (0 to 3650) are "classes before the next belt" and "days at this belt". Private helper
  `hon.rank_setup_rules` stores them as the exact 0116 `promotionReadinessV1` policy (`minAttendanceCreditMilli = classes * 1000`,
  `minDaysInCurrentRank = days`), so Tests > Who is ready works for belts made here. Requirement, recommendation and document
  lists and the testing-window flag already on a policy are kept. Both zero with nothing else on the policy stores `{}` (no
  rule), because 0116 treats an all-empty policy as a configuration error.
- Requirements and student placement keep using `hon.mutate_curriculum_progress` (REQUIREMENT_CREATE/UPDATE, ENROLL, SET_RANK),
  which already carries history, audit, outbox and the deferred evidence trigger.

## 4. API

`staff/schools/:schoolId/rank-setup` (identity guard + human-UI guard with command `rank-setup`, no query selectors):
`GET` read; `POST programs`; `POST programs/:curriculumId/versions` (rename); `POST programs/:curriculumId/ranks`;
`POST programs/:curriculumId/ranks/:rankId/versions` (edit); `POST programs/:curriculumId/ranks/:rankId/move`;
`POST quick-setup` (PROGRAM_SETUP); `POST programs/:curriculumId/ranks/:rankId/remove` (RANK_REMOVE).
Organization comes from the verified scope (`curriculum.manage`). Contracts in `@hon/contracts` `rank-setup.ts` with closed verifiers.
Requirements, ENROLL and SET_RANK go through the existing `organizations/:org/schools/:school/curricula/:id/...` routes.

## 5. Pages

- `/staff/curriculum/ranks` **Rank setup**: program list on the left (name, belts, students), detail on the right (belts as
  colored cards with up/down, edit, "What this belt needs" list and add form; "Students in this program" with change-belt
  select and "Add a student" picker + starting belt). Links: "Choose what families see" -> `/staff/parent-app/curriculum`,
  "Track a student's progress" -> `/staff/curriculum/progress`.
  Each belt shows and edits its classes and days, and can be removed from its edit form after a second confirming press.

### 5a. Quick setup (owner direction 2026-11-22: belt-based first, other arts supported, guided, editable after)

Shown first when a school has no program, and behind "Quick setup for a new program" afterwards. Three steps on one panel:

1. **What do you teach?** Built-in starting points in `rank-setup/templates.ts`: Taekwondo (first, belt-based default), Karate,
   Brazilian Jiu-Jitsu adults and kids, Judo, Kung Fu (sashes), Krav Maga, "Levels, no belts" (Muay Thai, kickboxing, MMA,
   fitness) and "Something else".
2. **A few questions**: program name, stripes on each belt (0 to 4), black belt degrees (one black belt, or 1st to Nth degree),
   classes before the next belt, days at each belt.
3. **Check the list**: every belt can be renamed, recolored, given its own classes and days, moved, removed, or added to.
   Nothing is saved until "Create"; that sends one `PROGRAM_SETUP` command. Everything stays editable afterwards.

The starting points are fixed lists in the page: no AI provider is called and nothing leaves the browser until Create.
Generating a chart from a free-text description with a real AI model (as the owner's earlier CRM does) is a separate owner
decision, because it uses a paid provider. Not in this change: a test fee per belt, two-color belt swatches, drag to reorder.

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

- DB proof `test-rank-setup-integrity.mjs`: create/rename program, quick setup (stored 0116 policy, replay, refusals), remove
  belt (order closes up, in-use refusal keeps everything), add/edit/move belts, receipts replay and key reuse, version
  conflicts, name clashes, color validation, cross-school isolation, missing permission, lapsed entitlement, students hidden
  without `curriculum.progress.record`, audit rows.
- API unit tests for input validation and error mapping; contract verifier tests; web UI tests for Rank setup and each rewritten page.
