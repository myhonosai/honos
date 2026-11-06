# HON OS Unified UI — Build Plan

Spec: [HON_UNIFIED_UI_SYSTEM_SPEC.md](HON_UNIFIED_UI_SYSTEM_SPEC.md). Each U-PR is small, draft first, TDD, independently reviewable by Manus, merged only with an owner card. No backend authority, migration, payment or AI-budget change in any U-PR.

| PR | Scope | Depends on | Key tests |
|---|---|---|---|
| **U1 Shell + tokens** | `@hon/design-system` tokens.css (3 modes); `components/ui/` first primitives (PageHeader, StatePanel, StatusChip, Icon); `components/school-shell/` (catalog, rail, top bar, school switcher via `SchoolEntryController`, mode switch, language, mobile bottom nav, drawer, concealment); `app/staff/layout.tsx` wraps children after the session gate; en/ko/es shell strings | main | catalog ↔ `page.tsx` integrity; every `/staff` page covered; scoped prefill only from verified selection; concealment on invalidation/school change/pagehide; layout still rejects before render; ko/es completeness; mode id mapping |
| **U2 Dashboard (reference look)** | New Modern dashboard on `/staff/dashboard`: greeting, HON core + canonical AI team cards (readiness), KPI tiles from command-center facts, Recent leads, Today's schedule, Alerts & approvals, My tasks; "Not connected yet" panels for funnel/marketing/progress/membership mix; Classic and Big Button variants | U1 | no sample numbers (UNAVAILABLE facts render as unavailable); each panel's loading/denied/empty states; links carry only verified prefill |
| **U3 Ask HON** | Shell side panel + `/staff/hon` workspace on C1/C2 contracts: list/read/create conversation, question turns, delegation turns, Action Center links, readiness gating, error codes, idempotent retry | U1, backend C2 PR | persisted thread render; PROCESSING/FAILED/UNKNOWN; honReply false disables composer with reason; replay reuses key; no client provider call |
| **U4 Leads + Trials** | Migrate CRM workbenches into PageHeader/tabs/primitives; start from shell selection (UUID form only as recovery) | U1 | existing CRM tests unchanged in behavior |
| **U5 Students + Attendance** | Same pattern | U1 | |
| **U6 Memberships + Billing** | Same pattern; payment/entitlement copy reviewed for truthfulness | U1 | |
| **U7 Marketing, Communications, Settings** | Same pattern | U1 | |
| **U8 Parent app + public pages** | Token adoption, Big Button default for families | U1 | |
| **U9 HQ token adoption** | HQ consumes shared tokens with no visual change | U1 | screenshot diff |

## Backend follow-ups surfaced by the reference (for the backend thread; not built in U-PRs)
1. Trend series for KPI sparklines/deltas (per-day counts for leads, trials).
2. Funnel aggregate (leads → trials → enrollments → active memberships) for a window.
3. Membership mix (active by plan cadence) and active-student count.
4. Attendance rate aggregate (contract currently says UNAVAILABLE).
5. Marketing performance (impressions, visits, cost per lead) — needs connector data; out of scope until a provider is approved.

## U1 task breakdown (TDD order)
1. Test: catalog integrity (hrefs exist, all staff pages covered, unique keys, titles are translation keys). Implement `school-shell/catalog.ts`.
2. Test: `scopedHref(item, selection)` appends prefill only for `scoped` items and only from a verified selection. Implement.
3. Test: ko/es contain every shell key. Implement `localization/shell.ts`.
4. Test: tokens.css defines every token for each mode. Implement tokens.css + export.
5. Test: `SchoolShell` renders nav + children; hides school name and disables scoped links on invalidation/school-change/pagehide; shows sign-in state on SESSION. Implement shell.
6. Test: `StaffLayout` rejects before rendering; on success returns the shell wrapping the exact child. Update the 7 route tests that asserted identity to assert the wrapped child instead (security assertion kept).
7. Primitives with render tests per mode.
8. `pnpm --filter @hon/web test`, `pnpm check`, `pnpm build`, `git diff --check`; Playwright screenshots 390/834/1440 × 3 modes.
