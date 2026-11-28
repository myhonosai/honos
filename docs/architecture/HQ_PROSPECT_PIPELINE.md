# HQ prospects pipeline board (migration 0715)

Owner ask (David, 2026-11-28): "Prospect tab in HQ should copy pipeline like school CRM. HQ has stages too: Lead, active
school, inactive school." HQ's audience is schools (clients), not students.

## What the person sees

`/hq/growth/prospects` becomes a pipeline board like the school Leads board (`/staff/crm`), with a Board / List toggle
(List = the existing prospects list, unchanged).

Columns, left to right:

| Column | What is in it | Who decides |
|---|---|---|
| **Lead** (default) | HON prospects (hq_prospects) not yet worked | HQ, by drag |
| **Contacted** (default) | prospects HQ has reached | HQ, by drag |
| **Demo booked** (default) | prospects with a demo set | HQ, by drag |
| *(more HQ stages)* | HQ adds, renames, colours, hides and drag-reorders prospect stages in **Edit pipeline**, like the school board (max 12) | HQ |
| **Active school** (fixed) | real customer schools whose status is ACTIVE (trial schools show a "Trial" tag) | automatic, from the school's real status |
| **Inactive school** (fixed) | real schools that are SUSPENDED (paused) or ARCHIVED (removed, within 30 days) | automatic |

Below the board, like the school board's Won / Lost: two drop zones for prospects:
- **Became a school**: closes the prospect as WON (the school itself then shows in Active school).
- **Not interested**: closes the prospect as LOST.
Both are the existing archive, plus a recorded outcome. Re-opening a closed prospect puts it back in the first stage.

Top: stat cards (Open prospects, Active schools, Inactive schools, Won rate), search (name, school, email, phone),
source filter, sort (Newest, Oldest, Name), Add prospect (existing form).

Prospect card: initials, name, school name, source, Call / Text / Email quick links (tel:/sms:/mailto:, HON sends
nothing, Text hidden when the prospect opted out of texts). Click opens the prospect page.
School card: school name, plan tier, Trial tag, since date. Click opens the HQ school page. **School cards cannot be
dragged**: pausing, archiving or restoring a school stays on the school page with its confirmations, and a prospect can
never be dragged into Active / Inactive school (a school becomes active only by really signing up or being created by HQ).

## Data (0715)

- `hon.hq_prospect_stages` (id, name 1-40, color from the school board palette, position, hidden, created_at,
  version) under one board version row `hon.hq_prospect_pipeline` (singleton, version) for optimistic save.
  Seeded: Lead, Contacted, Demo booked. Forced RLS, no direct grants, nothing deleted (hidden instead).
- `hon.hq_prospects` gains `stage_id` (FK, backfilled to Lead for ACTIVE prospects) and `closed_outcome`
  (WON / LOST, set only while ARCHIVED). The 0283 guard still applies (version bump, origin fields fixed).
- Functions (SECURITY DEFINER, `hon.require_hq_marketing_actor`, same as prospects):
  - `hon.read_hq_prospect_board(subject)`: stages + open prospects (with textOptedOut) + closed counts + schools
    (id, display name, status, tier, trial flag, created) — names and status only, no school data.
  - `hon.move_hq_prospect_stage(subject, key, prospectId, {stageId | outcome, expectedVersion})`: idempotent, audited.
  - `hon.save_hq_prospect_stages(subject, key, {expectedVersion, stages[], moves[]})`: same rules as school
    `save_crm_pipeline_stages` (a hidden stage holding prospects needs a move target; at least one visible stage).
- New prospects (sign-up, HQ add, import, inbound text) land in the first visible stage.

## API

- `GET /api/v1/hq/prospects/board`
- `POST /api/v1/hq/prospects/:id/stage` (command `hq.prospect.stage.move`)
- `POST /api/v1/hq/prospects/stages` (command `hq.prospect.stages.save`)
Permission: HQ owner or hq.marketing.manage (same as the prospects list). Idempotency-Key + X-HON-Human-Command.

## Blasts audience (for the HQ blasts thread, 0712)

Audience choices that come from this board: **Prospects in stage(s)** (stage ids from the board read; marketing
consent per channel from hq_prospect_consents still required, SMS needs HQ A2P marketing), **Active schools**, **Inactive
schools** (school owners through the existing HQ owner message path). This PR does not send anything.

## Not in this slice

Automatic stage moves (e.g. on demo booked), deal values, multiple HQ pipelines, linking a prospect record to the school
it became.

## Tests

DB proof (stages save/move/guards, RLS, idempotency, permission refusals, schools columns read-only), contracts unit
tests, web model tests (columns, filters, drag targets: no drop on school columns), browser check (drag a prospect,
edit pipeline, phone width).
