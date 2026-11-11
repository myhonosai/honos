# HQ Marketing & Creative (HON's own marketing)

Status: M1 built (2026-11-11), M2 built (2026-11-11), M3 is a stop point. Owner request (David, 2026-11-11): "in HQ also have its own marketing and
creative section to market HON OS. Google and Meta just like inside HON OS CRM."

## 1. Goal

HON HQ gets its own **Marketing & Creative** section for marketing HON OS itself to martial-arts
school owners. It mirrors what a school sees in the CRM (campaigns with planned budgets and channels,
Creative Studio, a creative credit budget, Google and Meta ad account status) but is fully separate
from every school:

- HQ campaigns are HON-company records, not school records. No school, family or school staff can see
  or change them, and HQ never writes school campaign rows.
- HQ creative spend is an HQ budget. It never reads, reserves or debits a school creative wallet.
- Google Ads and Meta (Facebook/Instagram) start as honest "not connected" states. Connecting HON's real
  ad accounts, publishing ads or spending money is a **stop point** that needs David's explicit approval.

## 2. Architecture decision: HQ-native, not "HON as a school"

Two readings were possible:

- **A (chosen): HQ-native tables** gated by HQ operator grants, the same pattern as HQ support records
  (0232) and Champions contests. Pure contracts and validation are shared with the school side where the
  shapes match, and the UI reuses the school components' layout.
- B: create an internal "HON company" organization/school and reuse school modules directly.
  Rejected: school campaigns require an active school entitlement and exact school permission, so HON
  would need a fake paid school; it would mix HQ authority with tenant authority (HQ must not borrow school
  authority, `docs/hon/HQ_AUTONOMY_AND_AI.md`), and it would show up in school counts, wallets and billing.

## 3. Who can use it

- HQ owner (`HON_HQ_OWNER`): everything.
- HQ operator holding new permission `hq.marketing.manage`: read and change campaigns, request creative.
- HQ operator holding `hq.marketing.read`: read only.
- Everyone else (school owners, school staff, families, AI principals, runtime): denied. Same eligibility
  rule as 0232: active human, the only active principal of its user, no live family access.
- Changes are human commands only (no AI action engine path in this slice). AI-drafted copy can come
  later through Chase (HQ growth exec) as drafts a human saves.

## 4. Slices (small PRs)

### M1 — HQ campaigns (migration 0252)

- Tables `hon.hq_marketing_campaigns`, `hon.hq_marketing_campaign_versions` (immutable snapshots),
  `hon.hq_marketing_campaign_requests` (idempotency). No organization/school columns. Forced RLS, no
  policies; only SECURITY DEFINER boundaries.
- Fields: code, name, goal, audience (`NEW_SCHOOLS`, `TRIAL_SCHOOLS`, `EXISTING_SCHOOLS`, `PARTNERS`,
  `OTHER`), offer label, channel, status (`DRAFT`, `ACTIVE`, `PAUSED`, `ARCHIVED`), starts/ends,
  planned budget (minor units, USD), version.
- Channels: `GOOGLE_ADS`, `META_ADS`, `ORGANIC_SOCIAL`, `EMAIL`, `REFERRAL`, `EVENT`, `WEBSITE`,
  `PARTNERSHIP`, `OTHER`. Choosing an ad channel records intent only; it never starts an ad.
- Planned budget is a planning number. It is never a charge, a provider budget, or spend.
- API (`/v1/hq/marketing/campaigns`, `Cache-Control: private, no-store`, SaaS read/command guards):
  - `GET /` (query `status` = OPEN | DRAFT | ACTIVE | PAUSED | ARCHIVED, `cursor`, `limit` 1-100), `GET /:id` (campaign + every version)
  - `POST /` create (starts DRAFT), `POST /:id/versions` edit plan, `POST /:id/status`; all need `Idempotency-Key`, the
    human-command header, and (edit/status) `expectedVersion`. Status moves: DRAFT→ACTIVE|ARCHIVED, ACTIVE→PAUSED|ARCHIVED,
    PAUSED→ACTIVE|ARCHIVED; ARCHIVED is final. Rule refusals (422): `HQ_CAMPAIGN_CODE_TAKEN`, `HQ_CAMPAIGN_NO_CHANGE`,
    `HQ_CAMPAIGN_STATUS_NOT_ALLOWED`, `HQ_CAMPAIGN_ARCHIVED`.
- Ad accounts: a fixed contract constant `HQ_MARKETING_AD_ACCOUNTS` (Google Ads and Meta, `NOT_CONNECTED`,
  `externalExecutionAvailable: false`, reason `OWNER_APPROVAL_REQUIRED`). No endpoint and no provider call; M3 replaces it.
- UI: new top-level HQ nav entry **Marketing & Creative** (`/hq/marketing`): ad account cards, campaign counts, planned
  budget total labelled "planned, not spent", filters, create/edit form and status buttons (hidden for read-only viewers and
  archived campaigns). en/ko/es. Hidden while the tab is in the background.
- Tests: contract and route tests (`apps/api/test/hq-marketing.test.cjs`); DB proof
  (`packages/database/scripts/test-hq-marketing-campaigns.mjs`: owner/manager write, reader read-only, support/billing/school
  owner/unknown denied, idempotent replay and key reuse, unique code, version conflict, status rules, archived final, history
  immutable, list paging/filter/summary, no school campaign rows, revocation); UI unit tests
  (`apps/web/test/hq-marketing-ui.test.tsx`); mounted browser check (`apps/web/scripts/hq-marketing-browser.mjs`, desktop,
  390px, Korean, axe).

### M2 — HQ Creative Studio + HQ creative budget (migration 0253)

- `hon.hq_creative_budget_periods` (monthly UTC period, HQ-set credit cap, set by HQ owner only,
  immutable change history) and `hon.hq_creative_generations` (same operation codes and unit rules as
  school Creative Studio, optional link to an HQ campaign).
- Reserve against the HQ cap; never touches `saas_creative_wallet*` tables. Same safeguards as 0216:
  max 3 in progress, stuck → UNKNOWN, unverified result → UNKNOWN for HQ owner resolution.
- Production provider runtime stays `UnconfiguredCreativeProviderRuntime` → 503
  `CREATIVE_PROVIDER_NOT_CONNECTED` **before any DB write**. A real image/video provider is a stop point.
- UI: `/hq/marketing/creative` (create request, list, budget meter "HQ budget, separate from schools").

As built (M2):

- Tables: `hq_creative_budget_periods`, `hq_creative_budget_changes`, `hq_creative_generations`,
  `hq_creative_generation_assets` (SYNTHETIC only), `hq_creative_requests`. Forced RLS, no table grants;
  update rules and immutability enforced by triggers; truncate blocked.
- Entry points: `read_hq_creative_studio`, `read_hq_creative_generation`, `set_hq_creative_budget` (HQ owner only;
  current month or up to 12 months ahead), `create_hq_creative_generation`, `record_hq_creative_generation_result`
  (requester only), `resolve_hq_creative_generation` (HQ owner only, evidence reference required).
- Budget: used = charged credits of SUCCEEDED/RESOLVED_CHARGED; held = reserved credits of GENERATING/UNDER_REVIEW;
  available = max(cap − used − held, 0). The cap can never be set below used + held. Rates come only from the
  published `saas_creative_rates`. A platform-wide `ai_spend_pauses` row (CREATIVE_MEDIA or ALL) blocks new requests.
- API: `GET /v1/hq/marketing/creative`, `GET /v1/hq/marketing/creative/generations/:id`,
  `POST /v1/hq/marketing/creative/generations`, `POST /v1/hq/marketing/creative/generations/:id/resolution`,
  `POST /v1/hq/marketing/creative/budget`. All commands need the human-command header and an Idempotency-Key.
- The owner page sets only the current month's cap; future months stay API-only for now.
- Follow-up: a FAILED request whose provider cost is unknown keeps `cost_status = UNKNOWN`; recording that cost
  later from provider evidence is not built yet (no provider is connected, so nothing can reach it today).
- Proofs: `test-hq-creative-studio.mjs` (database), `apps/api/test/hq-creative.test.cjs`,
  `apps/web/test/hq-creative-ui.test.tsx`, `apps/web/scripts/hq-creative-browser.mjs` (mounted page, synthetic fixtures).

### M3 — Connect HON's Google and Meta ad accounts — STOP POINT

Through Zernio (the chosen Meta/Google provider, HQ credential check already at `/hq/integrations/zernio`).
Needs David's approval for: which accounts, publishing, lead intake, and any spend limit. Not built until
approved.

### M4 — Attribute sign-ups and trials to HQ campaigns

After public sign-up (0241) and trial runtime (0246) are on main: optional `hq_campaign_code` captured at
sign-up, HQ funnel (visits not tracked; sign-ups → trials → paying schools by campaign). Separate spec
addendum when those land.

## 5. Not in scope / safety

No ad publishing, no provider calls, no spend, no messages to schools, no payments or entitlement changes,
no deploy. Planned budgets and credit caps are internal planning numbers.
