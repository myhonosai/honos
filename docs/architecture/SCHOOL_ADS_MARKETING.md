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
| A5 | Google Ads through Zernio (section 8): connect a Google Ads customer account (GOOGLE_ADS platform on the school Zernio profile), Search ad drafts, same cap, PAUSED, human turn-on | 0453 | **Zernio Ads add-on is paid; real connection and spend need David** |
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

## 8. A5 design: Google Ads through Zernio (migration 0453)

Goal: on Marketing > Ads a school connects its own Google Ads account through the same Zernio profile it uses for
Facebook, drafts a simple Google **Search** ad (headlines, descriptions, landing page, keywords) inside the **same**
monthly ad limit, approves it (created PAUSED at Google), turns it on (the only spending step), pauses it, and settles
any unknown outcome. Built and proved on the fake Zernio only.

### 8.1 Backend (0453, one PR)

Extends 0347 and 0445 instead of adding a parallel ad system, so the cap, the lease, UNKNOWN handling and the human
command rules are the reviewed ones.

- **Connection**: `GOOGLE_ADS` joins the account and connect-intent platforms. The connect start accepts it; Zernio's
  consent page lets the school pick its Google Ads customer account, and the existing claim/record path binds it (one
  school per customer id, ever). A Google Ads account can never publish posts or read an inbox: a table check keeps its
  publish and inbox switches off, and the post field check refuses it as a post target. Only its **ads** switch matters.
- **Ads table**: `school_social_ads` gains `channel` (`META_BOOST` for every existing row, or `GOOGLE_SEARCH`) and
  `google_content` (the school's own ad text). A Meta boost keeps its post target; a Google ad has no post target and
  must have content. Both stay immutable after the draft (guard updated).
- **Draft**: new `create_school_google_ad {accountId, budgetCents, startsOn, endsOn, headlines[3..15] (each 1 to 30
  characters), descriptions[2..4] (1 to 90), finalUrl (https), keywords[1..20] (1 to 80)}`. Account must be this
  school's CONNECTED `GOOGLE_ADS` account with ads on. Same date rules (1 to 31 days, from today up to 90 days ahead),
  same cap checks; the total budget must allow at least 1.00 a day.
- **Approve / turn on / pause / cancel / resolve**: the existing 0445 commands, unchanged for people. The start step
  hands the API the channel and, for Google, the content and a **daily budget = total ÷ days (rounded down)**. Google
  may spend up to twice the daily budget on a single day and settles against its monthly charging limit (daily budget
  × days in the month), so over a short campaign the spend can run somewhat above total ÷ days on some days; HON's
  daily figure keeps the *expected* spend at or under the total counted against the cap, but it is not a hard stop.
  Before real use, either Zernio sets a Google campaign total budget, or the cap counts the ad at its worst case (see
  8.2 item 6).
- **Cap**: one limit per school for Meta and Google together; every ad that may still spend counts its whole budget in
  every month its dates touch (0445 rule, now across both channels).
- **API**: `POST …/marketing/social/ads/google` (command `marketing.social.ads.google.create`), everything else on the
  existing ads routes. The ads read is unchanged apart from each ad's channel and content (one ads switch for both).
- **Adapter**: `createGoogleSearchAd` (one call, created PAUSED, HON ad id as idempotency key) and the existing
  `setAdActive` for turn on / pause. The fake gives deterministic ids and lets tests force refused, lost and late
  answers.

### 8.2 Provider assumptions to confirm before any real use

Zernio's docs are not reachable from the build environment, so the adapter is written to these assumptions, listed
here and in the adapter, and must be checked against Zernio before `HON_ZERNIO_ADS_APPROVED` is set:

1. Connecting platform name `googleads`; the connected account id is the Google Ads customer id.
2. Creating a Search campaign + ad group + responsive search ad + keywords in one call (`POST /ads/create` with
   `platform: googleads`), returning one ad id that the status call accepts.
3. The campaign can be created **paused** and stays paused until HON's turn-on call (if Google refuses ads inside a
   paused campaign, the adapter must create the campaign paused with the ad enabled instead; still no spend).
4. Daily budget, start and end dates and currency in the account's own currency are accepted as sent.
5. **Location targeting** (decided by David 2026-11-17): every ad, Google and Meta, reaches people within **5 miles of
   the school's street address** (`hon.school_locations`, 0392). Approving an ad is refused with `SOCIAL_AD_NO_ADDRESS`
   until the school has saved a street address. The adapter sends `targeting.locations[{ type: radius, radius: 5,
   unit: MILES, address }]` on create; that shape (and whether Zernio geocodes the address or needs coordinates) is
   assumed and must be confirmed.
6. **Budget units and overspend**: HON sends amounts in cents (same for the Meta boost); Zernio may expect currency
   units or Google micros, which must be confirmed in a sandbox. Google's daily overdelivery (up to 2x on a day) means a
   campaign total budget, if Zernio exposes one, is the safer setting.

Items 1 to 6 (from the independent review of #459, P3) gate turning `HON_ZERNIO_ADS_APPROVED` on for Google.

### 8.3 Frontend (one PR after the backend)

The Google Ads card on Marketing > Ads replaces "not available yet" with: connect button (when connecting is on),
connected account(s) with their ads switch, and once an account has ads on, a Search ad form (headlines, descriptions,
landing page, keywords, total budget, dates) plus the same ad list actions as Meta (approve paused, confirm turn on,
pause, settle unknowns). Browser proof on synthetic fixtures; en/ko/es.

### 8.4 Owner stops

- The Zernio Ads add-on is paid: David decided (2026-11-17) to buy the paid plan himself. Connecting a real Google Ads
  account, setting the keys and any real spend still need David.
- Location targeting: decided 2026-11-17, 5 miles around the school's street address (8.2 item 5).
- Whether Google uses the same `HON_ZERNIO_ADS_APPROVED` switch as Meta (built: same switch).

## 9. Google Business Profile (0455)

David, 2026-11-17: "Let's add Google business as well." A school connects its own Google Business Profile through the
same Zernio profile as Facebook and Google Ads, and HON publishes the school's approved posts to it.

### 9.1 What is built

- **Connections** (extends 0347/0453): `GOOGLE_BUSINESS` is a connectable platform. A profile only publishes: its inbox
  and ads switches stay off (table check `school_social_accounts_google_business_only`, the change command and the
  contract). The connect button is on Marketing > Social accounts.
- **Posts** (extends 0348): a Google Business Profile is a post target next to Facebook Pages, through the same draft,
  approve, one leased send, receipts and UNKNOWN handling. Text sent to a profile holds at most 1,500 characters
  (`SOCIAL_TEXT_TOO_LONG`, 400, on create and edit); Facebook keeps 2,200. The worker claims profile targets like
  Facebook ones, and signed `post.published` / `post.failed` / `account.disconnected` receipts settle them.
- No new database entry points: 0455 replaces five reviewed functions, which keep their grants.

### 9.2 Provider assumptions to confirm before any real use

1. Zernio's platform name is `googlebusiness` (connect, account list and webhooks).
2. A post is `POST /posts` with `platforms[{ platform: googlebusiness, accountId, platformSpecificData: { callToAction:
   { type: LEARN_MORE, url } } }]`, a standard update with the post's link as its button.
3. Google's own rules for profile posts (for example no phone numbers in the text) are not checked by HON; a refusal
   comes back as FAILED.

These gate turning `HON_ZERNIO_PUBLISH_APPROVED` on for Google Business Profile.

### 9.3 Next

- Google reviews in the HON inbox (read and reply), as its own piece.
- A post composer screen in the school app (posts are API-only today).
