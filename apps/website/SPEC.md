# HON OS marketing website: spec and plan

Status: W1 (first slice). Not deployed. Owner approval is needed before any hosting is set up.

## Goal

A public marketing site for HON OS that tells a martial arts school owner what HON OS does, what it costs, and how to start, and that never claims more than the product does today.

Source of truth for every claim: `/mnt/project-files/website/HON_OS_WEBSITE_SUMMARY.md` (project file, checked against `main`). The visual design comes from David's "HON OS" design page made in a separate Claude session (dark "dojo floor" look, Volt accent).

## Scope of W1

- A static, single-page site in `apps/website` (plain HTML, CSS and a little JavaScript; no framework, no runtime dependencies).
- Sections: hero, "replaces" strip, run your school, AI team, get paid, grow, made for your team, pricing, inside HON HQ, FAQ, start, footer.
- Status labels on every feature that is not on `main`: "coming soon" or "soon". The AI team is shown as "launching with HON OS" / "at launch", because no real AI model is switched on.
- Pricing (owner-approved): HON OS $249/month or $2,097/year. Founder 50: $199.20/month or $1,494/year, kept while the school stays subscribed; a cancelled or lapsed founder school returns at the standard price. 14-day free trial, no automatic charge. 12,000 Creative Studio credits a month; top-ups $30/$60/$120. No HON fee on tuition.
- Calls to action: "Start a new school" links to the app's `/account/start`; "Sign in" links to the app's `/auth/login`. The app address is set at build time (`HON_WEBSITE_APP_URL`). Sign-up is switched off today, so the copy says sign-up opens at launch.
- No forms and no data collection. The design page's email box is removed (it went nowhere).
- Search engines are told not to index the site (`noindex`) unless the build sets `HON_WEBSITE_INDEXABLE=1`, so a preview can't be found before launch.

## Out of scope (later slices)

- Korean and Spanish versions of the site (W2).
- Privacy policy, terms and contact pages (need owner/legal text).
- Replacing the app's old `/pricing` page (Core $149 / Complete / lifetime). It must not be linked from the site.
- Hosting: a Render static site, only with David's OK. `render.yaml` is not changed in W1.
- Analytics, cookie banner, social links (no accounts named yet).

## Before going live

- David confirms the source and licence of the five photos (one shows a child) and they are recorded here.
- Self-host the fonts instead of loading them from Google Fonts.
- Online family tuition payments stay "coming soon" until family checkout is built.

## Must never appear (checked by tests)

- Old plans or prices: Core, Complete, Essential, $149, lifetime plans.
- 30-day money-back or refund terms, specific Champions Club prizes or free months, texting allowances, a HON payment processor, customer counts, "available now".
- Any `<form>` or email input.

## Plan

1. Tests first (`apps/website/test/*.test.mjs`, Node's built-in test runner): content rules above, every `#anchor` resolves, every image exists and has alt text, every link to the app goes to an allowed path through the build placeholder, the build substitutes the app address and the `noindex` guard.
2. Source: `src/index.html`, `src/styles.css`, `src/site.js`, `src/flow.js` (background animation, honours reduced motion), `src/assets/*.jpg`, `src/favicon.svg`.
3. Build: `scripts/build.mjs` copies `src` to `dist`, replaces `{{APP_URL}}` and `{{ROBOTS}}`, and refuses a non-http(s) app address.
4. Wire `build` and `test` scripts so the root `pnpm build` / `pnpm test` include the site.
5. Verify in a real browser at desktop and phone widths, then review and open the PR.
