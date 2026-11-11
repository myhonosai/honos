# HQ executive stage: card alignment and chibi portraits

Owner request (David, 2026-11-11): the six executive cards around HON on the HQ overview "are not lined up well", and the chibi art should be "better or closer to what we had".

## Spec

1. All six cards share one top edge, one height, one name row and one Workspace button row at every breakpoint (desktop, tablet, phone).
2. No per-card vertical offset or 3D turn on the stage.
3. Chibi portraits show each executive's whole face, centred, in the circular style of the approved chibi concept (`public/hq-assets/approved-chibi.png`, "HQ executive team" row).
4. Realistic portraits and the anime fallback are unchanged.
5. Frontend only. No API, data, permission or business-state change.

## Plan

- CSS: remove the `nth-child` lift/turn offsets; give the role and responsibility lines fixed two-line boxes (clamped) and keep names on one line, so card height is identical; pin the Workspace button to the card bottom.
- Assets: one centred crop per executive from the approved chibi concept, redrawn at high resolution with Higgsfield (crop as reference, same character and style; owner-authorized 2026-11-11), saved as `public/hq-assets/chibi/<executiveKey>.webp` (512 px, circular alpha). Replaces the sprite offsets, which had drifted (Ryan and Sophia were cut off).
- `ExecutivePortrait` takes `executiveKey` and uses the per-executive file when the chibi style is selected.
- Tests: `apps/web/test/hq-command-stage-layout.test.tsx` (portrait source per executive, files exist, realistic unchanged, no offsets, fixed text boxes, pinned button). Browser measurement of card boxes at 1920/1440/1024/390.
