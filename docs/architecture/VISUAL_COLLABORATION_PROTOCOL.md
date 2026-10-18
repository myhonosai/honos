# HON Visual Collaboration Protocol

**Status:** Active while Claude Code explores experimental visual designs and alternative AI employee portraits.

## Objective

Preserve all existing HON OS branding, original portraits, hosted visual references, approved three-mode presentation behavior, and locked AI identity mappings while allowing comparison-quality experiments on a separate GitHub branch and in separate asset folders.

This protocol governs coordination only. It does not authorize a production deployment, provider call, payment action, content delivery, model configuration, or application behavior change.

## Ownership and branch boundaries

| Workstream | Branch / folder rule | Merge rule |
| --- | --- | --- |
| Existing approved HON assets and presentation | `main` protected originals | Do not replace/remap/delete during the experiment. |
| Claude visual exploration | Claude-owned GitHub branch | Keep all experimental source and assets isolated. Do not merge into `main` without owner comparison and explicit approval. |
| Manus functional development | `main` or focused nonvisual branch | Continue only in nonvisual areas while shared visual files are frozen. |

Recommended experimental folders:

```text
apps/web/public/experiments/claude/<experiment-slug>/
docs/visuals/experiments/claude/<experiment-slug>/
```

Experiment folders must include a `README.md` that identifies the source branch, purpose, changed files, assets, and whether the design is approved, rejected, or pending review.

## Protected assets and shared components

The exact current protected inventory is [`VISUAL_ASSET_INVENTORY_2026-10-17.md`](VISUAL_ASSET_INVENTORY_2026-10-17.md). Until the owner approves a comparison outcome, agents must not modify, replace, regenerate, move, delete, or remap:

- The durable HON platform logo and HON mark references.
- `apps/web/public/ai/**` local original portrait files.
- Active Manus-hosted Realistic, Modern Anime, and Chibi portrait URLs/mappings.
- HQ visual concept references under `docs/visuals/hq-concepts/`.
- Shared visual composition and appearance files listed in the inventory.

The live school roster remains Alex, Chad, Maya, Marcus, Jordan, Claire, and Lena. Eian remains the parent/family guide. HQ executive presentation stays separate. An experimental portrait must not alter an identity, authority, model route, tools, cost, memory, history, work state, or tenant scope.

## Coordination before shared visual edits

A shared visual edit requires all of the following before implementation:

1. Identify the original asset/source mapping in the inventory.
2. Name the exact shared file(s) that would change and the reason the experiment cannot stay isolated.
3. Preserve the original source and its reference mapping unchanged until owner approval.
4. Compare the candidate against the approved visual direction, three presentation modes, responsive behavior, accessibility, and truthful-state rules.
5. Obtain explicit owner approval for promotion from experiment to shared product source.
6. Make the promotion as a focused, reviewable commit with tests and no functional authority change.

No agent should opportunistically “clean up” a shared visual component during this period.

## Permitted nonvisual development

The following can continue without blocking Claude’s visual exploration, provided no protected shared visual source changes:

- API, domain, database/RLS, contracts, audit/outbox/idempotency, authorization, conventional workflow, and focused nonvisual test work.
- Documentation that records an actual operating boundary or inventory.
- New isolated functional route/component work that does not import or restyle the protected visual-reference components.

If a functional change would require a shared visual control, placeholder, global style, brand mark, agent portrait, or appearance component edit, pause that visual portion and coordinate first.

## Presentation mode and avatar requirements

- Keep Big-Button / Phone, Modern HON, and Classic CRM visible and accessible; they are presentation-only.
- Keep Realistic 3D, Modern Anime, and Chibi available in the relevant AI Team/Command Center reference surfaces; they are presentation-only.
- Preserve compact appearance controls below School/Location where implemented; do not remove them or turn them into a modal/pop-up.
- Preserve responsive behavior: no horizontal overflow, keyboard access, selection states, and reduced-motion support.
- Browser-local reference appearance storage is separate from scoped server preference persistence. Never bridge it into HQ/family/school authority or preference data.

## Review handoff for Claude experiments

When Claude completes an experiment, its branch should provide:

1. A comparison README naming every new/changed asset and source file.
2. A side-by-side summary against the protected original asset IDs/paths.
3. Screenshots or a preview route showing desktop and mobile behavior.
4. Explicit confirmation that no original asset or shared mapping was overwritten.
5. Exact test/build evidence.
6. A clear recommendation: **approve**, **reject**, or **needs owner review**.

Only the owner chooses which candidate, if any, replaces an approved original.

## Nonfunctional safety reminder

A visual experiment cannot introduce a provider, paid API call, actual AI employee action, payment, message, deployment, fake metric, fake activity, model change, customer-data access, or entitlement change. Visual concepts are never authority.
