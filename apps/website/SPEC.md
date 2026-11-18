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

- Privacy policy, terms and contact pages (need owner/legal text).
- Replacing the app's old `/pricing` page (Core $149 / Complete / lifetime). It must not be linked from the site.
- Hosting: a Render static site, only with David's OK. `render.yaml` is not changed in W1.
- Analytics, cookie banner, social links (no accounts named yet).

## Before going live

- David confirms the source and licence of the five photos (one shows a child) and they are recorded here.
- Online family tuition payments stay "coming soon" until family checkout is built.

## W2: Korean and Spanish, self-hosted fonts

- `/ko/` and `/es/` are generated at build time from the English page and `src/i18n/ko.json` / `es.json` (English phrase to translation). The build and tests fail if any English phrase lacks a translation or a dictionary entry is stale, so English copy can't change without both translations. Sentences with inline markup are translated whole (`data-t`).
- A language switcher (header on wider screens, footer everywhere) with `hreflang` alternates. Pages use root paths, so the site is served from the root of its domain.
- Fonts (Geist, Geist Mono, Instrument Serif, latin subsets, SIL OFL 1.1) are served from `/fonts`; Korean text uses the visitor's system Korean font. The page loads nothing from other hosts.
- Translations are Claude's and need a native-speaker read before launch, as the summary already notes for Korean and Spanish pricing and legal wording.

## Must never appear (checked by tests)

- Old plans or prices: Core, Complete, Essential, $149, lifetime plans.
- 30-day money-back or refund terms, specific Champions Club prizes or free months, texting allowances, a HON payment processor, customer counts, "available now".
- Any `<form>` or email input.

## Plan

1. Tests first (`apps/website/test/*.test.mjs`, Node's built-in test runner): content rules above, every `#anchor` resolves, every image exists and has alt text, every link to the app goes to an allowed path through the build placeholder, the build substitutes the app address and the `noindex` guard.
2. Source: `src/index.html`, `src/styles.css`, `src/site.js`, `src/flow.js` (background animation, honours reduced motion), `src/assets/*.webp` (each photo at full size and 800px wide), `src/favicon.svg`.
3. Build: `scripts/build.mjs` copies `src` to `dist`, replaces `{{APP_URL}}` and `{{ROBOTS}}`, and refuses a non-http(s) app address.
4. Wire `build` and `test` scripts so the root `pnpm build` / `pnpm test` include the site.
5. Verify in a real browser at desktop and phone widths, then review and open the PR.

## Blog (2026-11-13)

- `/blog/` lists posts newest first; each post is at `/blog/<slug>/`. Korean and Spanish live at `/ko/blog/…` and `/es/blog/…`.
- A post is a folder `src/blog/posts/<slug>/` with `en.md`, `ko.md` and `es.md`. Each file starts with front matter (`title`, `description` up to 200 characters, `date` as YYYY-MM-DD, `author`), then a small Markdown subset: `##`/`###` headings, paragraphs, `-` and `1.` lists, `>` quotes, `**bold**`, `*italic*`, and links to site paths only (for example `/#pricing`). The build fails if a language is missing, the dates differ or a link leaves the site.
- Blog pages reuse the home page header and footer of the same language, load only the stylesheet (no scripts, no background animation) and end with a "Start a new school" card. Blog-only labels are in `scripts/blog.mjs`.
- `test/blog.test.mjs` applies the same banned-claims rules to every post in all three languages and checks that every link on every page resolves.
- The two first posts are general school-owner advice written by Claude, and need David's OK and a native-speaker read like the rest of the KO/ES copy.

## Privacy Policy and Terms of Service (2026-11-17)

Owner request (David, 2026-11-17): "we need privacy policy and terms on website". Trigger: the Shopify app review asks whether HON tells merchants what data it collects and why, and whether the merchant agreement covers data protection. No such text existed.

**Status (2026-11-18):** written by Claude to the best of its ability. David supplied the company (HON OS Labs LLC), address and contact email, confirmed the refund, founder-lapse and 30-day price-notice terms, and chose not to use a lawyer ("no lawyer. just create to best ability"). Claude chose the remaining values: California law and Los Angeles County courts (no arbitration), a 30-day export window after an account closes, 24-month audit/security logs, about 7 days of rolling backups, and breach notice within 72 hours.

- Source: `src/legal/privacy.md` and `src/legal/terms.md` (front matter `title`, `description`, `updated` as YYYY-MM-DD, then the blog's Markdown subset). The Terms include the school data processing terms (HON processes student, family and staff data on the school's instructions).
- Pages: `/privacy/` and `/terms/`, English only for now (a legal translation needs a professional translator, not a dictionary). They reuse the English home page header and footer, load only the stylesheet, and carry the same `robots` tag as the rest of the site. `/privacy/` is the URL to give app stores (Shopify, Apple, Google).
- Blanks are written `[[Like this]]` and render highlighted. A page with any blank left shows a banner: "Draft for review. These terms are not yet in effect." The published pages have no blanks, so no banner.
- Links: the footer of every language has a "legal" column with Privacy and Terms (Korean and Spanish footers link to the English pages, marked `hreflang="en"`). The app's sign-in landing page links to `/privacy` and `/terms` on the app, which redirect (308) to the website pages, so `app.myhonos.com/privacy` also works as an app-store URL. The website address defaults to `https://myhonos.com` and can be set with `HON_WEBSITE_ORIGIN` (plain http(s) origin only).
- Facts in the text come from the code and architecture docs on `main` (Shopify mirror without customer contact details and `shop/redact` erase; face check-in consent, no stored camera pictures and the template retention rules; Stripe/Square payments; texting STOP/HELP; Meta/Google/Zernio connections; AI features), described as what HON does when the feature is turned on. Nothing claims a certification HON does not have.
- Tests: the legal pages build with no blanks or banner, a page with a blank shows the banner, link only to built pages, pass the same banned-claims rules, and cover each required topic (Shopify, minors and parental consent, face check-in, AI, payments, texting STOP/HELP, retention, security, subprocessors, school data processing, contact). The app tests check the landing links and the redirect, including a refused bad origin.
- Out of scope: a click-to-accept step at sign-up (needs David's decision on wording and the final text), translated legal pages, a cookie banner (the site sets no cookies and loads nothing from other hosts), and redeploying the website (David's OK).
