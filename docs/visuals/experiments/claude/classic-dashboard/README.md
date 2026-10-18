# Claude experiment — Classic School Dashboard (reference proof)

| | |
| --- | --- |
| **Status** | **Needs owner review** (not approved, not merged) |
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
| Platform View switch in top bar | Compact inline `<details>` directly below School/Location | Manus visual protocol; Big-Button and Modern link to their existing reference views |

## Responsive behavior

- **Desktop (≥1100px):** fixed 248px sidebar, 12-column panel grid, six KPIs (three per row below 1360px), AI team in one row of seven.
- **Tablet (700–1099px):** sidebar becomes a drawer opened from the top-bar menu button; paired panels go full-width where a half-width panel would be orphaned.
- **Phone (<700px):** drawer plus a five-item bottom bar (Home, Leads, Schedule, Attendance, More), 2×2 quick actions, two-column KPIs, horizontally swipeable AI team, tables rendered as compact records.
- No horizontal page overflow at 1440, 834, or 390px. Escape closes the drawer and menus, and focus returns to the menu button. Visible focus rings; `prefers-reduced-motion` respected.

## Screenshots

| | |
| --- | --- |
| Desktop 1440 (above the fold) | `desktop-1440-fold.jpg` |
| Desktop 1440 (full page) | `desktop-1440-full.jpg` |
| Desktop: appearance expanded (Anime) + notifications | `desktop-1440-appearance-notifications.jpg` |
| Tablet 834 (full page) | `tablet-834-full.jpg` |
| Phone 390 (above the fold) | `phone-390-fold.jpg` |
| Phone 390 (full page) | `phone-390-full.jpg` |
| Phone 390: navigation drawer | `phone-390-navigation-drawer.jpg` |

Screenshots were taken from a local production build (`next build && next start`) in headless Chromium, outside the Manus preview, so Manus-hosted images show their fallbacks.

## Known gaps / next steps (not done)

1. Wire to real data: render the same components from `GET` OperationsReport + Command Center + class-session read + lead list + follow-up queue inside the authenticated `/staff/*` shell (requires coordination because `/staff/dashboard` is Manus-owned).
2. A student directory route does not exist; the "Active students" KPI links to Staff Search.
3. Core-tier variant (hide the AI team strip) and a real entitlement read.
4. Shared design-system extraction of these components only after owner approval of this look.

## Removal

Discard the branch/PR, or delete the files listed above and the one `manus-routes.json` entry.
