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

States: **Fully working** means it runs on existing authorized contracts. **Partially working** means it works, with a stated limit. **Backend required** means no contract exists yet. **Design-only** means it is shown as planned or as a frozen shape, with no runtime behaviour. Opening an existing tool is navigation. It is never presented as an AI employee doing the work.

| Capability | State | Evidence / limitation |
| --- | --- | --- |
| Open HON from every supported school dashboard mode (band, launcher, panel, full workspace) | **Fully working** | Band on `/staff/dashboard` in all three modes; launcher on other `/staff/*` pages; never on reference, parent, HQ or auth routes |
| Management content only for a server-verified management scope | **Fully working** (presentation) | HON body renders only after the operations report or the `reporting.view` resolver; every API still authorizes on its own |
| Seven employees with approved portrait, name and role | **Fully working** | Roster test pins order, titles and portraits to `HON_AI_TEAM` |
| Agent detail: capabilities, CRM workflow links, approval rules, availability label | **Partially working** | Truthful but static frontend registry; server-evaluated availability is backend required |
| Chad / Marcus governed draft workspaces | **Fully working** | Existing workbenches; drafts still need a different human's Action Center approval |
| Recent verified work per agent and the AI work tab | **Partially working** | The requester's own records only, at most 20 per source across all schools, then filtered to this school. The UI says it is not a complete history |
| Approvals awaiting review | **Fully working** (read) | Listed with the source workflow; decisions happen in Action Center |
| Approval decision from HON | **Partially working** | Opens Action Center, which still asks for the school UUID (prefill proposed below) |
| Suggested actions | **Fully working** | Command Center deterministic rules; navigation only |
| Loading / empty / denied / error / selection-required states | **Fully working** | Unit and browser tests |
| Return to the originating page | **Fully working** | Panel keeps the page; full workspace uses a sanitized `return` |
| Conversation turn states (Proposed, Processing, Delegating, Awaiting approval, Completed, Failed, Unknown) | **Built, server-gated** (F3) | Closed mapping in `hon-conversation.ts`; anything unrecognized shows as Unknown; a state renders only from a verified server body. Proven against synthetic fixtures only |
| Conversation interface: thread layout, history list, new conversation, transcript, delegation cards, approval notices, linked results, send/failed/unknown recovery | **Built, server-gated** (F3) | `hon-conversation-view.tsx` in all three modes and both presentations. In production no conversation source exists, so it shows "Not connected" with the composer, Send and New conversation disabled |
| HON conversation answers, real history, real delegation and results | **Backend required** | Needs contract 1 below. Nothing is sent, stored or answered today |
| Alex, Maya, Jordan, Claire, Lena capabilities | **Backend required** | Shown as "Planned · not yet available"; no activity is displayed |
| Separate Teaching AI (Kai) | **Design-only** | Display-only planned card; access, catalog, name configuration and execution are backend required (T1–T6) |
| Teaching-only navigation and menus | **Backend required** | Not claimed as operational; needs T1 (`managementAccess` and Teaching AI grant) |
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

Owner decision (2026-10-24): the teaching assistant is assigned to neither Claire nor Jordan. It becomes a separate Teaching & Curriculum AI, provisionally named **Kai**, with access separate from the seven management employees. HON shows Kai only as a separate, planned display entry. Legacy `claire` records keep their historical label and are not shown as Kai's work. See `HON_TEACHING_WORKSPACE_PROPOSAL.md` for the UI proposal, the capability-dependency matrix and backend contracts T1–T6.

## Exact backend contracts needed from Codex

1. **HON conversation orchestration** (school-scoped, requester-scoped, Complete-gated, routed through the Action Engine):
   - `GET /v1/organizations/:org/schools/:school/hon/conversations` — the requester's threads (id, title, updatedAt, status), paginated.
   - `GET /v1/organizations/:org/schools/:school/hon/conversations/:id` — turns with role (`HUMAN` / `HON` / agent key), text, and typed references (`workItemId`, `actionRequestId`) only.
   - `POST /v1/organizations/:org/schools/:school/hon/conversations/:id/turns` with `Idempotency-Key` — returns a receipt (`turnId`, `status: PROPOSED | PROCESSING | DELEGATING | AWAITING_APPROVAL | COMPLETED | FAILED | UNKNOWN`, `delegatedAgentKeys`, `actionRequestIds`, `workItemIds`). The frontend already maps exactly these states, and treats anything else as `UNKNOWN`. Any consequential step must surface as an Action Engine `CONFIRM` proposal, never execute directly.
   - `GET /v1/organizations/:org/schools/:school/hon/readiness` — server-confirmed `contract`, `providerRoute`, `entitlement` and `authorization` booleans for this requester. The composer is enabled only when all four are true. Provider calls must go through the existing AI spending protections; the frontend never chooses a provider or model.
   - Verified school context, for example operations counts and Command Center aggregates, must be assembled on the server from existing authorized reads, never from text supplied by the browser.
2. **Handoff/session history:** `GET /v1/staff/voice/:schoolId/mine` — the requester's own voice/text handoff sessions (id, agentCatalogId, state, expiresAt, updatedAt), so history can be shown without typing session UUIDs.
3. **Server-evaluated team availability:** `GET /v1/organizations/:org/schools/:school/ai/team/capabilities` — per agent key, the capabilities the current human can use now (entitlement, permission, configured route), so the frontend stops relying on a static registry. Also correct `AI_TEAM_CATALOG` titles in `packages/config` to the approved roles (the directory API currently returns legacy titles such as "Curriculum support guide").
4. **School-scoped AI work feed:** a single paginated `GET /v1/organizations/:org/schools/:school/ai/work` (requester-scoped, with a neutral `sourceKey` such as `teaching` for the legacy `claire` records, preserving history) instead of three cross-school `/mine` calls capped at 20.
5. **Approval source attribution:** add a closed `sourceWorkflow` (or `agentKey`) to `ActionReviewItem` so approvals need not be inferred from `actionCode`.
6. **Governed workspaces for Alex, Maya, Jordan, Claire, Lena** — one bounded draft slice per role (for Claire, a business-performance draft over the existing operations report and Command Center aggregates).

## F3 conversational interface (frontend, server-gated)

**What is built.** Reusable components in `apps/web/src/components/hon-command/`:
- `hon-conversation-contract.ts`: typed shapes of contract 1 and strict closed-key verifiers. A thread whose `schoolId` differs from the verified school is rejected. Delegation targets are limited to the seven management keys, so Kai and unknown names are rejected. Unknown status strings show as Unknown. Limits: 50 threads per page, 200 turns per thread, 7 delegations and 10 references per turn, 2,000 characters per message.
- `hon-conversation-data.ts`: `HonConversationController`. Without an injected source (production today) it never leaves `NOT_CONNECTED` and makes no request. With a source it checks readiness first. History is loaded only when all four readiness booleans are true. A send is allowed only while READY. Outcomes:
  - A definitive refusal becomes Failed.
  - Any other error, or a receipt for another thread, becomes Unknown. Unknown keeps the text and the request key, so a retry of the same message is deduplicated by the server; editing the text drops the key.
  - A success shows only the server's re-read of the thread, never the receipt or a local echo.
- `hon-conversation-view.tsx`: the conversation surface for the panel and the full workspace in Modern, Big-Button and Classic. Approval-required turns always say "Approval required. Nothing has run." and link to Action Center. Proposed turns say nothing has run. Linked results only open existing routes, and each says access is checked again there.
- Synthetic fixtures and a design preview live in `preview/`. They are served only at `/reference/hon-conversation`, which returns 404 unless the server runs with `HON_REFERENCE_PREVIEW=1`, and is never indexed. A test proves that no production module imports them.

**Backend dependency checklist (owner: Codex). The composer stays disabled until every item exists.**
- [ ] `GET …/hon/readiness` with exactly `contract`, `providerRoute`, `entitlement` and `authorization`, evaluated for the signed-in human and the exact school.
- [ ] `GET …/hon/conversations`: the requester's own threads at this school only, as `{ items: [{ id, title, status, updatedAt }], more }`, at most 50 per page.
- [ ] `GET …/hon/conversations/:id`: `{ id, schoolId, title, turns }`. Each turn is `{ id, role: HUMAN | HON | AGENT, agentKey (AGENT only, one of the seven), text, status, createdAt, delegations: [{ agentKey, status, summary }], references: [{ kind: WORK_ITEM | ACTION_REQUEST, id }] }`, in ascending time order. The thread is private to its requester and 404s for anyone else.
- [ ] `POST …/hon/conversations` (new thread with its first message) and `POST …/hon/conversations/:id/turns`: `Idempotency-Key` deduplication, returning `{ turnId, threadId, status, delegatedAgentKeys, actionRequestIds, workItemIds }`. A definitive refusal must be a distinguishable 4xx; anything else is shown as an unknown outcome.
- [ ] Consequential steps become Action Engine `CONFIRM` proposals. `COMPLETED` is reported only for verified read-only results or executed approved actions.
- [ ] Provider calls only through the existing AI spending protections and Complete entitlement. The frontend never picks a provider, model or agent.
- [ ] School context assembled on the server from existing authorized reads; browser-supplied agent names, themes or URL values are never authority.
- [ ] Management versus teaching separation: readiness `authorization` is false for teaching-only staff. Kai's conversation is the separate T4 contract.
- [ ] Then a small frontend PR adds the HTTP source (`HonConversationSource`) and passes it to the workspace. No other UI change should be needed.

## Known issues and how they are handled

| Issue | Handling in this PR | Follow-up |
| --- | --- | --- |
| AI work history capped at 20 per source | Labeled "recent" with an explicit "not a complete history" note | Contract 4 (paginated, school-scoped feed) |
| Action Center asks for a school UUID | Not changed here (unrelated page) | Proposed separate PR: prefill Action Center from the same signed-subject resolver HON uses (`GET /v1/staff/current-reporting-school`) only when it returns `RESOLVED`. Never prefill from the URL, storage or theme. Keep manual entry for multi-school users; the queue API still enforces `action.approve` |
| Sample/reference dashboards (`/`, `/complete-mobile`, `/reference/classic-dashboard`) | Already labeled "Design reference · representative sample state only" / "labeled sample data"; HON's launcher never appears there (tested) | Owner decision: retire, move under `/reference/`, or keep |
| Teaching-only navigation | Not claimed; HON hides management content without a verified management scope | T1 |
| Conversation composer not connected | Disabled and labeled "Not connected" in production; full interaction states proven only on synthetic fixtures (F3) | Contract 1, then a small source-binding PR |
| Kai identity and availability are frontend constants | Labeled provisional and planned | T1 |

## Next frontend PRs (none started; each needs owner approval)

1. **F3 — Server-gated conversational interface:** built in this PR (see above). Production stays "Not connected".
   **Source binding (was F2):** add the HTTP `HonConversationSource` for contract 1 and pass it to the workspace. Depends on Codex contract 1 and the provider/entitlement route.
2. **Delegation feed and work history:** server-evaluated availability (contract 3), a paginated school AI work feed with per-agent filters (contract 4), approval attribution (contract 5), and delegation progress from contract 1 receipts. Includes the small Action Center verified-school prefill, unless the owner wants that sooner as its own PR.
3. **F4 — Kai Teaching Workspace:** `/staff/teaching`, per `HON_TEACHING_WORKSPACE_PROPOSAL.md`, after Codex T1–T3 are reviewed.
4. **F5 — Premium polish:** fix the pre-existing Platform View picker contrast and overflow in Classic at 390px; consistent staff navigation across modes; onboarding; the approved HON mark served locally instead of from the Manus host.

## Owner decisions open

1. The reference routes (`/`, `/complete-mobile`, `/reference/classic-dashboard`): keep as labeled design references, move them under `/reference/`, or retire them.
2. Whether the Action Center prefill ships as its own small PR.
3. Kai: the final default name. The owner approved three portrait styles: realistic for Modern, illustrated for Classic and chibi for Big-Button. All three are in use.
4. Whether the HON launcher should be hidden on `/staff/*` pages for users without a verified management scope once T1 can tell them apart. Today it opens to a short notice only.

## Verification

- `pnpm --filter @hon/web test` — 133 files, 949 tests pass (29 in `test/hon-command.test.tsx`).
- `pnpm --filter @hon/web check` and `pnpm --filter @hon/web build` pass.
- `apps/web/scripts/hon-command-browser.mjs` (local, synthetic fixtures, `HON_COMMAND_BROWSER_LOCAL=1`) — 17 checks on the production build: all three modes at desktop 1440, phone 390 and tablet 834; panel, every agent detail, tabs, keyboard (open, arrow keys, focus trap, Escape focus return), launcher on another staff page, full-workspace round trip, unsafe `return`/`agent` values, empty / denied / error / loading / multi-school states, and no operational claim for unsupported capabilities. axe (WCAG 2 A/AA) reports no violations on HON surfaces.
- Pre-existing, not changed here: whole-page axe findings on the dashboard's Platform View picker (contrast) and an operations card `dl`; the Platform View picker overflows horizontally in Classic at 390px.
