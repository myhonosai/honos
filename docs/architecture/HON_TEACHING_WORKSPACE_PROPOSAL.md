# Dedicated Teaching & Curriculum AI ("Kai") — UI proposal and capability-dependency matrix

**Status:** Proposal only. Nothing below is built except the small display entry noted under "What PR #73 contains". Not deployed.
**Owner decision (2026-10-24):** Teaching support is a separate instructional AI, tentatively named **Kai**. It is not assigned to Jordan or Claire, and the seven school-management employees stay unchanged. The name is provisional and should later support authorized school-level display customization.
**Ownership:** Codex owns Teaching AI authorization, the agent catalog change, instructional data access, framework synchronization and backend execution contracts. Claude owns the school-facing frontend once those contracts exist.

## What PR #73 contains (display only)

- `HON_TEACHING_AI` in `apps/web/src/components/hon-command/roster.ts`: a frontend display constant with the provisional name, role, boundary sentence and links to five existing teaching pages. It is **not** added to the protected `HON_AI_TEAM` catalog. It has no portrait (a neutral "K" monogram is drawn in CSS), no permission, no tool grant and no record key.
- A separate "Separate instructional AI · not part of the management team" card under the seven in the HON **AI team** tab, labeled "Planned · not yet available" and "(provisional name)".
- HON's workspace body (management team, suggestions, AI work, approvals, Kai card) now renders **only** after the server verifies a school-management scope. That is the dashboard's operations-report check, or the current-school resolver, which requires `reporting.view`. A teaching-only instructor who opens "Ask HON" sees only a short notice and no management agents, work or approvals.
- Legacy `claire`-keyed teaching drafts stay labeled "Teaching draft assistant (legacy)". They are never shown as Kai's work.
- No contract, permission, catalog, schema or migration change.

## Proposed Teaching Workspace (separate PR, after contracts T1–T3)

**Route:** `/staff/teaching` (proposed), session-gated and no-index. It is reachable without HON's management workspace and is never linked for users without Teaching AI access.

**Who sees it:** the school owner, and staff individually granted Teaching AI access by the server (contract T1). The page never infers access from role names, the selected school, the visual mode or URL values.

**Layout** (shared component layer, rendered in Modern, Big-Button and Classic like the HON workspace):

1. **Header:** the school's Kai display name (T1, falling back to "Kai"), the role "Teaching & Curriculum AI", and an availability badge taken from the server.
2. **Today's classes:** the instructor's scheduled sessions for today and this week, each with "Plan this class" and "What was taught" entry points.
3. **Ask Kai** (composer): enabled only when T4 reports a connected route. Otherwise it is shown disabled with the label "Not connected". Every answer that would change a record becomes a draft for the instructor to save, never an automatic write.
4. **School Teaching Framework** (tabs): Programs & levels · Curriculum & rank objectives · Rotations (weekly/monthly) · Class plans · Assigned instructors · What was taught · Items to revisit.
5. **Lesson plans:** the existing Teaching Studio lessons, plus Kai drafts (T5) awaiting the instructor's save.
6. **Instructional observations:** the existing Teaching Studio assessments (private, per student). Kai may suggest wording for an observation, but an instructor always records it.
7. **My Kai work:** Kai draft history under its own record key (T5). Legacy teaching drafts appear in a separate "Earlier teaching drafts (legacy)" list.
8. **Fixed boundary notice:** "Kai never marks proficiency, promotions, testing results or curriculum completion."

**Teaching-only experience:**
- No HON launcher, no management roster, and no marketing, CRM, billing, financial, approvals or other AI work.
- The staff navigation for a teaching-only user needs its own server-filtered menu, which is contract T1.
- Until T1 exists, the frontend cannot reliably tell a teaching-only user apart, so the workspace must not ship before T1.

**Premium design direction:**
- A calm, instructor-first canvas: class cards with the time, program and level up front.
- Large touch targets for mat-side tablet use in Big-Button mode.
- A dense list in Classic mode.
- One accent colour reserved for Kai. No invented portrait until an approved asset exists, so the "K" monogram stays meanwhile.

## Capability-dependency matrix

| # | Capability | Existing contract today | State today | Needs (owner: Codex unless noted) |
| --- | --- | --- | --- | --- |
| 1 | Teaching AI identity and entry point | `HON_TEACHING_AI` display constant (this PR) | **Partially working** (display only, inside verified HON) | T1 catalog entry and server access; approved portrait (owner) |
| 2 | Access for owners and individually authorized instructors only | None for Teaching AI. Teaching Studio has `teaching.studio.read`, `teaching.lesson.manage`, `teaching.resource.manage`, `teaching.assessment.record` and `GET /v1/staff/teaching-studio/access`. The legacy assistant has `teaching.assistant.use` | **Backend required** | T1 separate Teaching AI grant, not implied by management roles or `reporting.view` |
| 3 | Hide management agents and data from teaching-only users | Server-verified management scope gates the HON body (this PR) | **Working** for HON surfaces | T1 server-filtered navigation for the rest of `/staff` |
| 4 | Teaching Studio lesson plans and resources | `GET/POST /v1/staff/teaching-studio/lessons`, `…/resources` (human-authored only) | **Working** (human workflow) | T6 Kai read access to them via T1 scope |
| 5 | Instructional observations | `…/teaching-studio/students/:student/assessments` (private, not grades) | **Working** (human workflow) | T6 read access; Kai never records |
| 6 | Curriculum Library | `GET /v1/staff/schools/:schoolId/curriculum-library` | **Working** (human workflow) | T6 read access |
| 7 | Curriculum Progress and rank objectives | `/v1/organizations/:org/schools/:school/curricula/:id/ranks/:rank/requirements`, `…/enrollments/:id` | **Working** (human workflow) | T6 read-only for Kai. Kai must never write progress, rank or completion |
| 8 | Scheduled classes | `GET /v1/organizations/:org/schools/:school/schedule/sessions` | **Working** (human workflow) | T2 "my classes" read for the signed-in instructor (assigned instructor filter) |
| 9 | School Teaching Framework (programs/levels, rotations, class plans, assigned instructors, what was taught, items to revisit) | Partial: curricula, ranks and sessions exist. **No** rotation, class-plan-to-session link, taught-log or revisit records | **Backend required** | T3 framework records and sync, with history and audit |
| 10 | Ask Kai conversation | None | **Backend required** | T4 Teaching AI conversation contract (school + requester scoped, Action Engine `CONFIRM` for any write) |
| 11 | Kai lesson-plan and observation drafts | Legacy `POST /v1/staff/teaching-assistant` writes drafts under the `claire` key | **Partially working** (legacy only) | T5 new record key for Kai; legacy key and records preserved untouched |
| 12 | Kai work history | `GET /v1/staff/teaching-assistant/mine` (legacy `claire` records) | **Partially working** (legacy, shown as legacy) | T5 history under the Kai key; legacy list stays separate |
| 13 | School-level display name customization | None | **Backend required** | T1 authorized, audited display-name setting |
| 14 | Never marks proficiency, promotion, testing or completion | Teaching Studio contract already forbids these words and side effects; Action Engine `CONFIRM` | **Working** for existing paths | T4–T6 must keep these as closed non-capabilities, enforced server-side and proven in tests |

## Exact backend contracts requested from Codex

- **T1 — Teaching AI access and identity.** `GET /v1/staff/teaching-ai/access` reports, for the signed-in human only:
  - the verified school
  - `teachingAiEnabled`
  - the per-capability booleans
  - the school's display name for Kai (default "Kai")
  - `managementAccess: boolean`, so the frontend can hide the HON launcher and management navigation without guessing
  It needs a new staff-assignable grant that is independent of management roles, plus a catalog entry separate from the seven management agents.
- **T2 — My classes.** `GET /v1/staff/teaching-ai/classes?from&to` returns the sessions where the requester is the assigned instructor or assistant: program, level, time, location label, and linked class plan id. No student contact data.
- **T3 — School Teaching Framework.** Versioned, audited records and reads for:
  - programs/levels
  - rank objectives (reuse existing curricula)
  - weekly and monthly rotations
  - class plans linked to sessions
  - assigned instructors
  - "what was taught" logs
  - "items to revisit"
  Writes are human-confirmed only.
- **T4 — Kai conversation.** The same shape as HON contract 1 in `HON_COMMAND_EXPERIENCE.md`, scoped to Teaching AI access. Any consequential step returns an Action Engine `CONFIRM` proposal.
- **T5 — Kai drafts and history.** A new agent/record key, for example `kai` or a neutral `teaching_ai`. The existing `teaching.draft.save` path and every `claire` record keep their historical meaning. Note: the legacy teaching assistant still plans invocations with `agentKey: 'claire'` today, so new teaching drafts keep landing under that key until T5 exists.
- **T6 — Instructional read access.** Read-only, Teaching-AI-scoped access to Teaching Studio, the Curriculum Library and Curriculum Progress, with closed non-capabilities: no proficiency, promotion, testing result, rank or completion writes.

## Next frontend steps (separate PR, not #73)

1. Once T1 lands, build `/staff/teaching` with the shared component layer and server-reported capabilities. Hide the HON launcher and management navigation when `managementAccess` is false.
2. Bind "Today's classes" to T2, the framework tabs to T3, the composer to T4, and drafts and history to T5.
3. Move the Kai card in HON to read its name and availability from T1.
4. Browser proof for an owner, a teaching-only instructor and a management-only user in all three modes.
