# HQ ad account connections (0677)

Status: spec and plan, 2026-11-24. Owner request (David, 2026-11-24, HQ > Marketing & Creative): "how to connect? is it
in setting?" followed by his decision-card choice "Yes, build it with Zernio" (build a Connect button for HON's own
Google Ads and Meta in HQ). Earlier owner decision (2026-11-11): Zernio is the one connector for HQ and school ads, so no
separate Google or Meta developer app is needed.

## 1. Goal

HQ > Marketing & Creative shows two ad account cards, Google Ads and Meta (Facebook and Instagram). Today both are fixed
text "Not connected" (`HQ_MARKETING_AD_ACCOUNTS` in `packages/contracts/src/hq-marketing.ts`). This piece gives each card
a real **Connect** button so the HQ owner can link HON's own ad accounts through Zernio, see what is connected, and
disconnect it.

Connecting records which account HON may later use. **Nothing in this piece publishes an ad, contacts Google or Meta for
anything except the consent hand-off, or spends money.** Every card keeps "Cannot publish or spend". Running HQ ads is a
later piece with its own number and its own owner approval.

## 2. Rules

- Same flow as school social connections (0347, `SOCIAL_POSTING_INBOX_ADS.md` §4) so behaviour and review are familiar:
  single-use connect intent holding only the SHA-256 of a random state, 10-minute expiry, same person on return,
  redirect query values ignored, accounts read back from HON's own Zernio profile.
- HQ-native tables gated by `hq_operator_grants` (the 0252 pattern), not a fake school tenant. The school tables, school
  functions and school adapter switches are not changed.
- **Who:** connect and disconnect = a current `HON_HQ_OWNER` only (these are HON's real money accounts). Seeing the cards
  = anyone who may read HQ marketing today (owner, or operator with `hq.marketing.manage` / `hq.marketing.read`).
  Active human, only active principal of its user, no live family access (the 0252 `hq_marketing_principal_eligible`
  rules). Authority is re-checked after the writes.
- **Own switch:** the API talks to Zernio for HQ only when `ZERNIO_API_KEY` is well formed **and**
  `HON_HQ_ZERNIO_CONNECT_APPROVED=true`. The school switch `HON_ZERNIO_CONNECT_APPROVED` neither turns HQ on nor is turned
  on by it. The HQ adapter never sees the publish, inbox or ads switches, so it cannot publish or spend even if they are
  set. The deterministic fake runs only with `HON_ZERNIO_FAKE_PROVIDER=1` outside production and staging.
- One HQ Zernio profile, found or created by HON's own name `hon-hq` (a retry never makes a second one), never moved.
- One provider account is HON's or a school's, never both: an account already held by any school (0347/0453 table) is
  skipped as a conflict and only counted.
- No tokens in HON (Zernio holds them). Evidence rows are identifier-only and append-only.

## 3. Platforms

| HQ card | `provider` | Zernio platform | Note |
|---|---|---|---|
| Google Ads | `GOOGLE_ADS` | `googleads` | same assumption as 0453 |
| Meta (Facebook and Instagram) | `META_ADS` | `facebook` | Meta ads run through the connected Facebook account, as school boosts (0445) do |

Both platform names are build-time assumptions already listed in `SOCIAL_POSTING_INBOX_ADS.md` §5; confirm against
Zernio's docs before the HQ switch is set.

## 4. Records (migration 0677)

- `hon.hq_ad_profile`: at most one row (`singleton = true` primary key): `provider_profile_id` (unique), who linked it, when.
- `hon.hq_ad_accounts`: one per connected account: `provider` (`GOOGLE_ADS`, `META_ADS`), `provider_account_id` (unique per
  provider, ever), `display_name` (≤120, no control characters), `status` (`CONNECTED`, `DISCONNECTED`), `version`, who
  connected, `connected_at`, `updated_at`, `disconnected_at`. No publish or spend switch exists.
- `hon.hq_ad_connect_intents`: one per attempt: provider, starter, `state_hash`, `created_at`, `expires_at` (+10 min),
  `consumed_at`, `outcome` (`RECORDED`, `NOTHING_FOUND`), counts.
- `hon.hq_ad_requests`: disconnect idempotency per actor and uuid key (the 0252 claim pattern).
- `hon.hq_ad_events`: append-only evidence (`CONNECT_STARTED`, `PROFILE_LINKED`, `ACCOUNT_CONNECTED`, `CONNECT_FINISHED`,
  `ACCOUNT_DISCONNECTED`) with actor, ids and time.

All forced RLS, revoked from every runtime role; only the definer functions below are granted to `hon_runtime`. Guards
make profile, events and requests immutable, an account change only by version bump (provider and ids fixed), an intent
consumed once and its outcome written once. No delete, no truncate.

## 5. Functions (all `SECURITY DEFINER`, subject-bound through `hon.saas_refuse_context()` like 0252)

1. `read_hq_ad_accounts(subject)`: both providers, connected and disconnected accounts, `profileLinked`, viewer
   `canConnect` (HQ owner now).
2. `start_hq_ad_connect(subject, {provider}, state_hash)`: owner; ≤10 attempts per hour across HQ; returns intent id,
   expiry and the profile id if linked.
3. `record_hq_ad_profile(subject, intent, profile_id)`: first writer wins; a different id, or one a school profile
   holds, is refused `HQ_AD_PROFILE_CONFLICT`.
4. `claim_hq_ad_connect(subject, state_hash)`: same person, unexpired, unused; consumes it; returns provider and profile.
5. `record_hq_ad_accounts(subject, intent, accounts[])`: ≤25, new → CONNECTED, own disconnected → CONNECTED again, held
   by a school → conflict count.
6. `disconnect_hq_ad_account(subject, account, {expectedVersion}, key)`: owner; idempotent; returns the provider account id
   only so the API can ask Zernio to remove it (best effort, reported as REMOVED / NOT_REMOVED / NOT_ATTEMPTED).

## 6. API

`/v1/hq/marketing/ad-accounts` (HonIdentityGuard; reads via SaasReadGuard, commands via SaasCommandGuard with
`Idempotency-Key` uuid):

- `GET` → accounts + `connectEnabled` (switch on and https public origin).
- `POST connect {provider}` → `{authUrl, provider, expiresAt}`; the URL must be https on an allowed consent host.
- `POST connect/complete {state}` → `{provider, connected, conflicts, accounts}`.
- `POST :accountId/disconnect {expectedVersion}` → account + `providerRemoval`.

Return page: `/hq/marketing/ads/return` (no-referrer, removes the state from the address at once, posts it once).

## 7. Web

The two cards on `/hq/marketing` read the API: status chip (Connected / Not connected), connected account names, a
**Connect** button (owner only, switch on), **Disconnect** with a confirm step, and plain text when connecting is not
turned on yet ("Connecting is not turned on yet. David turns it on after the deploy."). "Cannot publish or spend" stays
on every card. English, Korean and Spanish.

## 8. Tests (TDD)

- DB proof `test-hq-ad-connections.mjs`: owner connect start → profile → claim → record; operator with manage refused
  connect; read-only operator reads; school staff and family refused; state reuse, wrong person, expiry; rate limit;
  school-held account counted as conflict; disconnect idempotency and version conflict; immutability guards; no grants on
  tables.
- API unit test: switch matrix (school switch does not enable HQ; HQ adapter never publish/ads ready), connect URL host
  check, provider errors map to fixed codes, disconnect removal reporting.
- Web unit test + browser proof: cards show live state, connect button only for owner with switch on, return page.

## 9. Owner steps after merge and the combined deploy (David)

1. In Zernio, nothing new is needed for the key (already in Render).
2. Set `HON_HQ_ZERNIO_CONNECT_APPROVED=true` on hon-api (only after his OK on a decision card).
3. HQ > Marketing & Creative > Google Ads > Connect: sign in to Google in the Zernio window and pick HON's Google Ads
   account. Same for Meta with the Facebook account that owns HON's ad account.

## 10. Not in this piece

Creating, publishing or paying for HQ ads; ad insights; Zernio webhooks for HQ accounts (a token expiry shows on the next
manual reconnect).
