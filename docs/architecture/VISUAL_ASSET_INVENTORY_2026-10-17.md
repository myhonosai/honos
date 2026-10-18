# HON Original Visual Asset Inventory — 2026-10-17

> **Purpose:** Preserve the established HON brand, approved visual direction, school AI portraits, HQ visual references, and hosted asset keys while experimental Claude designs remain isolated on a separate branch and in separate folders.
>
> **Scope:** This is an inventory of repository-tracked originals and active Manus-hosted asset references. It does **not** authorize replacing, regenerating, moving, deleting, or promoting any asset. It also does not imply that a visual asset is a live agent, operational fact, provider connection, or authority source.

## Preservation status

| Class | Status | Rule |
| --- | --- | --- |
| Original HON branding and marks | Protected | Do not replace, regenerate, rename, or re-point without owner review. |
| Local original school AI portraits | Protected | Keep their exact filenames and content. Do not use an experiment as a replacement. |
| Active Manus-hosted reference portraits | Protected | Do not change the storage keys or the locked style-to-identity mapping. |
| HQ concept visual frames | Protected concept assets | Keep as concept-only review material. Do not treat as production screens or standalone executive identities. |
| Claude experiments | Isolated | Keep on Claude’s branch and in a clearly experimental folder; never overwrite an original asset. |

## Recovery export branch

The asset-only branch `manus/asset-recovery-2026-10-17` exports 27 currently traceable hosted originals byte-for-byte under [`apps/web/public/hon-assets/original/`](../../apps/web/public/hon-assets/original/), including a manifest with source paths, dimensions, SHA-256 hashes and repository-local static web paths. It deliberately does not change any active application image mapping.

Four Modern Anime sources (Marcus, Jordan, Claire and Lena) currently resolve to a 498-byte SVG **image-generation-failed** placeholder rather than original artwork, so they are recorded as unavailable rather than copied or regenerated. No standalone original HQ executive portraits for Chase, Mia, Ethan, Olivia, Ryan or Sophia were located in the current GitHub or active Manus reference map; the exported HQ concept frames are not substitute portraits. See the recovery library `README.md` and `MANIFEST.json` for the full handoff once the branch is reviewed.

## A. HON marks and logos

| Asset | Hosting / path | Active usage | Preservation note |
| --- | --- | --- | --- |
| Platform logo | `https://files.manuscdn.com/user_upload_by_module/session_file/310519663481160157/TCCUimdKWZzQYzFR.webp` | Root `app.config.ts` `logoUrl` | Durable project branding metadata. Do not replace with a temporary URL, generated variation, or experimental logo. |
| HON app/fav icon and control-shell mark | `/manus-storage/async-images/V2i1yOxmOLQ5wsG9Ltutn8/image-1.webp` | `apps/web/src/app/layout.tsx`, `apps/web/src/components/hon-control-shell.tsx` | Current Manus-hosted HON mark reference. Preserve the source key and both uses. |

## B. Repository-local original school AI portraits

These WebP files are tracked in the repository under `apps/web/public/ai/`. They are original local assets, not disposable generated output.

| Identity | File | Dimensions | SHA-256 |
| --- | --- | ---: | --- |
| Alex | `apps/web/public/ai/alex.webp` | 208 × 262 | `be309a1a578f8a3d3b8a706cfb05f9bcb0fa5c53e096945a5cfdf00122a9b2ac` |
| Chad | `apps/web/public/ai/chad.webp` | 208 × 262 | `384db6992ec152f6b88535fd4c7fb48f18bd92ee98e4bea26a47078bb489331a` |
| Claire | `apps/web/public/ai/claire.webp` | 208 × 262 | `e0dc95442fe15d67a957549f039cff3169b7b6faed4c0406f19e5b53cb8f9d1a` |
| Eian | `apps/web/public/ai/eian.webp` | 205 × 305 | `fb3f265f9c7a806a57fdd1bfebbcaa9aec043e57521a789d175d231d51eb382c` |
| Jordan | `apps/web/public/ai/jordan.webp` | 208 × 262 | `c067f8ae7158768dcb501093fa3003359f19239424ee08b1ff35a79df2b162d6` |
| Lena | `apps/web/public/ai/lena.webp` | 180 × 262 | `bf7c6ab63f728c363efea099851dd80575b065e4768489273e63174b1dafcdf3` |
| Marcus | `apps/web/public/ai/marcus.webp` | 208 × 262 | `b7a355d57b47e91212de41385704b0ed431f76f83f2d64f5bc0cefc66ae19822` |
| Maya | `apps/web/public/ai/maya.webp` | 208 × 262 | `58316e05860c470495f770bd02a7eab147af2b6cbf821538fd480d8db0b98bd4` |

**Locked school roster:** Alex, Chad, Maya, Marcus, Jordan, Claire, and Lena. Eian is the separate parent/family guide asset. Visual style does not alter any identity, model route, tool access, authority, history, cost, or data scope.

## C. Active Manus-hosted school AI portrait mappings

The active Complete reference keeps a closed style-to-identity mapping in `apps/web/src/components/hon-reference-suite.tsx`. These are the current approved hosted keys; do not reassign them across identities.

### 3D Realistic

| Identity | Manus-hosted asset |
| --- | --- |
| Alex | `/manus-storage/async-images/2A936uk4BZyqyuLojpldTB/image-1.webp` |
| Chad | `/manus-storage/async-images/2A936uk4BZyqyuLojpldTB/image-2.webp` |
| Maya | `/manus-storage/async-images/2A936uk4BZyqyuLojpldTB/image-3.webp` |
| Marcus | `/manus-storage/async-images/2A936uk4BZyqyuLojpldTB/image-4.webp` |
| Jordan | `/manus-storage/async-images/2A936uk4BZyqyuLojpldTB/image-5.webp` |
| Claire | `/manus-storage/async-images/JPVSezGRSV3KDWymzcnHvA/image-1.webp` |
| Lena | `/manus-storage/async-images/JPVSezGRSV3KDWymzcnHvA/image-2.webp` |

### Modern Anime

| Identity | Manus-hosted asset |
| --- | --- |
| Alex | `/manus-storage/async-images/JPVSezGRSV3KDWymzcnHvA/image-3.webp` |
| Chad | `/manus-storage/async-images/JPVSezGRSV3KDWymzcnHvA/image-4.webp` |
| Maya | `/manus-storage/async-images/JPVSezGRSV3KDWymzcnHvA/image-5.webp` |
| Marcus | `/manus-storage/async-images/VluzKftrTvWQbFtDOK8WFX/image-1.webp` |
| Jordan | `/manus-storage/async-images/VluzKftrTvWQbFtDOK8WFX/image-2.webp` |
| Claire | `/manus-storage/async-images/VluzKftrTvWQbFtDOK8WFX/image-3.webp` |
| Lena | `/manus-storage/async-images/VluzKftrTvWQbFtDOK8WFX/image-4.webp` |

### Chibi

| Identity | Manus-hosted asset |
| --- | --- |
| Alex | `/manus-storage/async-images/2vTK4xHtWX1lReJNsEaWJa/image-1.webp` |
| Chad | `/manus-storage/async-images/2vTK4xHtWX1lReJNsEaWJa/image-2.webp` |
| Maya | `/manus-storage/async-images/2vTK4xHtWX1lReJNsEaWJa/image-3.webp` |
| Marcus | `/manus-storage/async-images/2vTK4xHtWX1lReJNsEaWJa/image-4.webp` |
| Jordan | `/manus-storage/async-images/2vTK4xHtWX1lReJNsEaWJa/image-5.webp` |
| Claire | `/manus-storage/async-images/8pSrWJ1PIWinTmSPGM3898/image-1.webp` |
| Lena | `/manus-storage/async-images/8pSrWJ1PIWinTmSPGM3898/image-2.webp` |

### Reference failure behavior

The reference surface may fall back to an initial/avatar tile if a hosted image fails to load. That fallback is presentation-only and is not a license to replace or regenerate the failed original. Resolve an asset issue by comparing this inventory and reviewing the hosted source first.

## D. HQ executive visuals

No standalone HQ executive portrait image files are currently tracked or referenced as active product assets. The authoritative HQ executive roster is a code-owned, fixed presentation catalog, deliberately separate from the school AI roster and not a live agent/provider/portrait directory.

The following Manus-hosted concept frames are preserved as **HQ visual review material** only:

| Concept group | Assets | Source |
| --- | --- | --- |
| HQ overview, executive hierarchy, HON Core, school directory concepts | `/manus-storage/async-images/6gLPUZdRkOzRWPjIGKpHDV/image-1.webp` through `image-5.webp` | `docs/visuals/hq-concepts/README.md` |
| HQ school-detail, HQ mobile, HON Core mobile concepts | `/manus-storage/async-images/P9JSV0UA3irhj1K12U7CS5/image-1.webp` through `image-3.webp` | `docs/visuals/hq-concepts/README.md` |

These images must not be extracted into production portrait mappings, used as evidence of HQ work or metrics, or replaced with experimental alternatives without owner review.

## E. Protected shared visual source files

While Claude’s visual exploration is active, treat the following as shared/protected. No agent should edit them without coordination and an explicit comparison plan:

```text
app.config.ts
apps/web/src/app/layout.tsx
apps/web/src/app/globals.css
apps/web/src/components/hon-reference-suite.tsx
apps/web/src/components/hon-reference-suite.module.css
apps/web/src/components/hon-control-shell.tsx
apps/web/src/components/hon-control-shell.module.css
apps/web/src/components/interface-theme-picker.tsx
apps/web/src/components/interface-theme-preference.ts
apps/web/public/ai/**
docs/visuals/hq-concepts/**
```

This does not freeze nonvisual domain/API/database development. It does freeze shared visual-source edits, branding asset replacement, portrait remapping, and asset deletion while alternatives are being reviewed.

## F. Inventory limitations

Manus project storage does not provide a repository-visible global listing API in this workspace. This inventory therefore records every **current repository-traced active Manus-hosted asset reference** plus all tracked local portrait files. If a new original hosted asset is discovered outside these references, append it here before any comparison or replacement discussion.
