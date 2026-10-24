# Claude experiment — Classic School Dashboard (reference proof)

| | |
| --- | --- |
| **Status** | **Revision 3: needs owner review** (direction approved 2026-10-18; AI-visibility revision 2026-10-24; not merged) |
| **Source branch** | `ccr-c2933356-uza21g` |
| **Route** | `/reference/classic-dashboard` (no-index, public reference like `/` and `/core`) |
| **Tracking** | GitHub issue #2 "HON OS — Claude Code Development Status" |
| **Recommendation** | Needs owner review |

## Purpose

Owner-approved proof that Claude Code can implement the HON OS Classic CRM school dashboard at production SaaS quality: sidebar, top bar, school/location selector, appearance controls, KPI and operational panels, tasks, quick actions, and a usable desktop / tablet / phone experience. It is one screen only. It does not change Modern HON, Big-Button, HQ, or any live staff screen.

## Stage (truthful)

| Stage | State |
| --- | --- |
| Designed | Yes |
| UI implemented | Yes (reference route) |
| Connected to real data | **No.** Sample values are typed to the real `OperationalSnapshot`, `CommandCenterMetrics`/recommendations, `CurrentSchoolClassSession`, `LeadListItem`, and `FollowUpQueueItem` contracts, so live wiring is a data-source swap, not a redesign |
| Functionally tested | Rendering, links, truthful-state, and interaction checks (see Evidence) |
| Security tested | Not applicable: no API, database, auth, permission, or entitlement change |
| Approved / merged / deployed | No / No / No |

## Changed files

New (isolated):

- `apps/web/src/app/reference/classic-dashboard/page.tsx`
- `apps/web/src/components/classic-dashboard/classic-dashboard.tsx`
- `apps/web/src/components/classic-dashboard/classic-dashboard.module.css`
- `apps/web/src/components/classic-dashboard/sample-data.ts`
- `apps/web/src/components/classic-dashboard/portraits.ts`
- `apps/web/src/components/classic-dashboard/icons.tsx`
- `apps/web/test/classic-dashboard-reference.test.tsx`
- `docs/visuals/experiments/claude/classic-dashboard/` (this README + screenshots)

Shared append-only: one route entry in `apps/web/public/manus-routes.json` (the existing route-manifest tests require every page to be listed).

## Original assets: confirmation

No original asset or mapping was modified, moved, regenerated, or deleted. **No new image assets were created.**

| Original (per `VISUAL_ASSET_INVENTORY_2026-10-17.md`) | Use here |
| --- | --- |
| `apps/web/public/ai/{alex,chad,maya,marcus,jordan,claire,lena}.webp` | Realistic portraits, referenced read-only |
| Manus-hosted Modern Anime / Chibi keys (section C) | Referenced read-only with the identical identity mapping; initials fallback when the hosted image cannot load (outside the Manus preview) |
| Manus-hosted HON mark `V2i1y…/image-1.webp` | Referenced read-only; "H" tile fallback outside the Manus preview |

Protected shared files untouched: `app.config.ts`, `layout.tsx`, `globals.css`, `hon-reference-suite.*`, `hon-control-shell.*`, `interface-theme-picker.tsx`, `interface-theme-preference.ts`, `public/ai/**`, `docs/visuals/hq-concepts/**`.

## Design decisions vs. the owner mockups

| Mockup element | Implemented as | Why |
| --- | --- | --- |
| "↑12% vs last 30 days" trend deltas | Omitted | `OperationalSnapshot` is current-state only; the schema has no history to compare against |
| Revenue chart / total revenue | "Not available yet" card with the Command Center's exact reason | `revenue` is contractually UNAVAILABLE; paid invoices are shown separately as "not cash revenue" |
| Trial→student conversion | Unavailable card | No authoritative trial-to-enrollment linkage |
| Class "12/16 enrolled", instructor | Capacity only + footnote | Not part of the current class-session read |
| Campaign open/click rates, "Recent communications: Sent/Delivered" | Not shown | No provider delivery or receipts exist; showing them would imply messaging works |
| AI cards "Running / Engaged / Optimizing" | "No recorded work" | No durable AI activity source; never invent agent work |
| "Retention AI", "Command Center" agents | Locked roster Alex, Chad, Maya, Marcus, Jordan, Claire, Lena | Owner-locked identities |
| Pricing / tier price in top bar | Tier label only ("HON Complete · Sample entitlement"), no price | Owner rule: no pricing in the school command bar |
| Platform View switch in top bar | Revision 3: inert **View** selector beside the page title (Classic selected; Big-Button and Modern disabled). Portrait style stays in the inline `<details>` below School/Location | The isolated proof is Classic only and does not implement cross-mode navigation; the separate Modern and Big-Button concept pages are linked from the About popover, clearly labeled as separate pages |

## Revision 2 (owner feedback, 2026-10-18)

| Owner request | Change |
| --- | --- |
| Less vertical scrolling on mobile; prioritize quick actions, today, urgent alerts, AI access | Phone home order is now: quick actions → compact key figures (3 columns) → Today at a glance → top 3 urgent alerts (+ "View all 5 in Command Center") → AI team row. The eight detailed sections collapse under **More details** as tap-to-expand rows with a one-line summary (e.g. "5 classes · 1 cancelled", "1 overdue"). Phone page height: **6,004px → 1,953px (−67%)** |
| More compact AI employee cards, all seven, direct workspace access | Desktop: one row of seven compact cards (portrait, name, role). Phone: swipeable avatar row. Each card links to that employee's existing workspace: Chad → `/staff/leads/assistant`, Marcus → `/staff/marketing/assistant`; Alex, Maya, Jordan, **Claire** and Lena → the shared AI draft inbox `/staff/ai-work`, labeled "dedicated workspace not yet available". A single line states "no work recorded in this sample" |
| Persistent HON assistant entry point, not pretending to be connected | Floating **HON** button bottom-right on desktop/tablet (same placement pattern as the HQ concept frames) and a raised **Ask HON** centre slot in the phone bottom bar. It opens a panel labeled **Preview · not connected** with navigation-only "Jump to" links, a **disabled** message field, voice **off**, and a link to the existing governed `/staff/voice` handoff workspace. No AI backend, no network call, no microphone |
| Preserve originals / branding | Unchanged: no new image assets; original portraits and the hosted HON mark referenced read-only |
| Consistent with the developing HQ design, Classic distinct | Shared patterns: dark navy shell, left sidebar with grouped navigation, persistent HON button bottom-right. Classic stays denser and flatter (tables, tinted active state, no hero imagery). No HQ file touched; Codex leads HQ |

## Revision 3 (owner feedback, 2026-10-24): AI team visibility

Baseline: merged current `main` (272e92e, includes PR #69) into this branch; only `TODO.md` and `manus-routes.json` conflicted and both sides were kept. Draft PR #71 (HQ hero restore) is not touched.

| Owner request | Change |
| --- | --- |
| HON and the full school AI team prominent near the top | New **HON & your AI team** band directly under the page header, above the key figures (desktop, tablet and phone) |
| All seven, existing names, portraits and roles | Alex, Chad, Maya, Marcus, Jordan, Claire, Lena from `HON_AI_TEAM` (names, titles, colors, `/ai/*.webp` portraits; Anime/Chibi switch unchanged) |
| Compact premium portrait cards | 56px rounded portrait with the agent's color accent, name, full role, and a capability chip. No hero art |
| Keep sidebar, density, workflows | Sidebar, quick actions, KPIs, tables and collapsible phone sections unchanged |
| Persistent HON access | HON lead card with **Ask HON** (same not-connected panel) and a link to the `/staff/voice` text handoff workspace, plus the existing floating HON button and phone **Ask HON** slot |
| Mobile | HON card compacts to one row; the seven agents form a horizontally scrollable row of 92px cards |
| View selector as a visual reference | Inert Big-Button / Modern / Classic selector labeled "Visual reference · switching not wired in this proof" |
| Real vs planned AI | **Drafts · approval**: Chad (`/staff/leads/assistant`) and Marcus (`/staff/marketing/assistant`) have built, governed draft workspaces; the chip legend says plan, provider and credit setup are not checked in this preview. **Planned**: Alex, Maya, Jordan, Claire, Lena (open the shared AI draft inbox). HON: **Preview · not connected**. No activity, status or work counts are shown for any agent |
| Preserve auth and data boundaries | No API, auth, permission, entitlement, database or HQ change. All links are plain navigation to existing pages that authorize themselves |

### Comparison with the AI-centered concepts

| | Modern HON (`/`) | Big-Button (`/complete-mobile`) | Classic revision 3 |
| --- | --- | --- | --- |
| AI placement | Hero headline + large selected-agent stage, seven tall portrait cards | Phone frame: four agent avatars, greeting, big prompt buttons | Compact HON + seven-card band above dense CRM data |
| Operational density | Low (three glance numbers) | Lowest (prompt buttons) | High (KPIs, tables, breakdowns) |
| Agent status | Shows Ready/Working and "AI work in motion" items as representative sample state | Shows "Chad is organizing 5 lead follow-ups · Working" as sample state | Shows only what exists: draft workspace vs planned; no activity |
| Cross-mode switch | Appearance dock changes presentation in-page | Same dock | Inert visual reference only |

## Claire role correction (owner decision, 2026-10-18)

Claire is officially HON's **Business Performance Manager** (business analytics, performance reporting, KPIs, financial insights and recommendations). Her card no longer opens the existing curriculum/teaching assistant; it opens the shared AI draft inbox with an explicit "dedicated workspace not yet available" label. The teaching assistant (`/staff/teaching-assistant`, `apps/api/src/teaching-assistant`) is unchanged and not deleted; any reassignment of that functionality is a separate, owner-approved task.

## Responsive behavior

- **Desktop (≥1100px):** fixed 248px sidebar, 12-column panel grid, HON card plus seven agent cards in one row above six KPIs (three per row below 1360px).
- **Tablet (700–1099px):** sidebar becomes a drawer opened from the top-bar menu button; the HON card spans the width and the agents scroll horizontally; paired panels go full-width where a half-width panel would be orphaned.
- **Phone (<700px):** drawer plus a five-item bottom bar (Home, Leads, **Ask HON**, Schedule, More), 2×2 quick actions, three-column compact KPIs, priority ordering (quick actions, HON and AI team, key figures, today, alerts) with collapsible detail sections, horizontally scrollable agent cards, tables rendered as compact records when expanded.
- No horizontal page overflow at 1440, 834, or 390px. Escape closes the drawer and menus, and focus returns to the menu button. Visible focus rings; `prefers-reduced-motion` respected.

## Screenshots

| | |
| --- | --- |
| Desktop 1440 (above the fold) | `desktop-1440-fold.jpg` |
| Desktop 1440 (full page) | `desktop-1440-full.jpg` |
| Desktop: inert view selector + About popover (links to the separate concept pages) | `desktop-1440-view-selector-about.jpg` |
| Desktop: HON assistant panel | `desktop-1440-hon-assistant.jpg` |
| Tablet 834 (full page) | `tablet-834-full.jpg` |
| Phone 390 (above the fold) | `phone-390-fold.jpg` |
| Phone 390 (full page) | `phone-390-full.jpg` |
| Phone 390: agent row scrolled to Jordan, Claire, Lena | `phone-390-agents-scrolled.jpg` |
| Phone 390: HON assistant panel | `phone-390-hon-assistant.jpg` |
| Phone 390: a detail section expanded | `phone-390-section-expanded.jpg` |
| Phone 390: navigation drawer | `phone-390-navigation-drawer.jpg` |

Screenshots were taken from a local production build (`next build && next start`) in headless Chromium, outside the Manus preview, so Manus-hosted images show their fallbacks.

## Known gaps / next steps (not done)

1. Wire to real data: render the same components from `GET` OperationsReport + Command Center + class-session read + lead list + follow-up queue inside the authenticated `/staff/*` shell (requires coordination because `/staff/dashboard` is Manus-owned).
2. A student directory route does not exist; the "Active students" KPI links to Staff Search.
3. Core-tier variant (hide the AI team strip) and a real entitlement read.
4. Shared design-system extraction of these components only after owner approval of this look.

## Removal

Discard the branch/PR, or delete the files listed above and the one `manus-routes.json` entry.
