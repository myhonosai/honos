# HQ usability, agency-view style (owner, 2026-11-24)

David found HQ hard to use. Compared with GoHighLevel's agency view, HQ had too many menu sections with related
pages split apart, legal/engineering wording on screen, display controls and policy text on every page, and no
step-by-step guidance. Server-side security checks are unchanged by all of this work; only wording and layout change.

## Owner decisions
- 2026-11-24 05:48Z: menu regrouped into seven sections (card "Yes, 7 sections").
- 2026-11-24 05:48Z: home page keeps its layout (card "Keep home as it is"); only its wording and empty tiles are cleaned up.
- 2026-11-24 05:49Z: HQ needs no screensaver/hide-while-away; connect every HQ AI function to real AI (migration 0678).

## Menu (PR 1)
| Section | Pages (URLs unchanged) |
|---|---|
| Home | /hq |
| Schools | all schools, needs attention, school owners, owner invitations, school access, exception policy |
| Plans & Billing | pricing & offers, plan promotions, subscriptions, business numbers, invoices, free trials, founder billing, creative credits, sign-up limits |
| Grow | growth overview, Champions Club, leaderboard, contests, rewards, founder campaigns, prospects, marketing & creative |
| Messages & Support | approvals, support, texts & email, school texting numbers |
| AI Team | executive team, AI costs, conversation AI, AI safety |
| Settings | setup guide, AI providers, Zernio connection |

Exactly one menu link is marked current: the exact page, else the longest menu path the page sits under.
Every HQ page (except detail pages) must be reachable from the menu; a test enforces it.

## Page frame (PR 1)
- View / AI Style / Motion sit in the page header, not in a full-width bar.
- No "governed workspace" subtitle or "HQ remains separate from school CRM" footer on every page.

## Later pieces
- PR 2: home wording and empty "Unavailable" tiles.
- PR 3+: plain wording page by page; technical detail behind a "Details" disclosure; results beside the button.
- HQ AI switch-on (0678): HQ-actor gate, reuse the shared AI text path and OpenRouter switches; paid use needs David's card.
