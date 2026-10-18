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
| Claude Code | Classic School Dashboard proof (owner-approved 2026-10-18; isolated, reference-only) | `ccr-c2933356-uza21g` · tracking issue #2 | `apps/web/src/app/reference/classic-dashboard/**`, `apps/web/src/components/classic-dashboard/**`, `apps/web/test/classic-dashboard-reference.test.tsx`, `docs/visuals/experiments/claude/classic-dashboard/**`; shared append: one `/reference/classic-dashboard` entry in `apps/web/public/manus-routes.json` | 2026-10-18 |

## Explicitly NOT claimed by Claude (Manus continues)

Claude does **not** edit the protected shared visual files listed in `docs/architecture/VISUAL_COLLABORATION_PROTOCOL.md` / `VISUAL_ASSET_INVENTORY_2026-10-17.md` (including `hon-reference-suite.*`, `hon-control-shell.*`, `layout.tsx`, `globals.css`, `interface-theme-*`, `app.config.ts`, `public/ai/**`). Any future promotion of approved Claude work into those files needs a separate owner-approved plan.

`apps/api/**`, `packages/{database,contracts,domain,auth,config}/**`, `apps/web/src/app/globals.css`, all live `/staff/*`, `/hq/*` (except `/hq/reference/**`), `/parent/*` pages and their components, `apps/web/src/components/pricing-reference.tsx`, `apps/web/src/components/interface-theme-picker.tsx`, existing approved assets in `apps/web/public/ai/`.

## Planned (not yet claimed)

- Claude Task 2: CI workflow (`.github/workflows/**`) + disposable local Postgres harness.
- Claude Task 3: HON Champions Club referral foundation (paths to be listed and approved before work starts).
