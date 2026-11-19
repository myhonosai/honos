# Parent app curriculum (spec)

Owner ask (David, 2026-11-19): "curriculum section to share their curriculum video or reference ... mainly rank based
or cycle based. If rank based, as rank changes, I need app to know and change what is shown. Cycle based, staff let app
know which cycle and cycle material is set either video or documents. And it would cycle through or pick by staff.
This means HON OS needs a section for app control."

Status: PCA-1 (0587) built on branch claude/project-thread-05np7o; PCA-2..4 not built yet. Migrations (coordinator, 2026-11-19): 0587 cycles + settings, 0578 parent read v2.

## 1. What already exists on main (cd2c33d)

| Piece | Where | State |
| --- | --- | --- |
| Curricula with a model code (`LINEAR`, `ROTATIONAL`, `HYBRID`, ...) | 0030 `hon.curricula` | verified |
| Ranks in order per curriculum | 0030 `hon.curriculum_ranks` | verified |
| Student enrollment with `current_rank_id`, staff `SET_RANK` | 0030/0070 `hon.student_curriculum_enrollments`, `POST .../enrollments/:id/current-rank` | verified |
| Material references (`VIDEO`/`LINK`, HTTPS URL, curriculum + optional rank, `STAFF`/`PARENT` audience, archive only) | 0132 `hon.curriculum_resources`, `/staff/curriculum/library` | verified |
| Parent read of material for the current rank | 0132 `hon.read_parent_curriculum_library`, `GET /v1/parent/curriculum-library` | verified, but uses the 0087 single-scope path and filters rank only |
| App list of that material | `apps/parent-mobile/src/more/MoreScreen.tsx` | verified (flat list, opens URL) |
| Kai teaching curricula picker | 0213 `hon.list_teaching_assistant_curricula` | verified, staff only, unrelated to parents |
| Promotion decisions | 0030/0116/0099 | a `PROMOTED` decision does **not** change `current_rank_id`; staff set the rank separately |

So rank-based material already follows the student's rank the next time the app reads. What is missing is the cycle
system, documents, a per-curriculum choice of how the app shows material, and one staff page that controls all of it.

## 2. Goals

- G1 Each curriculum is shown in the parent app as **rank-based** or **cycle-based**, chosen by staff.
- G2 Rank-based: the child sees the material for their current rank. When staff change the rank, the next app read
  shows the new rank's material with no extra step. Staff can also choose to show earlier ranks (review) and a preview
  of the next rank.
- G3 Cycle-based: staff keep an ordered list of cycles (for example "Cycle 1: Stances", "Cycle 2: Kicks"). Each cycle
  has videos and documents. The current cycle is either **rotated automatically** on a schedule or **picked by staff**.
- G4 Material kinds: `VIDEO`, `DOCUMENT`, `LINK`. v1 stores HTTPS links (YouTube or Vimeo unlisted, Google Drive,
  Dropbox, the school's site). File upload is a later piece (section 9).
- G5 One staff section, **Parent app > Curriculum**, where staff set the mode, manage ranks' or cycles' material, set
  the rotation, switch the cycle now, and preview what a family sees.
- G6 A **Curriculum** screen in the HON Parent app: per child, the current rank or cycle, its material, and what comes
  next.

Non-goals for v1: push notifications on cycle change, watch tracking or "mark as practiced", file storage, AI-made
material, changing how promotions set ranks.

## 3. Concepts

**Display mode** (per curriculum, new table `hon.curriculum_app_settings`):

| Field | Values | Default |
| --- | --- | --- |
| `display_mode` | `RANK`, `CYCLE` | `CYCLE` when `model_code='ROTATIONAL'`, else `RANK` |
| `show_in_app` | boolean | `true` (staff can hide a curriculum from the app) |
| `rank_show_earlier` | boolean | `false` |
| `rank_show_next` | boolean | `false` |
| `cycle_rotation` | `AUTO`, `STAFF_PICK` | `STAFF_PICK` |
| `cycle_anchor_date` | date (school local) | null; required for `AUTO` |
| `cycle_length_weeks` | 1..26 | null; required for `AUTO` |
| `cycle_current_id` | cycle id | null; required for `STAFF_PICK` once cycles exist |
| `cycle_show_next` | boolean | `true` |
| `version` | optimistic lock | 1 |

A curriculum with no settings row behaves as today (shown; rank material) so existing parents see no change. The staff
read shows the defaults with `saved: false, version: 0`; the first save creates the row (expected version 0).

**Cycle** (new table `hon.curriculum_cycles`): `id`, curriculum, `name` (1..80), `position` (1..), `status`
(`ACTIVE`/`ARCHIVED`), `version`. Positions are unique among active cycles and are reordered by one command.

**Material** stays in `hon.curriculum_resources`, extended:

- `kind` gains `DOCUMENT`.
- new nullable `cycle_id`; a row has at most one of `rank_id` / `cycle_id`. Null both = "whole curriculum" (shown in
  every rank or cycle, as today).
- Identity stays immutable (0132 rule): kind, URL, rank and cycle never change; staff archive and add again.

## 4. Which cycle is current

Computed in the database, in the school's `timezone`, never in the client.

- `STAFF_PICK`: `cycle_current_id`. Staff switch it with a command; it stays until changed.
- `AUTO`: active cycles in `position` order, `n` of them. `today` = school local date.
  `k = floor((today - anchor_date) / (7 * cycle_length_weeks))`; if `today < anchor_date` the first cycle is "starts
  on anchor_date" and nothing is current yet (parents see "Starts Mon, Jan 5"). Else current = cycle at index
  `k mod n`, running `anchor + k*len*7` to `anchor + (k+1)*len*7 - 1`. Next = index `(k+1) mod n`.
- **Switch now** while in `AUTO`: staff pick a cycle; the command rewrites `anchor_date` so the picked cycle starts
  today and the rotation continues from it. One audited write, no hidden override state.
- Adding, archiving or reordering cycles in `AUTO` changes the rotation from today on; the staff page shows the new
  current and next cycle before saving (preview read) so there are no surprises.
- Zero active cycles: the curriculum shows "No cycle set yet" to parents (only whole-curriculum material).

## 5. What a parent sees

New read `hon.read_parent_curriculum_app(subject)` (follows the 0471/0473 family choice through
`hon.resolve_parent_journey_scopes`; same lock-then-recheck and entitlement rule as 0132). Old read stays for the web.

Per child, per active enrollment in a curriculum with `show_in_app` (or no settings row):

```
{ childDisplayName, curriculumName, mode: 'RANK'|'CYCLE',
  rank?:  { name, color },                       // RANK
  cycle?: { name, startsOn, endsOn|null, rotation: 'AUTO'|'STAFF_PICK' }, // CYCLE, null when none current
  next?:  { name, startsOn|null },               // next rank (if rank_show_next) or next cycle (if cycle_show_next)
  sections: [ { label: 'Current'|'Review'|'Next'|'All year', items: [ { title, description, kind, url } ] } ] }
```

- Only `ACTIVE`, `PARENT` material. Rank-based "Review" = ranks with lower `progression_order` when
  `rank_show_earlier`. "Next" holds next-rank or next-cycle material only when the matching show-next flag is on.
- Whitelist only: no ids, staff names, audit or progress data. Max 200 items per child.
- `Cache-Control: private, no-store`. The app reads on open and on pull-to-refresh, so a rank change or a new cycle
  shows the next time the screen opens. No push in v1.

## 6. Staff section: Parent app > Curriculum

Route `/staff/parent-app/curriculum`, added to the existing `parentApp` nav group next to the parent messages page.
Permission `curriculum.manage` (same as the library). Layout:

1. **Curriculum list** (left): each curriculum with its mode chip (Rank-based / Cycle-based), shown or hidden, count of
   parent materials.
2. **Setup** (top of the right pane): "How does this curriculum work?" Rank-based / Cycle-based; "Show in the parent
   app" switch.
3. Rank-based body: one row per rank in order, its parent materials (add video, document or link; edit title and
   description; archive), plus "Whole curriculum" materials. Switches: "Also show earlier ranks for review", "Also show
   a preview of the next rank".
4. Cycle-based body: cycle list (add, rename, drag or up/down to reorder, archive) with each cycle's materials.
   **Rotation** card: "Rotate automatically" (start date, weeks per cycle) or "Staff pick". A banner: "Now: Cycle 3:
   Kicks, through Sun Dec 14. Next: Cycle 4: Forms." with **Switch to...** (pick a cycle, confirm).
5. **Preview** drawer: "What families see" for a chosen enrolled student (staff read, same shape as section 5).

Rank changes are not made here; they stay in Ranks > Progress (`SET_RANK`). The page links there.

## 7. API

Staff (HonIdentityGuard + CurriculumHumanUiGuard, idempotency key on writes, `expectedVersion` on updates):

- `GET  /v1/staff/schools/:schoolId/parent-app/curriculum` - curricula, settings, ranks, cycles, materials, computed
  current/next cycle.
- `POST .../curricula/:curriculumId/app-settings` - create or update settings (mode, flags, rotation fields).
- `POST .../curricula/:curriculumId/cycles` - add cycle. `POST .../cycles/:cycleId/versions` - rename.
  `POST .../cycles/:cycleId/archive`. `POST .../curricula/:curriculumId/cycle-order` - full ordered id list.
- `POST .../curricula/:curriculumId/current-cycle` - switch now (both rotation modes).
- Materials keep the 0132 routes; create accepts `kind: 'DOCUMENT'` and `cycleId`.
- `GET  .../parent-app/curriculum/preview/:studentId` - staff preview.

Parent: `GET /v1/parent/curriculum-app` (cookie or mobile bearer, read-only guard like the library).

Contracts in `packages/contracts/src/parent-app-curriculum.ts` with strict verifiers used by web and app.

## 8. Security and integrity

- All new tables: forced RLS, no policies, no runtime table grants; definer functions only (0132 pattern).
- Staff commands: lock order of 0070/0132, authority recheck after locks, scoped idempotency receipts, versioned
  snapshots, audit events, cycle/rank must belong to the same curriculum and school.
- Parent read: family choice aware, current active child + enrollment only, entitlement checked after locks.
- URLs: 0132 `valid_curriculum_resource_url` (HTTPS, public DNS name, no private hosts). The app opens links in the
  system browser; no embedding of third-party players in v1.
- No external I/O, no AI, no paid service. Test data only.

## 9. Later pieces (not v1)

- File upload for documents and short videos (needs storage choice; Supabase Storage is on the Pro plan but nothing in
  the codebase uses it yet, so it needs its own spec and owner OK on storage cost).
- Push notice "New cycle started" and "New rank material" through the app's notification work.
- Applying a `PROMOTED` decision to `current_rank_id` automatically (today staff set the rank separately).
- Practice tracking.

## 10. Build plan (small PRs)

1. **PCA-1 database + staff API** (migration 0587): settings table, cycles table, resource `cycle_id` + `DOCUMENT`, staff
   read and commands, current-cycle function, DB proofs.
2. **PCA-2 parent read** (migration 0578): `read_parent_curriculum_app`, staff preview, parent route, contracts, proofs.
3. **PCA-3 staff page** `/staff/parent-app/curriculum` (web), browser screenshots at 1440 and 390.
4. **PCA-4 app screen** in `apps/parent-mobile`: Curriculum screen replacing the More list, sample data, tests.

## 11. Tests (each PR test-first)

- Current cycle math: before anchor, first day, last day of a cycle, wrap-around, one cycle, school timezone edge at
  local midnight, switch-now rewrites anchor, reorder/archive changes rotation.
- Rank mode: rank change moves material; earlier/next flags; whole-curriculum material; unranked enrollment.
- Isolation: other school, other family, staff-only, archived, hidden curriculum, family picker choice.
- Commands: idempotent replay, key reuse conflict, version conflict, cross-curriculum cycle/rank refused, revoked
  permission after lock.

## 12. PCA-1 as built (0587)

- Tables `hon.curriculum_cycles`, `hon.curriculum_app_settings`, `hon.curriculum_app_events` (immutable history),
  `hon.curriculum_app_requests` (scoped receipts); forced RLS, no policies, no runtime grants.
- `hon.curriculum_resources` gains `cycle_id` (FK to an active-or-archived cycle of the same curriculum, at most one of
  rank/cycle) and the `DOCUMENT` kind. The 0132 parent read now leaves cycle material and documents to the 0578 read.
- Entry points (runtime EXECUTE only): `hon.read_staff_parent_app_curriculum(text)` and
  `hon.mutate_parent_app_curriculum(subject, op, curriculum, target, input, key, request, correlation)` with ops
  `SAVE_SETTINGS`, `CYCLE_CREATE`, `CYCLE_RENAME`, `CYCLE_ARCHIVE`, `CYCLE_ORDER`, `SWITCH_CYCLE`.
- Routes under `/v1/staff/schools/:schoolId/parent-app/curriculum` (human command `parent-app-curriculum`):
  `GET`, `POST :curriculumId/settings`, `POST :curriculumId/cycles`, `POST :curriculumId/cycles/:cycleId/versions`,
  `POST .../archive`, `POST .../switch`, `POST :curriculumId/cycle-order`. Materials keep the library routes, which now
  accept `kind: DOCUMENT` and an optional `cycleId`.
- Rules decided while building: the staff-picked current cycle cannot be archived (`CYCLE_IS_CURRENT`); switching
  needs saved settings (`SETTINGS_REQUIRED`); leaving AUTO keeps the cycle families see today; a first STAFF_PICK save
  or the first cycle added under STAFF_PICK becomes current; reorder takes the exact list of active cycles; active positions stay 1..n (archive renumbers, review P3).
- Proof: `packages/database/scripts/test-parent-app-curriculum-integrity.mjs` (142 checks over signed HTTP).
