# Codex HQ frontend implementation

Tracking: [#4](https://github.com/myhonosai/honos/issues/4). Branch: `codex/hq-modern-implementation`.

## Ownership and scope

Owner assignment of 2026-10-18 authorizes the approved HQ frontend, including the dashboard, responsive navigation, persistent assistant presentation, executive workspace entry points and planned management interfaces. Merge/deployment are not authorized.

Codex claims `apps/web/src/components/hq-modern/**`, new HQ-only route files, `apps/web/public/hq-assets/**`, `apps/web/test/hq-modern*`, and this document. Integration changes are limited to the existing HQ layout and HQ overview/executive route imports. The signed-session gate is preserved. The shared route manifest and TODO may receive append-only entries. Claude's PR #3, school CRM, protected shared visuals, existing HTTP clients, API, contracts, auth, database, RLS and Action Engine remain unchanged.

## Boundary

`/hq/*` retains `requireVerifiedWebSession()`. The client shell independently waits for the existing strict `loadHqOverview()` projection before rendering HQ content. Existing school-directory/provider pages retain independent backend authorization. Appearance and assistant controls are memory-only presentation, never permissions or cross-plane preferences.

No conversation or microphone service is invoked. A composer is an explicitly local, unsent draft; sending and microphone activation are disabled. Page context is a static allowlisted HQ route label, never query parameters, records, user data or authority. Executive workspace pages are bounded catalog presentations, not running agents.

Missing finance, usage, attention, support, referral and reward sources remain unavailable/planned. Contest lifecycle labels describe future workflow only and cannot launch, publish or award anything.

## Visual assets

Approved concept exports are copied unchanged into a new HQ-only asset folder. CSS viewports display the approved HON Core and portraits without modifying the source artwork or original school/HQ mappings. Realistic and Chibi source exports are available; Anime shows an explicit artwork-pending identity fallback until approved artwork exists. No paid provider or new image generation is used.

## Milestones

- [ ] Responsive foundation, dashboard, navigation and appearance controls.
- [ ] Persistent assistant and executive presentation workspaces.
- [ ] Existing HQ data integration and planned management surfaces.
- [ ] Functional/responsive/accessibility/regression evidence and review PR.

Validation results and screenshots will be added after execution; no successful checks are assumed.
