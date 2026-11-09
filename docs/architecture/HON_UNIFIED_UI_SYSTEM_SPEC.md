# HON OS Unified UI System — Specification (U-series)

Status: SPEC, owner-directed 2026-11-06 ("Claude is now primary product architect, UI designer and full-stack developer").
Baseline: `main` deae407. Owner of this stream: Claude. Independent QA/review: Manus. Codex: optional support.
Companion: [HON_UNIFIED_UI_BUILD_PLAN.md](HON_UNIFIED_UI_BUILD_PLAN.md).

## 1. Problem (verified from source and owner test screenshots)

| Area | HQ (`/hq/*`) | School app (`/staff/*`, ~60 routes) |
|---|---|---|
| Shell | One shared `HqModernShell`: rail, drawer, mobile bottom nav, page header, HON assistant | **None.** `app/staff/layout.tsx` only gates the session; every workbench renders its own `<main>` |
| School context | n/a | Most workbenches ask the person to type **Organization UUID / School UUID**. A server-resolved selector already exists (`SchoolEntryController`, `GET /v1/staff/current-reporting-school`, reporting-school choices) but only `/staff/entry` uses it |
| Navigation | Grouped catalog (`hq-modern/catalog.ts`) | Ad-hoc link rows that differ per page; some link to `/auth/login` as "Sign in" from inside the app |
| Interface mode | View switch (presentation) | Each page loads/saves the verified `interface-theme` preference itself; `school-entry` uses a different local `'big'` id |
| Styling | 56 KB module, HON visual identity | ~60 CSS modules with their own palettes, plus a 31 KB minified `globals.css` from the old foundation shell |
| Copy | Product voice | Security-engineering voice in the main content ("IDs below select a school; they never grant access…") |
| Language | `t()/text()` throughout | Mixed: many pages English-only |

Result the owner observed: features work, but the app does not feel like one product.

## 2. Goals

1. **One school app shell** for every `/staff/*` route, visually aligned with HQ, with the same three interface modes and three languages.
2. **No UUID typing in normal use.** The shell resolves the current school through the existing verified flow and offers a named school switcher; manual IDs survive only as a recovery path inside the affected workbench.
3. **One token set and a small primitive kit** (page header, section/card, state panels, buttons, fields, data list/table, status chip) used by every new or migrated screen.
4. **Operational Ask HON** inside the shell: persisted conversations, HON replies (C2), specialist delegation (C1: Marcus, Claire, Chad), human approval hand-off to the Action Center, truthful unavailable states.
5. Progressive migration: workbenches move into the system area by area, each in a small PR, with no behavior or authorization change.

### Non-goals
- No backend authority, RLS, payment, entitlement or AI-budget change in U-PRs. Backend work for conversation (C2) belongs to the backend thread.
- No new sample data on authenticated routes. Reference/sample pages stay under `/reference/*` behind their existing flag.
- No visual rebrand of HQ; HQ adopts the shared tokens later without changing its look.

## 3. Invariants (security and truthfulness — every U-PR must keep these)

- **Presentation never grants authority.** Shell school context is a navigation selector held in mounted memory (existing `SchoolEntryController` semantics). Every API still authorizes the exact school server-side.
- Selector links only carry the existing closed `?organizationId&schoolId` prefill produced by `schoolWorkflowLinks`-style builders from a verified selection; never record IDs, tokens or commands.
- **Concealment preserved:** on `HON_SESSION_INVALIDATED_EVENT`, `HON_SCHOOL_CONTEXT_CHANGED_EVENT`, `pagehide` and hidden visibility, the shell hides school names and disables school-scoped nav exactly as `/staff/entry` does today.
- `StaffLayout` keeps calling `requireVerifiedWebSession()` **before** rendering anything; a rejected session still renders nothing.
- No cached, sample, inferred or zero-filled numbers. Unavailable facts say "unavailable".
- AI: no fake answers. When readiness says a capability is off (`honReply: false`, specialist not ready, `CONFIGURATION_REQUIRED`, `HON_AI_SPEND_REFUSED`), the UI explains why and offers the conventional path. No client-side provider calls, no client-chosen budgets.
- Customer-entered content is never passed through `text()` translation.
- Mode and language are presentation only; they never change data, permissions or actions.

## 4. Design language

Dark-first, matching the HQ identity the owner already approved (navy depth, HON blue/teal glow, crisp white type), but calmer in the school app because staff work in it all day.

### 4.1 Tokens (`packages/design-system/src/tokens.css`, exported as `@hon/design-system/tokens.css`)

All values are CSS custom properties on `[data-hon-ui]`, with mode overrides on `[data-hon-mode="modern|classic|big-button"]`.

| Group | Tokens |
|---|---|
| Surface | `--hon-bg`, `--hon-bg-raised`, `--hon-surface`, `--hon-surface-2`, `--hon-border`, `--hon-border-strong` |
| Text | `--hon-text`, `--hon-text-muted`, `--hon-text-subtle`, `--hon-text-inverse` |
| Brand | `--hon-accent` (HON blue), `--hon-accent-2` (teal), `--hon-accent-contrast`, `--hon-glow` |
| Status | `--hon-success`, `--hon-warning`, `--hon-danger`, `--hon-info` (+ `-soft` backgrounds) — AA contrast on `--hon-surface` |
| Type | `--hon-font-sans` (Inter), `--hon-font-display` (Plus Jakarta Sans), `--hon-font-mono`; scale `--hon-text-xs…3xl` |
| Space/shape | `--hon-space-1…8` (4px base), `--hon-radius-sm/md/lg`, `--hon-shadow-1/2` |
| Density | `--hon-control-h` (Modern 40px, Classic 32px, Big Button 52px), `--hon-row-h`, `--hon-gap` |
| Motion | `--hon-ease`, `--hon-dur`; zero under `prefers-reduced-motion` |

### 4.2 Modes (one product, three presentations)
- **Modern HON** (default): balanced density, rail nav, cards with soft glow headers.
- **Classic CRM**: same structure, compact rows/controls, table-first lists, smaller type scale, more columns visible.
- **Big Button / Phone**: 52px+ targets, larger type, single column, bottom nav on all widths ≤ 900px and a reduced primary nav.

Mode id in the DOM is the contract id (`modern | classic | big-button`). The legacy local `'big'` id in school-entry is mapped, not duplicated.

### 4.3 Responsive
- ≥ 1100px: fixed left rail (248px; Classic 220px) + content (max 1280px) + optional HON side panel (380px).
- 700–1099px: collapsible rail (drawer) + top bar.
- < 700px: top bar + bottom nav (Today · HON · Leads · Schedule · More); HON panel becomes a full-screen sheet.
- 16px minimum side gutter; no horizontal page scroll at 360px.

### 4.4 Accessibility
Skip link; landmarks (`nav`, `main`, `aside`); `aria-current="page"`; drawer as `<dialog>` with focus return; visible focus ring token; status messages in `role="status"`; WCAG AA contrast for text and controls; Korean and Spanish strings must fit (no fixed-width labels).

## 5. School app shell (`SchoolShell`)

Mounted by `app/staff/layout.tsx` after `requireVerifiedWebSession()`, wrapping `children`.

### 5.1 Regions
- **Rail**: HON brand lockup → school switcher → grouped navigation → footer (account status, language & region, sign out).
- **Top bar**: page title from the nav catalog, breadcrumb group, mode switch (presentation, persisted through the existing verified `interface-theme` endpoint when a school is verified; local-only otherwise), language select (existing `LocaleUtility` behavior moved into the bar), Ask HON button.
- **Main**: `id="hon-main"`, workbench content unchanged in U1.
- **HON panel** (U3): right side panel / mobile sheet.

### 5.2 Navigation catalog (`school-shell/catalog.ts`, closed, typed)
Follows the owner blueprint (2026-11-06, section 9), which supersedes the reference image's flat 13-item rail. Each area owns existing routes only; the first route is where it lands, the rest appear as in-section tabs. Areas with no connected page yet (Connections) are **not** shown until one exists. Referrals & Rewards (after Marketing) lands on the Champions Club page.

| Area | Routes it owns |
|---|---|
| Home | `/staff/dashboard`, `/staff/command-center` |
| HON Assistant | `/staff/hon`, `/staff/action-center/approvals`, `/staff/ai-work` |
| AI Team | Chad `/staff/leads/assistant`, Marcus `/staff/marketing/assistant`, Kai `/staff/teaching-assistant`, `/staff/teaching-studio` |
| CRM & Sales | `/staff/crm/leads`, `/staff/crm/journey`, `/staff/crm/follow-ups`, `/staff/crm/trials`, `/staff/crm/lead-memberships`, `/staff/migration/leads` |
| Students & Families | `/staff/search`, `/staff/family-access`, `/staff/students/achievements`, `/staff/retention/review` |
| Memberships & Billing | `/staff/billing/memberships`, `/staff/billing/membership-plans`, `/staff/billing/membership-dates`, `/staff/billing/renewals`, `/staff/billing/invoices` |
| Classes & Schedule | `/staff/schedule/sessions`, `/staff/schedule/bookings`, `/staff/classpass`, `/staff/kiosk` |
| Attendance & Curriculum | `/staff/attendance`, `/staff/attendance/planned-absences`, `/staff/curriculum/library`, `/staff/curriculum/progress`, `/staff/testing/*` |
| Marketing | `/staff/marketing/campaigns`, `/staff/marketing/forms`, `/staff/marketing/intake` |
| Community | `/community`, `/community/marketplace` |
| Business Analytics | `/staff/health-score`, `/staff/planning/revenue` |
| Staff & Operations | `/staff/work`, `/staff/automation/rules`, `/staff/team/invitations`, `/staff/roles`, `/staff/team/availability`, `/staff/instructor-qualifications`, `/staff/documents`, `/staff/voice` |
| Settings | `/staff/account-status`, `/staff/subscription`, `/staff/launch`, `/settings/language-region` |

Teaching-only staff get a reduced Kai/curriculum/class navigation once the backend exposes a capability read for it (presentation only; the APIs keep enforcing permissions).

Each item: `{ key, href, titleKey, icon, group, scoped: boolean }`. `scoped` items get the verified prefill appended; unscoped items never do. The catalog is the single source for page titles in the top bar and mobile labels. A test enforces every catalog href resolves to an existing `page.tsx` and every `/staff/*` page is either in the catalog or explicitly listed as a detail/sub-route.

### 5.3 School context
- Reuses `SchoolEntryController` (identity → current → choices → verifySchool → identity) unchanged.
- States: `LOADING` (skeleton names), `READY` (school name + switcher), `CHOICE` (switcher opens with named choices), `DENIED/UNAVAILABLE` (nav limited to unscoped items + clear message), `SESSION/IDENTITY` (shell shows sign-in prompt; nothing private rendered), `CONCEALED` (names hidden, "Show school" restores).
- The shell exposes `useSchoolShell()` → `{ selection | null, revision, canNavigate() }` so migrated workbenches can start from the verified selection instead of UUID inputs (U2+). Workbenches that are not migrated keep working exactly as today.

## 6. Primitive kit (`components/ui/`)

`PageHeader` (eyebrow, title, description, actions), `Section`, `Card`, `StatTile` (value | "Unavailable"), `StatusChip` (closed status → token color + text label, never color alone), `Button` (primary/secondary/ghost/danger; loading state), `Field` (label, hint, error, required), `DataList`/`DataTable` (Classic renders as table), `StatePanel` (`loading | empty | unavailable | denied | error | signed-out`, each with plain-language default copy and an optional action), `ProtectionNote` (collapsible "How HON protects this" replacing inline security paragraphs), `Icon` (shared with HQ icon set).

All primitives are server-component-safe unless interactive, styled only through tokens, and localized via `useLocale()`.

## 7. Ask HON experience (U3, integrates C1 + C2)

- Surfaces: shell side panel (contextual: knows the current page title, not its data) and full workspace `/staff/hon` (conversation list + thread).
- Data: `GET .../hon/readiness`, conversation list/read, `POST .../hon/conversations`, `POST .../turns` with `{ text, delegation: null }` (question to HON) or a C1 delegation (Marcus campaign / Claire curriculum / Chad lead follow-up). Exact paths and payloads come from `packages/contracts/src/hon-conversation.ts`; the UI never invents fields.
- Rendering: human turn → HON turn (`role: 'hon'`, `text` only when `COMPLETED`; PROCESSING shows progress; FAILED shows the reason; UNKNOWN says the result is being checked and is never resent) → delegated specialist turns with links to the resulting Action Center approval (`actionRequestIds`).
- Unavailable: `honReply: false` disables the question box and explains why (not configured, paused by HQ, budget, permission). Delegation buttons follow per-agent readiness. Error codes `HON_AI_SPEND_REFUSED(reason)`, `HON_REPLY_PERSISTENCE_UNKNOWN` have dedicated copy.
- Retry: each send uses one client-generated idempotency key per attempt (existing pattern); replay after network loss re-sends the same key, never a new one.
- History persists server-side; reload shows the same thread.
- Kai (teaching) and the seven management agents keep the identities from #73/#76; portraits by mode as already approved.
- Supersedes PR #78's frontend (its gating and copy rules are carried over; #78 is closed only with owner approval).

## 8. Localization
Every shell, primitive and Ask HON string is a `TranslationKey` with en/ko/es entries in a new `packages/design-system/src/localization/shell.ts` (merged into the catalogs like `zernio.ts`). A test asserts ko/es completeness for the shell keys.

## 9. Acceptance per PR
- Unit tests first (vitest) for catalog integrity, shell states/concealment, selector prefill, primitive rendering per mode, translations.
- `pnpm --filter @hon/web test`, `pnpm check`, `pnpm build`, `git diff --check` with actual results.
- Browser screenshots (Playwright) at 390 / 834 / 1440 for each mode, attached to the PR.
- Existing route tests updated only where the layout now wraps children; their security assertions (session rejection renders nothing) are kept.

## 10. Owner visual reference (2026-11-06) and how it maps to real data

Reference: [assets/hon-ui-owner-reference.png](assets/hon-ui-owner-reference.png). Owner instruction: "make it closer to this, functioning, with all the integrity of the current build concept". The reference is the target **look and layout** for Modern mode; every number must come from an existing API, and any panel without a real source shows an honest unavailable state (never the reference's sample numbers).

| Reference element | Real source on main | U-PR |
|---|---|---|
| Left rail | Superseded by the blueprint areas in section 5.2 (same look: dark rail, bright active pill) | U1 |
| School switcher card ("Sunrise Taekwondo / School Dashboard") | `SchoolEntryController` verified selection + reporting-school choice names | U1 |
| Plan badge ("COMPLETE") | School HON billing / access-standing read (`/v1/schools/:schoolId/access-standing`); shown only when verified | U2 |
| Platform View switch Big-Button / Modern / Classic | Existing verified `interface-theme` preference | U1 |
| Greeting, date/time, school name | Session display name if the identity read provides one, locale date formatting | U1 |
| HON core + AI team cards with status and one action each | AI team readiness (0198, `AiTeamReadinessService`), canonical roster from `hon-command/roster.ts`; action buttons are **navigation** to the specialist's existing workbench | U2 |
| "How can I help today?" bar + suggestion chips | Ask HON (C1/C2); chips prefill the composer only, never send | U3 |
| KPI tiles: New leads, Trial signups, Enrollments, Active students, Attendance rate, MRR | Command center facts: `newLeads24h`, `upcomingTrials24h`, `pendingActionApprovals`, `outstandingWorkItems`, `membershipTermsEnding30d`, `paidInvoicesCreated30d` (labelled "Paid invoices", never "revenue"). Attendance rate, conversion and revenue are `UNAVAILABLE` in the contract today: tiles say so. No sparklines or % deltas until a backend trend series exists | U2 |
| Funnel, Marketing performance, Student progress, Memberships donut | No aggregate endpoints yet. Shown as "Not connected yet" panels with the conventional link. Backend aggregates are a follow-up for the backend thread (listed in the build plan), not faked | U2 + backend follow-up |
| Recent leads | `crm-leads-http` list read (names shown only to staff already authorized by that endpoint) | U2 |
| Today's schedule | `class-sessions-read-http` | U2 |
| Alerts & approvals | `action-approvals-http` pending list | U2 |
| My tasks | `work-items-http` | U2 |
| Search, help, notifications, avatar | Search → `/staff/search`; notifications count = pending approvals fact; avatar → account | U1/U2 |

**Agent identities (owner blueprint 2026-11-06, final):** HON is the central assistant (not an agent card among the seven). Kai is Teaching & Curriculum. The seven business specialists are Alex, Chad, Maya, Marcus, Jordan, Claire (Business Performance only) and Lena. HQ has its own team: Chase, Mia, Ethan, Olivia, Ryan, Sophia. The reference image's "Claire Teaching AI", "Retention AI" and "Command Center" agent cards are dropped.

## 11. Owner decisions (none block U1)
1. Close PR #78 once U3 lands (recommended), or keep it as reference.
2. Whether non-management staff see the Ask HON button (current backend gate decides access either way; this is presentation).
3. Light theme for daytime front-desk use (proposed later, token-ready).
