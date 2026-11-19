# Website design demos (preview only)

Two standalone design previews of the HON OS marketing site, made for David to compare before anything changes on the live site.

- `jeton/` Demo A, inspired by the Jeton site layout (on Mobbin): full-bleed brand-blue sections, big headlines, floating pill navigation, product shots in browser frames, scroll-animated photo cards.
- `editorial/` Demo B, inspired by the Creative Intelligence Report 2026 site (on Mobbin): night-green sky with sparkles, serif headlines, ticker, cream pages with data bars and portraits, giant wordmark footer.
- `shared/` photos (same placeholders as the live site), real HON OS app screenshots from the project's UI test runs, AI team portraits from `apps/web/public/ai`, fonts (SIL OFL 1.1) and `demo.js` (pricing switch, reveal on scroll).

Both use the pricing section content from PR #510. Copy follows the live site's rules (no customer counts, no "available now", AI team "launches with HON OS").

These files are **not** part of the built site: `scripts/build.mjs` copies only `src/`. To view locally: `python3 -m http.server 4180 --directory apps/website/demo` and open http://localhost:4180/.
