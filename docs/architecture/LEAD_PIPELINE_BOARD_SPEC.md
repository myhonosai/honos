# Lead pipeline board (0400)

Owner request (David, 2026-11-16 05:54Z): "These 3 can be on one page. Use pipeline format like this." The three pages are
Leads (`/staff/crm`), Enroll a lead (`/staff/crm/leads`) and Enrollment journey (`/staff/crm/journey`). The reference is the
lead section of his Manus CRM, adapted rather than copied. Migration number 0400 was allocated by the coordinator.

## What exists today (verified on main dc8408a)

- `hon.crm_pipelines` and `hon.crm_pipeline_stages` (0002). Stages have `name`, `position` (unique per pipeline) and an optional
  `terminal_status` (WON/LOST/ARCHIVED). Every lead has `pipeline_id` and `pipeline_stage_id`. A new school gets the starter
  pipeline (New lead, Trial booked, Enrolled=WON, Not now=LOST) when it adds its first lead.
- Lead intake picks a stage: human create, CSV import (0067), public forms (0075), Zernio (0250), websites (0361), inbox (0364).
- Close a lead (WON/LOST) is `hon.close_crm_lead` (0145), human only, with an expected version. It does not change the stage.
- There is no command to move a lead between stages and no command to rename, reorder, add or hide stages.
- The lead list API returns 50 leads a page with no program, source or trial date.

## Goal

One Leads page, a pipeline board, that replaces the three menu entries.

### Page
1. Header: "Leads", a one-line summary (open count and win rate).
2. Four number cards: Open, Won, Lost, Win rate (won / (won + lost), "–" when both are zero). Clicking Open shows the board;
   Won, Lost or Win rate switch to the list view filtered to those leads.
3. Toolbar: search (name, email, phone), program filter (the program interest values present), status (Open, Won, Lost,
   Won + Lost), sort (newest, oldest, name), board/list toggle, Edit pipeline, Add lead.
4. Board: one column per visible non-terminal stage in position order, with its colour dot, name and count. Cards show
   initials, name, program, and the next trial date (else the last trial date, else the source). No dollar value: HON has no
   lead value, and Manus shows $0 on every card.
5. Won and Lost drop zones under the board. Dropping a card there opens the existing close confirmation (with its optional
   note). Nothing is closed without that confirmation.
6. Drag and drop between stage columns moves the lead. Every card also has a "Move to" menu, so keyboard and touch users can
   do the same thing without dragging.
7. List view: one row per lead with name, program, stage, status, source, added date.
8. Clicking a card opens a side panel: contact details, stage picker, trials, and the next steps that exist today (enrollment
   steps for this lead, follow-ups, lead memberships, mark won/lost). When the contact card (#384) is on main, the panel also
   links to it.
9. Edit pipeline: rename, recolour (fixed palette), reorder (up/down), add, hide. Won and Lost stay fixed. Hiding a stage that
   still has open leads requires choosing the stage they move to. A hidden stage that later receives a lead from intake shows
   as a column again, marked hidden, so no lead is ever invisible.
10. Add lead reuses the existing add-lead form and starter pipeline setup.

### Menu
The Leads group keeps "Leads" and drops "Enroll a lead" and "Enrollment journey". Those routes keep working as deep links from
the side panel until enrolling moves onto the contact card ("Move membership actions onto the contact card" thread).

## Backend (migration 0400)

- `crm_pipeline_stages`: add `color` (one of BLUE, SKY, CYAN, VIOLET, GREEN, RED, AMBER, SLATE; default BLUE) and `hidden_at`.
- Permission `crm.lead.stage.move` (staff assignable, not sensitive), granted to OWNER and to every role that already holds
  `crm.lead.create`. Editing stages uses the existing `crm.pipeline.manage`.
- `hon.read_crm_pipeline_board(subject, pipeline uuid|null, status text)`: definer read, re-proves the human subject and
  `crm.lead.read`. Returns the pipelines (id, name, version), the chosen pipeline's stages (id, name, position, color, hidden,
  terminal status, open count), school-wide totals (open, won, lost), and up to 500 leads of the chosen status with id,
  version, status, stage, name, email, phone, program, source, created/won/lost dates, next and last trial start, plus
  `truncated`.
- `hon.move_crm_lead_stage(subject, lead, {stageId, expectedVersion}, key, request, correlation)`: definer command, human UI
  only, `crm.lead.stage.move`. The lead must be OPEN at the expected version; the target must be a non-terminal, non-hidden
  stage of the same pipeline and differ from the current stage. Bumps the lead version, writes audit + outbox
  (`crm.lead.stage_moved`) and an immutable idempotency receipt.
- `hon.save_crm_pipeline_stages(subject, pipeline, {expectedVersion, stages[], moves[]}, key, request, correlation)`: definer
  command, human UI only, `crm.pipeline.manage`. `stages` lists every non-terminal stage in the new order (existing by id,
  new without id) with name (1-60 chars, unique case-insensitively), colour and hidden flag; at least one stays visible; at
  most 20. Terminal stages keep their names and stay last. `moves` maps each newly hidden stage that has open leads to a
  visible target; those leads move in the same transaction (each with a version bump and audit). Bumps the pipeline version;
  audit + outbox `crm.pipeline.stages_saved`; immutable receipt.
- A trigger guards `crm_leads.pipeline_stage_id`: a change after insert is allowed only inside the two definer functions.
- `PipelineService.list` hides hidden stages from the add-lead stage picker, and lead create refuses a hidden stage.
- API: `GET .../crm/pipeline-board?pipelineId&status`, `POST .../crm/leads/:leadId/stage`,
  `POST .../crm/pipelines/:pipelineId/stages` (Idempotency-Key required on commands).

## Not in this change
- Automatic moves when a trial is booked, attended or missed (a later slice).
- Lead value / open value, automations and no-show tabs from Manus.
- Any change to enrollment, membership, payments or AI.

## Tests
- DB proof `test-lead-pipeline-board-integrity.mjs`: permission denials, cross-school, version conflict, terminal/hidden
  target refused, idempotent replay and key reuse, hide-with-move atomicity, guard trigger refuses a direct stage update.
- API unit tests for the controller/service validation and error mapping.
- Web unit tests for the pure model (grouping, filters, sort, stats, win rate) and the page (board, list, move menu, drop to
  close, edit pipeline, panel), in EN/KO/ES.
