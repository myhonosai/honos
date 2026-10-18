# HON HQ — transparent command-center surfaces

Branch: `codex/hq-modern-implementation`. PR: [#8](https://github.com/myhonosai/honos/pull/8). Tracking: [#4](https://github.com/myhonosai/honos/issues/4). **Implemented; owner visual approval remains pending.**

## Real application captures

These are screenshots of application source **`21ab801a8e09089caede061b3b2818cb3a6e1210`**, running the actual production web build on localhost in GitHub Actions. They are not generated concept images. Each capture is labeled **LOCAL TEST FIXTURE · NO LIVE DATA**.

- [Desktop, 1440px wide](desktop.jpg)
- [Mobile viewport, 390 × 844](mobile.jpg)
- [Full mobile page](mobile-full.jpg)
- [Sanitized browser report](browser-report.json)
- [All 18 original PNG captures and report](https://github.com/myhonosai/honos/actions/runs/39109249127/artifacts/12129159822) — private Actions artifact with three-day retention.

The fixed phone navigation appears at the original viewport position in the full-page capture. Use the separate viewport image to assess the initial mobile screen.

## Latest owner clarification

The existing command-center background is restored unchanged. Executive frames now use very low-opacity glass with restrained blur, allowing the scene to show through. A soft CSS edge mask blends portrait crops into the scene; original portrait/orb source files remain untouched.

The owner explicitly confirmed that the speaking panel should **overlap the lower front of HON**, like the supplied `9078.jpg` close-up. The caption, conversation entry and explicit unavailable state now share an attached translucent dock over the orb's lower edge. Tablet/mobile retain a compact inline HON entry and the existing expanded assistant interface.

Jarvis-inspired orbital detail and motion pause/reduced-motion controls remain. Stable screenshots use reduced motion. The decorative glow/orbits do not indicate a live connection, listening, health or completed AI work.

Mobile keeps compact HON, command shortcuts, attention priority and readable two-column executive cards. HQ remains the company control plane; no school CRM labels, identities, metrics or routes were imported from the reference.

## Actual verification

[Browser run 39109249127](https://github.com/myhonosai/honos/actions/runs/39109249127) passed **37 checks, zero failures**, produced **18 PNG captures**, and reported **zero violations across eight axe scans**.

- 1440 × 1000 desktop, 834 × 1112 tablet, 390 × 844 mobile and 320 × 800 narrow mobile.
- Desktop dock overlap/centering and restored background URL explicitly asserted.
- Modern, Big Button and Classic layout bounds; six executive workspace controls; Realistic/Chibi and truthful Anime-pending presentation.
- Navigation, executive entry points, assistant expansion/minimize/restore, local draft retention, focus trapping/return, Escape and mobile body scrolling.
- Motion pause/keyboard restore and live reduced-motion preference changes.
- Existing signed-session gate, strict overview authorization, anonymous/401/403/503/malformed fail-closed states.
- No page JavaScript errors or fixture API mutations; conversation/microphone/consequential controls remain unavailable.
- Visual inspection of the desktop, mobile viewport and full mobile captures completed after the run.

[Normal CI 39109249179](https://github.com/myhonosai/honos/actions/runs/39109249179) passed **both jobs**: tests/typecheck/full application build/migration-file contract/clean tracked source, plus disposable-local PostgreSQL security proofs. This verifies the same application source as the captures. Web: 572 tests across 107 files; API: 387 tests; domain: 188 tests; auth: 91 tests. The migration-file check verified 149 existing files without applying anything to a shared database. Local harness syntax and `git diff --check` also pass.

## Boundaries and review limits

Only existing aggregate/directory capabilities are used. Revenue, AI costs, attention queues, conversation/voice, executive task activity and referral lifecycle actions remain unavailable/planned. Contest/reward operations cannot be activated here.

Fixtures are synthetic and local, served through the existing API contracts under disposable signed sessions. No customer data or production authorization bypass is used. Browser external traffic is blocked; fonts may use system fallbacks. Axe has one or two incomplete rules per scan; reported zero violations do not establish full accessibility conformance. Physical-device software keyboard, screen-reader and owner visual review remain pending.

Earlier [abstract](../hq-holographic/README.md), [room](../hq-reference-refinement/README.md) and [initial](../hq-modern/README.md) variants remain preserved. No new image generation, paid provider usage, backend modification, merge or deployment was performed. Remove the temporary browser-verification workflow after owner visual sign-off.
