# Website design demos (preview only)

Two standalone design previews of the HON OS marketing site, made for David to compare before anything changes on the live site.

- `jeton/` Demo A, inspired by the Jeton site layout (on Mobbin): full-bleed brand-blue sections, big headlines, floating pill navigation, product shots in browser frames, scroll-animated photo cards.
- `editorial/` Demo B, inspired by the Creative Intelligence Report 2026 site (on Mobbin), rebuilt on 2026-11-19 as a scroll story (`story.js`): pinned scenes driven by scroll (star travel, a door-opening film scrubbed by scroll, words that surface, a sideways AI team, an app stage that changes per chapter). Reduced motion or no JS shows a normal page. The paintings (`shared/assets/story-*.webp`) and the door film (`story-door.mp4`, 1280px; `story-door-phone.mp4` for phones) were generated with Higgsfield at David's request (about 49 credits).
- `shared/` photos (same placeholders as the live site), real HON OS app screenshots from the project's UI test runs, AI team portraits from `apps/web/public/ai`, fonts (SIL OFL 1.1) and `demo.js` (pricing switch, reveal on scroll).

Both use the pricing section content from PR #510. Copy follows the live site's rules (no customer counts, no "available now", AI team "launches with HON OS").

These files are **not** part of the built site: `scripts/build.mjs` copies only `src/`. To view locally, use a static server that supports HTTP range requests (needed to scrub the door film), for example `npx http-server apps/website/demo -p 4180`, and open http://localhost:4180/.
- `editorial/loader.js` shows a loading screen with real progress: it downloads the fonts, first paintings and the whole door film into memory (instant scrubbing), then lifts; it gives up waiting after 12 seconds.
