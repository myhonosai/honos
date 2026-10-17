# HON OS — Agent File Ownership Registry

**Purpose:** let Manus, Claude Code, Codex, and future engineers work in parallel without editing the same files. Check this file before starting a task; add a claim before editing; remove the claim when the PR merges or is abandoned.

## Rules

1. A claimed path may be edited **only** by the claiming agent until the claim is released.
2. Unclaimed paths follow normal collaboration rules (`AGENTS.md`, `docs/EXTERNAL_AGENT_HANDOFF.md`).
3. Shared append-only files (`TODO.md`, `apps/web/public/manus-routes.json` route manifest, architecture "Evidence references" lists): any agent may **append a new section/line**; do not rewrite another agent's section.
4. Claude and Codex work on a branch (`claude/<feature>`, `codex/<feature>`) and land through a reviewed PR. Neither pushes to `main`.
5. A claim never changes architecture, security, or authority rules. It only prevents edit collisions.

## Active claims

| Owner | Task | Branch / PR | Claimed paths | Since |
| --- | --- | --- | --- | --- |
| Claude Code | Task 1: visual system + reference screens (owner-approved; paused pending owner proof-screen review). Existing approved images are retained; no generated portrait/brand assets. | `ccr-c2933356-uza21g` (this session) | `apps/web/src/components/hon-reference-suite.tsx`, `apps/web/src/components/hon-reference-suite.module.css`, `apps/web/src/app/page.tsx`, `apps/web/src/app/core/page.tsx`, `apps/web/src/app/complete-mobile/page.tsx`, `apps/web/src/components/hon-ui/**`, `apps/web/src/app/hq/reference/**`, `packages/design-system/src/visual-tokens.ts`, `packages/design-system/src/index.ts` (**additive exports only**), `apps/web/src/app/layout.tsx` (icon line only), `apps/web/src/components/hon-control-shell.tsx` (logo line only), `apps/web/test/hon-reference-appearance.test.tsx`, `apps/web/test/hon-reference-portraits.test.tsx`, `apps/web/test/hon-ui-*.test.tsx` | 2026-10-17 |

## Explicitly NOT claimed by Claude (Manus continues)

`apps/api/**`, `packages/{database,contracts,domain,auth,config}/**`, `apps/web/src/app/globals.css`, all live `/staff/*`, `/hq/*` (except `/hq/reference/**`), `/parent/*` pages and their components, `apps/web/src/components/pricing-reference.tsx`, `apps/web/src/components/interface-theme-picker.tsx`, existing approved assets in `apps/web/public/ai/`.

## Planned (not yet claimed)

- Claude Task 2: CI workflow (`.github/workflows/**`) + disposable local Postgres harness.
- Claude Task 3: HON Champions Club referral foundation (paths to be listed and approved before work starts).
