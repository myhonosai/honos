# Unified HON AI Command Experience — frontend integration (v1)

**Status:** Draft PR, not deployed. Frontend only. No API, contract, migration, entitlement, billing, AI-credit, provider or D11 change.
**Baseline:** `main` at `9c1e0ca`.

## What it is

One shared HON workspace that school staff reach from every signed-in staff page, rendered in the user's verified presentation mode (Modern, Big-Button, Classic). It composes only existing, independently authorized reads and links into existing governed workflows. It never sends, approves, executes or stores anything.

| Surface | Where | Notes |
| --- | --- | --- |
| Dashboard HON band | `/staff/dashboard`, after the operations report verifies the school | HON plus all seven employees; per-mode layout; opens the panel in place so dashboard context is kept |
| Persistent launcher ("Ask HON") | Every other `/staff/*` page (rendered from the root layout, shown only under `/staff/`) | Lazy: nothing is fetched until opened. School resolved from the signed-in session only |
| Expandable panel | Modal side sheet over the current page | Esc / Close / scrim close it and return focus to the opener; Tab is trapped; full-screen on phones |
| Full workspace | `/staff/hon?return=<staff path>&agent=<id>` | Session-gated, no-index. `return` is limited to same-origin `/staff/...` paths; `agent` only highlights a card. Neither selects a school |

Shared code: `apps/web/src/components/hon-command/`

- `roster.ts` — capability registry. Identity (name, approved title, original portrait) comes from the protected `@hon/design-system` `HON_AI_TEAM`; no asset or mapping is changed.
- `hon-command-data.ts` — framework-free controller over existing reads, with per-section `IDLE / LOADING / READY / EMPTY / DENIED / ERROR` states and stale-result protection.
- `hon-workspace-view.tsx` — pure presentation shared by panel, full workspace and all three modes.
- `hon-command.tsx` — panel, launcher, dashboard band and full workspace containers.
- `hon-conversation.ts` — the conversation integration boundary (currently `NOT_CONNECTED`).

## Existing contracts reused (no new endpoints)

| Need | Existing contract | Authority checked by |
| --- | --- | --- |
| School scope (launcher / full workspace) | `GET /v1/staff/current-reporting-school` (signed subject only) | API; multi-school users are sent to the dashboard chooser |
| School scope (dashboard band) | Operations report verification already performed by the dashboard | API (`reporting.view`) |
| Presentation mode | `GET /v1/organizations/:org/schools/:school/interface-theme` | API; presentation only |
| Suggested actions + counts | `GET /v1/organizations/:org/schools/:school/command-center` (deterministic, NAVIGATE only) | API |
| Recorded AI work | `GET /v1/marketing/assistant/mine`, `/v1/staff/leads/assistant/mine`, `/v1/staff/teaching-assistant/mine` (requester-scoped) | Each assistant's resolver + Complete entitlement; items filtered to the verified school in the browser |
| Approvals | `GET /v1/staff/action-center/approvals/:school?status=AWAITING_APPROVAL` | API (`action.approve`); decisions stay in the existing Action Center |
| Governed drafting | Existing Chad (`/staff/leads/assistant`) and Marcus (`/staff/marketing/assistant`) workbenches | Existing Action Engine `CONFIRM` path |
| Text handoff | Existing `/staff/voice` (stores private human evidence only) | API |

## Functionality matrix

| Capability | State | Evidence / limitation |
| --- | --- | --- |
| Open HON from any supported school dashboard mode | **Working** | Band on `/staff/dashboard` in all three modes; launcher on every other staff page |
| See all seven employees with approved portrait, name and role | **Working** | Roster test pins order, titles and portraits to `HON_AI_TEAM` |
| Agent detail: capabilities, related CRM workflows, approval requirement, availability | **Working** | Static truthful registry; every link resolves to an existing staff page (unit-tested) |
| Chad / Marcus governed draft workspaces | **Working** | Links to existing workbenches; drafts still need a different human's Action Center approval |
| Verified work history per agent | **Working** for Chad and Marcus | Requester's own durable records only, at most 20 per source, status only |
| Recorded AI work list | **Working** | Same limits; legacy teaching records labeled as such |
| Approvals awaiting review | **Working** (read) | Listed with source workflow; decision happens in Action Center |
| Approval decision from HON | **Partially working** | Navigates to the existing Action Center, which still asks for the school UUID (frontend follow-up below) |
| Suggested actions | **Working** | Command Center deterministic rules; navigation only; Core tier note shown from the Command Center's reported tier |
| Loading / empty / denied / error / selection-required states | **Working** | Unit + browser tests |
| Return to the dashboard with context | **Working** | Panel keeps the page underneath; full workspace returns to the originating staff page |
| HON conversation (ask, answer, delegate) | **Backend required** | Composer is rendered disabled and labeled "Not connected" |
| Conversation history | **Backend required** | No list contract exists for HON conversations or voice/text handoff sessions |
| Alex, Maya, Jordan, Claire, Lena capabilities | **Backend required** | Shown as "Planned · not yet available"; no activity is displayed |
| Server-evaluated agent availability | **Backend required** | Availability is a static frontend registry today |
| Voice | **Backend required** | Existing handoff page states no provider is connected |

## Claire discrepancy (investigated)

The approved roster names Claire the **Business Performance Manager**. Before that decision, the teaching/curriculum drafting slice was built under the agent key `claire`:

- `packages/contracts/src/ai-draft-work.ts` — `AI_DRAFT_WORK_AGENT_KEYS` includes `claire` for teaching drafts.
- `packages/config/src/ai-team-catalog.ts` — `claire` titled "Curriculum support guide" (all seven catalog titles are pre-roster placeholders; the AI Team directory API returns them).
- Migration `0100_claire_teaching_assistant.sql`, `DRAFT_TEACHING` routing, action code `teaching.draft.save`.

Frontend handling in this change (historical meaning preserved, nothing renamed in data or contracts):

- The unified HON never attributes `claire`-keyed records to Claire. They appear as **"Teaching draft assistant (legacy)"** with an explicit note, and open the existing teaching workbench.
- Claire's card has no teaching link and no work history; it says no AI work contract exists yet.
- `/staff/ai-work` labels those records "Teaching drafts · Legacy curriculum drafts" instead of "Claire · Curriculum support".
- `/staff/teaching-assistant` no longer calls itself Claire; it explains the legacy key. Its route title is now "HON | Teaching draft assistant (legacy)".

Owner decision still open: which employee (if any) should own the teaching assistant.

## Exact backend contracts needed from Codex

1. **HON conversation orchestration** (school-scoped, requester-scoped, Complete-gated, routed through the Action Engine):
   - `GET /v1/organizations/:org/schools/:school/hon/conversations` — the requester's threads (id, title, updatedAt, status), paginated.
   - `GET /v1/organizations/:org/schools/:school/hon/conversations/:id` — turns with role (`HUMAN` / `HON` / agent key), text, and typed references (`workItemId`, `actionRequestId`) only.
   - `POST /v1/organizations/:org/schools/:school/hon/conversations/:id/turns` with `Idempotency-Key` — returns a receipt (`turnId`, `status: PENDING | ANSWERED | NEEDS_APPROVAL | FAILED | UNKNOWN`, `delegatedAgentKeys`, `actionRequestIds`). Any consequential step must surface as an Action Engine `CONFIRM` proposal, never execute directly.
2. **Handoff/session history:** `GET /v1/staff/voice/:schoolId/mine` — the requester's own voice/text handoff sessions (id, agentCatalogId, state, expiresAt, updatedAt), so history can be shown without typing session UUIDs.
3. **Server-evaluated team availability:** `GET /v1/organizations/:org/schools/:school/ai/team/capabilities` — per agent key, the capabilities the current human can use now (entitlement, permission, configured route), so the frontend stops relying on a static registry. Also correct `AI_TEAM_CATALOG` titles in `packages/config` to the approved roles (the directory API currently returns legacy titles such as "Curriculum support guide").
4. **School-scoped AI work feed:** a single paginated `GET /v1/organizations/:org/schools/:school/ai/work` (requester-scoped, with a neutral `sourceKey` such as `teaching` for the legacy `claire` records, preserving history) instead of three cross-school `/mine` calls capped at 20.
5. **Approval source attribution:** add a closed `sourceWorkflow` (or `agentKey`) to `ActionReviewItem` so approvals need not be inferred from `actionCode`.
6. **Governed workspaces for Alex, Maya, Jordan, Claire, Lena** — one bounded draft slice per role (for Claire, a business-performance draft over the existing operations report and Command Center aggregates).

## Next frontend steps

1. Prefill Action Center from the verified current school (resolver) so "Review in Action Center" opens the queue directly.
2. Bind the conversation boundary to contract 1 once it exists; enable the composer only on a verified `READY` route.
3. Replace the static availability registry with contract 3.
4. Use contract 4 for paging and full history; add per-agent filters.
5. Apply the same HON band to the verified Command Center page.
6. Owner decision: retire or relabel the design-reference routes (`/`, `/complete-mobile`, `/reference/classic-dashboard`), which still show representative sample activity and are not connected to a school. They were not changed here.

## Verification

- `pnpm --filter @hon/web test` — 133 files, 944 tests pass (24 new in `test/hon-command.test.tsx`).
- `pnpm --filter @hon/web check` and `pnpm --filter @hon/web build` pass.
- `apps/web/scripts/hon-command-browser.mjs` (local, synthetic fixtures, `HON_COMMAND_BROWSER_LOCAL=1`) — 17 checks on the production build: all three modes at desktop 1440, phone 390 and tablet 834; panel, every agent detail, tabs, keyboard (open, arrow keys, focus trap, Escape focus return), launcher on another staff page, full-workspace round trip, unsafe `return`/`agent` values, empty / denied / error / loading / multi-school states, and no operational claim for unsupported capabilities. axe (WCAG 2 A/AA) reports no violations on HON surfaces.
- Pre-existing, not changed here: whole-page axe findings on the dashboard's Platform View picker (contrast) and an operations card `dl`; the Platform View picker overflows horizontally in Classic at 390px.
