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

## Environment recovery and publication

The terminal cannot reach its configured proxy (`curl (7)` at `proxy:8080`). React/Next/TypeScript/Vitest are absent and uncached. No lockfile or network controls were changed. All original source files were exported through the connected GitHub application and verified by Git blob SHA. The baseline tree exactly matches upstream `c0331df`; the working source tree is also checked against the published GitHub tree. Local snapshot commit IDs differ from upstream; published commits use the actual latest-main parent.

The branch includes main `22ef492` (owner-approved CI/docs). Implementation is reviewable in PR #8. Existing GitHub CI installs locked dependencies successfully; local browser previews still require terminal-network permission or environment repair. Earlier generated images are design references, not runtime screenshots.

## Temporary browser verification — owner authorized

The owner explicitly authorized `.github/workflows/hq-browser-verification.yml` to obtain real UI evidence using the existing GitHub Actions environment. It is limited to this repository's Codex HQ branch/PR, uses pinned checkout/setup/artifact actions and a read-only token, and never uses `pull_request_target`, secrets, deployments or production services. The established `ci.yml` remains unchanged.

The production web build runs only on localhost with a randomly signed disposable session and an allowlisted synthetic overview/directory server. Browser requests to external hosts and all browser WebSockets are blocked; send/microphone controls remain disabled. Screenshots prominently say `LOCAL TEST FIXTURE · NO LIVE DATA`. External fonts may use system fallbacks during this isolated run.

Pinned `playwright-core` and `axe-core` tools are installed under runner temp with lifecycle scripts disabled; the repository lockfile is unchanged, and the preinstalled Chrome is used without a browser download. The harness covers 1440px desktop, 834px tablet, 390px mobile and 320px narrow mobile, appearance controls, assistant focus/drafts, navigation, unavailable workspaces, contest non-execution, signed-session/denied/malformed responses, overflow and automated WCAG-tagged axe rules. Screenshots and a sanitized report are uploaded for **three days**; no traces, cookies, secrets or application logs are uploaded.

Remove the temporary workflow after owner visual sign-off. Automated accessibility checks supplement manual review and do not establish complete WCAG compliance.
