# HQ Creative designs (0678)

Owner decision, David, 2026-11-24 08:50Z, on the card "Bring the free flyer and poster editor to HQ Creative now?": **"Yes, add the editor to HQ"**.

## What it is

The school Creative Studio design editor (0617, `docs/architecture/CREATIVE_DESIGN_EDITOR.md`) made available to HON HQ for
HON's own marketing of HON OS: flyers, posters, postcards, social posts and event covers, from blank or a template, with
photos, QR codes and a print PDF. Page: `/hq/marketing/creative/designs`, linked from HQ Creative Studio.

Nothing here costs anything, uses AI, sends, posts or publishes. It is independent of the HQ AI image/video requests (0253),
which stay off until a provider, file storage and owner approval exist.

## Boundary

| Layer | What |
|---|---|
| Database | `hon.hq_creative_designs`, `hon.hq_creative_design_photos`, `hon.hq_creative_design_requests`: no organization or school column, forced RLS, no policies, no runtime table privilege. Six definer entry points only. |
| Who | `hon.require_hq_marketing_actor` (0252): read = HQ owner or `hq.marketing.read`/`manage`; change = HQ owner or `hq.marketing.manage`. Re-proved before each return. No school role reaches HQ designs; an HQ design can never place a school photo. |
| Rules | Reused unchanged from 0617: document shape, sizes, names, clean photos (metadata stripped by the API first, refused by the table if any remains). Caps: 200 active / 1,000 designs, 300 photos / 150,000,000 photo bytes. |
| Changes | Never deleted; exact expected version; archive/restore are their own command; an archived design is restored before it changes; unique active names (case-insensitive). |
| Commands | `hq-creative-design-save`, `hq-creative-design-status`, `hq-creative-design-photo` through `SaasCommandGuard` (same-origin human command, UUID `Idempotency-Key`). Same key + same body replays the stored receipt; same key + other body is refused. |
| API | `apps/api/src/hq-creative/hq-creative-designs.{controller,service}.ts`, route `hq/marketing/creative/designs`. Answers are checked with the same `@hon/contracts` verifiers as the school editor. |
| Web | The school editor (`apps/web/src/components/design-editor/`) with a fixed HQ scope, HQ wording (`words.ts`) and the HON brand kit (HON OS blue `#1F6BFF`, `myhonos.com`). `apps/web/src/components/hq-creative/hq-designs.tsx`. |

## Evidence

- DB proof `packages/database/scripts/test-hq-creative-designs.mjs` (in `run-db-proofs.sh`).
- API `apps/api/test/hq-creative-designs.test.cjs`; web `apps/web/test/hq-designs.test.tsx`.

## Later (not built)

HON-specific templates (today the school templates are offered as starting layouts), AI writing and pictures (credits, owner
approval), sending a design to HQ social posts once HQ posting exists.
