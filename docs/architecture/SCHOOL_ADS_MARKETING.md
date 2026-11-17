# School ads in Marketing: connect Meta Ads and Google Ads, AI-assisted setup

Status: spec and plan, 2026-11-17. Owner ask (David, 2026-11-17 00:01Z): "I don't see where to connect meta ads and
Google ads in marketing to run the ads with ai able to set up". Builds on
[SOCIAL_POSTING_INBOX_ADS.md](SOCIAL_POSTING_INBOX_ADS.md) (S1 connections 0347 on main, S4 ads 0350 not yet on main),
[ZERNIO_INTEGRATION.md](ZERNIO_INTEGRATION.md) and the owner decision of 2026-11-11 to use Zernio as the one connector
for Meta **and** Google ads (school and HQ), so no separate Meta or Google app review is needed.

Nothing here connects a real ad account, buys the Zernio Ads add-on or spends money. Every provider path stays behind
the existing off-by-default switches and the deterministic fake Zernio.

## 1. What exists on main (4e962d1)

| Piece | State |
|---|---|
| Connect a school's Facebook Page / Instagram account through Zernio (0347), with a per-account **ads** switch | Built, off by default. Screen is *Social accounts*, under the **Communication** heading, not Marketing |
| Posts (0348) | Built, off by default |
| Inbox (0349, PR #349) | Open, on hold |
| Meta ads: boost a published Facebook post inside a monthly cap, created PAUSED, human turn-on (0350) | Written as a patch only (`/mnt/project-files/social/S4_0350_ads_on_S3_dbb04ad.patch`), stacked behind #349; no screen |
| Google Ads (school) | Absent |
| Marcus marketing drafts (governed AI, human approval, saved to a campaign) | Built (`/staff/marketing/assistant`) |
| Marketing menu heading | Website, Marketing (overview, campaign planner, Champions Club), Creative Studio. **No ads entry** |

So the owner is right: there is no place under Marketing to connect ad accounts, Meta ads have no screen, and Google
Ads does not exist.

## 2. Goal

Under **Marketing** a school owner finds **Ads**, sees Meta Ads and Google Ads side by side, connects each, sets a
monthly ad spend cap, and lets HON's marketing specialist (Marcus) set up an ad: Marcus drafts the plan (what to
promote, budget inside the cap, dates, ad text); a person reviews and approves it; the ad is created PAUSED; a person
turns it on. Results come back into the page.

## 3. Rules (inherited, unchanged)

- Exact school, forced RLS, provider ids untrusted until they match a HON binding (S1 rules).
- People decide, AI drafts. Marcus only creates drafts; approve, activate, pause and cap are human commands
  (`HUMAN_UI`, same-origin command guard, idempotency key). No automated spend.
- Every ad starts PAUSED. Turning on is the only spending step. The cap is re-checked at approval and at turn-on.
- Unknown is not success; lost provider writes are UNKNOWN and reconciled, never resent.
- Switches: `HON_ZERNIO_CONNECT_APPROVED`, `HON_ZERNIO_ADS_APPROVED` (Meta and Google share it unless David asks for
  separate ones), fake `HON_ZERNIO_FAKE_PROVIDER=1`.
- The page never claims something works that does not: statuses are read from the server, and pieces not built yet
  say so plainly.

## 4. Pieces

| Piece | What | Migration | Owner stop |
|---|---|---|---|
| **A1** (this PR) | Marketing > **Ads** page: Meta Ads card from the real S1 connection read (connected Facebook Pages, ads switch per Page, connect button, link to switches); Google Ads card (honest "not available yet"); "Set up an ad with AI" card that opens Marcus. Menu entry under Marketing. en/ko/es | none | no |
| A2 | Land S4 Meta boost backend (social thread, PR #450) | 0445 | merge slot from coordinator |
| A3 (this PR, stacked on #450) | Ads page on S4: monthly cap, boost a published post (draft, approve, turn on, pause, resolve UNKNOWN), daily spend/clicks | none | no |
| A4 | Marcus ad plan: a person asks Marcus for an ad; Marcus returns a structured draft (post to boost, budget inside the cap, dates, text, audience note) through the governed AI path; a person applies it to an S4 draft. Agents still never call ad commands | new number (ask coordinator) | real AI provider stays off |
| A5 | Google Ads through Zernio: connect a Google Ads customer account (GOOGLE_ADS platform on the school Zernio profile), simple Search/Performance Max campaign drafts, same cap, PAUSED, human turn-on, insights | new number(s) | **Zernio Ads add-on is paid; real connection and spend need David** |
| A6 | HQ uses the same Zernio ads path for HON's own Google/Meta accounts (HQ Marketing M3) | later | David |

## 5. A1 design (frontend only)

- Route `/staff/marketing/ads`, menu item `ads` under the `marketing` heading, title "Ads" (ko 광고, es Anuncios).
- Reads the existing `GET …/marketing/social/accounts` (S1). No new endpoint, no write except the existing S1
  connect command (Facebook) started from this page, which returns to the existing Social accounts return page.
- **Meta Ads card**
  - No Facebook Page connected: "Connect Facebook to run Meta ads" button (only when the server says connecting is on;
    otherwise the server's "not turned on yet" message).
  - Pages connected: each with "Ads on" / "Ads off" from the real switch, and a link "Change on Social accounts".
  - A plain line: "Creating and running Meta ads arrives in the next update. Every ad will start paused and a person
    turns it on." (removed by A3).
- **Google Ads card**: "Not connected. Google Ads will connect through the same secure connection (Zernio) in a later
  update." No button.
- **Set up an ad with AI** card: "Marcus can write your ad text today: pick a campaign and ask for an ad." Link to
  `/staff/marketing/assistant`. Automatic ad setup is listed as coming with A4.
- Same privacy handling as Social accounts (hide on blur/school change/session end; reads retired).
- Read denied → "You don't have access to ads"; unavailable → retry.

### A1 tests

- Catalog: `ads` sits under the Marketing heading and owns `/staff/marketing/ads`.
- View: Meta card states (no Page, Page with ads off/on, connecting off), Google card has no connect button, AI card
  links to Marcus, denied/unavailable/concealed/no-school states, three languages have every key.
- Controller: connect calls the S1 connect API with a fresh key and navigates to the returned URL.

## 6. Owner decisions (for later pieces)

1. Zernio Ads add-on (paid) before any real Meta or Google ad account connection (A5 and live A3).
2. One `HON_ZERNIO_ADS_APPROVED` switch for both Meta and Google, or separate switches (built: one).
3. Highest monthly cap a school may set (S4 built: 10,000.00).

## 7. A3 design (frontend only, on the 0445 API)

Shown inside the Meta Ads card once a Facebook Page is connected. Reads `GET …/marketing/social/ads` and the last 99 days
of `GET …/marketing/social/posts` (only Facebook targets HON PUBLISHED can be boosted).

- **Monthly ad limit**: amount + currency, `POST …/ads/budget` (expectedVersion once a limit exists).
- **Boost a post**: published post, total budget, start/end dates (1 to 31 days from the school's today) →
  `POST …/ads` (a draft; nothing is sent to Meta).
- **Your ads**: DRAFT → Approve (`operation CREATE`, created PAUSED) or Cancel draft; PAUSED → Turn on, which asks
  first ("Meta starts spending") and only the confirm step sends `ACTIVATE`; ACTIVE → Pause; UNKNOWN create → "I
  checked: not created"; UNKNOWN turn-on/pause → Pause, or "I checked: running/paused".
- When the server says ads are off (`adsEnabled: false`), the page says so and every Meta step is disabled; the limit
  and drafts still work.
- People without `marketing.social.ads` (403 on the read) see a plain note and no ad data.
- One write at a time, each with its own idempotency key. Only an unknown outcome keeps the request for Try again,
  which resends the identical body and key, so the server replays it rather than acting twice.
- Wording: the review P3 from #435 is applied ("HON never holds the ad money"; no unapproved claim about markups).
