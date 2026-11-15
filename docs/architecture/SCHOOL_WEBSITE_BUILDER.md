# School AI Website Builder — gap audit, spec and plan

Owner request: David, 2026-11-15 "HON OS complete AI platform handoff", section 2 (AI Website Builder) plus its share of sections 5–8.
Status: SPEC. Nothing here is deployed. Custom domains, paid hosting, real AI providers and publishing to a real domain each need David's explicit OK.

## 1. Gap audit (main at fbc9102, 2026-11-15)

| Area | State | Where |
| --- | --- | --- |
| Public lead forms → CRM lead with immutable source/campaign attribution, rate limits, honeypot, idempotent | **Verified** (DB proofs) | 0075, 0076, `apps/api/src/marketing/public-form.*`, `/forms/:publicId`, `docs/architecture/PUBLIC_LEAD_FORM_INTAKE.md` |
| Public booking types and public events (trial/evaluation booking pages) | **Verified** | `/book/:publicId`, `apps/api/src/schedule/public-booking-type-transport.ts`, `public-event-transport.ts` |
| Marketing campaigns + attribution (school and HQ) | **Verified** | 0073, 0074, 0227, 0252 |
| Governed school knowledge (articles) | **Verified**, used by HON agents | 0036, `knowledge-articles.ts` |
| Creative credits wallet (per school) | **Verified**, inactive in prod | CW1 0202, `HON_OS_CREATIVE_CREDIT_WALLET.md` |
| AI website *drafts* (text for up to 8 fixed pages, paid by credits, WEBSITE rate per PAGE) | **Partial**: open PR #332 (0344), synthetic runtime only, no site, no publishing, no editor | other thread ("Route AI team models and limit costs") |
| Media storage for owner images/video | **Partial**: open PR #365 (C3, 0355) | creative thread |
| HON OS's own marketing site | Exists but is **HON's** site, not school sites | `apps/website` (static, Render) |
| School website record, pages, sections, theme | **Absent** | — |
| Draft/published versions, publish, rollback | **Absent** | — |
| Public renderer at a working address | **Absent** | — |
| Templates (Modern/Clean, Family Friendly, Bold/Powerful, Traditional, High Conversion) | **Absent** | — |
| Owner workspace (Websites & Landing Pages), desktop/mobile preview, manual editing | **Absent** | — |
| Conversational editing ("make the hero more exciting") | **Absent** | — |
| Landing pages tied to campaigns, page analytics, conversion counts | **Absent** (attribution exists, page analytics do not) | — |
| Website chat (Conversation AI on the site) | **Absent**; depends on the Conversation AI thread's public web-chat channel | sibling thread |
| Custom domains, SSL, managed hosting per school | **Absent**; needs David's OK (Render custom domains, DNS, cost) | — |

Reusable: public-form intake and attribution (the only way a site creates leads, no second customer database), public booking types, campaigns, knowledge, creative wallet + 0344 WEBSITE rate, C3 media storage, the school shell/catalog, the existing tenant/permission/entitlement/idempotency/audit patterns.

## 2. Intent

A school owner builds, edits, previews, publishes and rolls back a real school website from plain-language instructions, with no developer. The site is a front door to HON OS: its forms and booking buttons feed the existing CRM and booking services, landing pages keep campaign attribution, and the school's Conversation AI can answer visitors. Success = David's acceptance test: create a site conversationally, edit it, preview it, publish it to a working address, submit a form on it and see the lead in CRM.

Non-goals: arbitrary HTML/JS/CSS authored by owners or AI; a second database of leads/contacts; a general web host for non-school content; e-commerce beyond links to existing billing checkout.

Anti-goals: an AI that writes code which is executed or rendered unescaped; a site that publishes copy the owner never previewed; leads that bypass the 0075 intake rules; one school able to read or edit another school's site.

## 3. Approach

Chosen: **structured site document rendered by HON.** A site is a validated JSON document (theme + pages + typed sections from a closed library). HON's web app renders the published version with escaped React components at a HON address. AI never emits HTML; it proposes a list of edit operations on the document, which is validated, previewed and applied only by the owner.

Rejected:
- *Generate static HTML and deploy each site* (e.g. one Render static site per school): every publish is a deploy, per-site hosting cost, XSS surface, no live link to forms/booking/schedule.
- *Third-party site builder* (Duda, Higgsfield websites, etc.): lead data and edits live outside HON, breaks "no second database", recurring per-site fees.

## 4. Design

### 4.1 Site document (contracts `school-website.ts`, enforced again in SQL)
- `theme`: `palette` {primary, accent, background, surface, text} as `#rrggbb`; `font` from a closed list; optional `logoAssetId` (C3 asset of the same school once #365 lands); `template` code.
- `pages[]` (1..20): `slug` (`^[a-z0-9-]{1,40}$`, `home` required, unique), `kind` HOME | PROGRAM | LANDING | PROMOTION | CUSTOM, `title` ≤120, `inNav` bool, `seo` {title ≤70, description ≤160}, optional `campaignId` (active campaign of the same school, LANDING/PROMOTION only), `sections[]` (1..30).
- `sections[]`: `{ id, type, props }`, closed types: HERO, PROGRAMS, SCHEDULE, TRIAL_CTA, LEAD_FORM, BOOKING, FAQ, TESTIMONIALS, INSTRUCTORS, TEXT, IMAGE, VIDEO, CONTACT, PROMO_BANNER, CHAT. Each type has a closed prop schema: bounded plain strings (no control/bidi chars), lists with caps, links only to `https://` or same-site page slugs, `LEAD_FORM.publicFormId` / `BOOKING.bookingPublicId` referencing the school's own published form/booking type, media by asset id or `https://` URL (video: YouTube/Vimeo id only).
- Document size cap 256 KB.

### 4.2 Data (WB2, migration 0361)
- `hon.school_websites`: org, school, `public_slug` (global unique, `^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$`, reserved words blocked), name, status DRAFT | PUBLISHED | UNPUBLISHED, `draft_document`, `draft_revision`, `published_version`. One site per school in v1 (landing pages are pages of that site).
- `hon.school_website_versions`: immutable snapshot per publish/rollback, actor, request id, note, source PUBLISH | ROLLBACK.
- `hon.school_website_requests`: actor-scoped idempotency (operation + fingerprint).
- All deny-all with FORCE RLS; runtime calls fixed SECURITY DEFINER entry points only.
- Permissions `website.read`, `website.edit`, `website.publish` (OWNER by default, staff-assignable). Active entitlement + live school required, checked again after locks.
- Entry points: `read_school_website` (current school), `create_school_website` (from template), `save_school_website_draft` (expected revision; optimistic concurrency), `publish_school_website` (snapshot draft → new version; validates every referenced form/booking/campaign belongs to the school and is live), `rollback_school_website(version)` (copies an old snapshot into a new version and the draft), `unpublish_school_website`, and public `read_published_school_website(slug)` (published snapshot + school display name only; no ids of org/school; forms/booking references dropped if no longer published).
- Audit + inert outbox event per command.

### 4.3 Public renderer (WB3)
- `apps/web` routes `/sites/[slug]` and `/sites/[slug]/[page]`, server-rendered from `GET /v1/public/sites/:slug`. Theme via CSS variables from validated hex. All text escaped. LEAD_FORM embeds the existing `PublishedLeadFormView` (so leads go through 0075 unchanged; landing-page campaign attribution comes from the form's campaign). BOOKING links/embeds `/book/:id`. UTM query parameters on the page are copied into the form's `source` field (≤80 chars) as an extra attribution note.
- `noindex` until David approves indexing; SEO title/description per page; sitemap later.
- Working address: `<app origin>/sites/<slug>` (works on Render once David deploys). Subdomains (`<slug>.myhonos.com`) and custom domains are WB8 and need David's OK.

### 4.4 Templates and build-from-brief (WB4)
Five templates = theme + default page/section sets: MODERN_CLEAN, FAMILY_FRIENDLY, BOLD_POWERFUL, TRADITIONAL, HIGH_CONVERSION. "Start a site" fills a template with school facts HON already holds (school name, programs/plans, published booking types and forms). This step is deterministic and labelled as a template fill, not AI.

### 4.5 Owner workspace (WB4)
`/staff/websites` in the Marketing group (and a Home card): site status and address; page list; section editor (edit props, add/remove/move sections and pages, theme colors/font/logo); desktop/mobile preview of the **draft** rendered in-app by the same components (no public draft URL); publish with note; version history with rollback; unpublish. EN/KO/ES copy; works in Modern, Classic and Big Button.

### 4.6 Conversational editing (WB5, needs a migration number)
Owner types "Make the hero more exciting" / "Add a Halloween landing page". HON returns an **edit proposal**: a closed list of operations (`setSectionProp`, `addSection`, `removeSection`, `moveSection`, `addPage`, `removePage`, `setPageSeo`, `setTheme`) plus a plain summary. Server validates it against the document schema, stores it (`school_website_edit_proposals`), the owner previews the result and applies or discards it. Apply = ordinary draft save with expected revision. The AI call is billed through the creative wallet WEBSITE rate (0344, after #332 merges) and uses the same runtime pattern: production stays unconfigured until David approves a real provider; tests use a synthetic runtime. The main HON assistant gets a "change my website" handoff into this flow.

### 4.7 Landing pages + analytics (WB6, needs a migration number)
LANDING/PROMOTION pages linked to a campaign. Privacy-safe daily counters per page (views, form starts are not tracked; accepted submissions come from 0075 receipts by form/campaign). Journey lead → appointment → trial → enrollment uses existing CRM attribution reports.

### 4.8 Website chat (WB7)
CHAT section (or a site-level toggle) loads the Conversation AI thread's public web-chat endpoint (CA4) with its one HON-owned script tag, added by HON's renderer, never by owner or AI content. No separate chat widget is built here. Until CA4 ships the toggle renders nothing and the editor says "not available yet". Site copy for build-from-brief and AI edits can use that thread's shared "school AI knowledge" facts builder.

### 4.9 Custom domains and hosting (WB8, owner decision)
Domain records, DNS verification, Render custom-domain attach, SSL status. Needs David's OK on cost and approach before any build that touches Render.

## 5. Security boundary
- Tenant: every staff command resolves one exact live school from verified identity; request bodies never carry org/school/actor.
- Rendering: no raw HTML, no script, no style strings; colors are validated hex; links are `https://` or internal slugs; video by provider id.
- Leads only via 0075 intake; site tables hold no visitor PII.
- Public read returns only the published snapshot and school display name.
- AI output is data (operations), validated server-side, applied only by a permitted human.

## 6. Build plan (small PRs)
1. **WB2** (0361): data model, SQL entry points, API (`/v1/websites`, `/v1/public/sites/:slug`), contracts with shared validator, DB proof + API tests.
2. **WB3**: public renderer and section components, theme, form/booking embeds, UTM note; web tests.
3. **WB4**: templates + build-from-brief + owner workspace with preview, publish, rollback; nav entry; web tests + screenshots.
4. **WB5**: AI edit proposals (migration TBD), synthetic runtime, wallet billing after #332.
5. **WB6**: landing pages ↔ campaigns, page counters (migration TBD).
6. **WB7**: chat widget hookup (with Conversation AI thread).
7. **WB8**: domains (after David's decision).
Acceptance demo after WB4/WB5: local end-to-end (create → edit → preview → publish → visit → submit form → lead in CRM) on disposable DB with screenshots.
