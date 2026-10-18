# HQ visual reference refinement

Branch: `codex/hq-modern-implementation`. Review: [PR #8](https://github.com/myhonosai/honos/pull/8). Status: **implementation in progress; owner visual approval pending**.

The owner supplied `9075.jpg` as a closer visual target after reviewing the first running HQ implementation. This iteration adapts its panoramic command-room setting, portrait-led glass cards, central glowing HON and compact performance tiles to **HON HQ**. It does not copy the reference's school navigation, school employee identities, sample metrics, dates, readiness badges or company/customer names.

The six HQ executives and approved portrait/orb sources are retained. New decorative artwork is isolated under `apps/web/public/hq-assets/reference-refinement/`, with its own source/approval notes. Existing approved files and the [previous real screenshots](../hq-modern/README.md) are preserved for comparison.

Desktop places three executives on each side of HON, a real local-draft composer below, six company tiles and compact attention/company/growth panels. Mobile keeps HON and key actions ahead of the operational panels and executive grid. All appearance choices, executive entry points and persistent subpage assistant remain available.

Current main `75f3a81` has been incorporated without changing Claude's Champions Club code or contracts. M1 referral recordkeeping now exists upstream; this **visual-only refinement** does not integrate those new endpoints or activate rewards. Existing explicit pending/unavailable states remain until a separate bounded frontend integration.

Actual screenshots and test results will be added after the real application build/browser run. The earlier 36-check passing report applies to the prior layout, not automatically to this revision. No merge, deployment or live service activation is authorized.
