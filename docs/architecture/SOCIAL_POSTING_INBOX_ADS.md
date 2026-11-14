# Social posting, Messenger/Instagram inbox and ads (through Zernio)

Status: spec and plan, 2026-11-14. Owner request (David, 2026-11-14): "i want our platform to do ad and messenger and
able to post as well". Builds on [ZERNIO_INTEGRATION.md](ZERNIO_INTEGRATION.md) ("Full Meta scope and future
integration"), [META_INTEGRATION_ARCHITECTURE.md](META_INTEGRATION_ARCHITECTURE.md) (capability families, lifecycle,
inbox rules) and the 0250 lead intake ([COMMUNICATION_DELIVERY.md](COMMUNICATION_DELIVERY.md) §5c).

Nothing here connects a real account, publishes, sends a message or spends money. Every provider path is INACTIVE
until David approves it, and all tests use a deterministic fake Zernio.

## 1. Goal

Each school connects its own Facebook Page and Instagram professional account through Zernio. Then, inside HON OS:

1. **Posting:** staff write posts (HON agents may only prepare drafts), a person approves each one, and HON publishes
   it now or at a scheduled time. HON records what Zernio reports back (published, failed, unknown).
2. **Inbox:** Messenger and Instagram DMs and comments on the school's posts arrive in a school inbox. Staff reply from
   HON. A conversation can be linked to a CRM person or lead.
3. **Ads:** staff boost a post or create a simple Meta campaign. A person approves the budget, the budget must fit the
   school's monthly ad spend cap, every ad starts PAUSED, and a person turns it on. Results come back into Marketing.

## 2. Rules that apply to every piece

- **Exact school.** Every record carries organization + school with forced RLS. A provider account id, profile id or
  conversation id from a request or webhook is untrusted until it matches a HON binding for that exact school. One
  provider account belongs to one school, ever (the 0250 rule); a conflicting claim is refused, never moved.
- **Separate capabilities per account.** Each connected account has three switches: publishing, inbox, ads. All start
  off. A school person with `marketing.social.manage` turns each on. Publishing never implies inbox or ads.
- **People decide, AI drafts.** Publish, reply, ad create and ad activation are human commands (the `HUMAN_UI` source,
  same-origin browser command guard, idempotency key). HON, Marcus, Chad or any agent can only create drafts; there is
  no automated sending in this build.
- **Off-by-default switches** (API server environment, same shape as `HON_SMS_SEND_APPROVED`): a feature is READY only
  when `ZERNIO_API_KEY` is present AND its own switch is exactly `true`:
  | Switch | Allows |
  |---|---|
  | `HON_ZERNIO_CONNECT_APPROVED` | creating the school's Zernio profile and the connect hand-off (each connected account is a paid Zernio seat) |
  | `HON_ZERNIO_PUBLISH_APPROVED` | publishing/scheduling approved posts |
  | `HON_ZERNIO_INBOX_APPROVED` | receiving DMs/comments into HON and sending staff replies |
  | `HON_ZERNIO_ADS_APPROVED` | creating ads (always PAUSED) and turning them on (spends the school's money) |
  `HON_ZERNIO_FAKE_PROVIDER=1` runs the deterministic fake, refused in production and staging like
  `HON_COMMUNICATION_FAKE_PROVIDER`.
- **Unknown is not success.** A lost or timed-out provider write is UNKNOWN and is reconciled from Zernio's records or
  a webhook, never blindly resent.
- **Minimal data.** No access tokens are ever held by HON (Zernio keeps them). No raw provider payload or error text is
  stored. Inbox message text is stored because staff need to read it; it is school-private and follows the CRM
  retention rules.
- **Evidence.** Identifier-only `hon.audit_events` and inert `hon.outbox_events` for every state change; definer
  functions only, `hon_runtime` gets EXECUTE on entry points and no table privileges.

## 3. Pieces and pull requests

| PR | Piece | Migration |
|---|---|---|
| S1 | School social connections: Zernio profile per school, connect hand-off with single-use state, account list, per-account capability switches, disconnect | 0347 |
| S1-web | Marketing → Social accounts page (connect, switches, disconnect) and the return page; 3 languages | none |
| S2 | Posts: drafts (staff and agent drafts), human approval, publish now / schedule, cancel, worker publish with lease, `post.*` webhook receipts, calendar list | 0348 |
| S3 | Inbox: `message.received` / `comment.received` webhook into school conversations, staff replies (24-hour Messenger window and Instagram rules checked at send), comment reply/hide, link to CRM person/lead, unread/assignment | 0349 |
| S4 | Ads: school monthly ad spend cap (set by owner), boost post / simple campaign drafts, human approval inside the cap, created PAUSED, separate human activate/pause, daily insights sync | 0350 |

Each PR gets its own section here before it is built, its own DB proof, API tests, and an independent review.

## 4. S1 design (0347): school social connections

### 4.1 Records

- `hon.school_social_profiles`: one Zernio profile per school (`provider_profile_id`, unique). Created once by the
  first connect; never changes or moves to another school.
- `hon.school_social_accounts`: one row per connected Facebook Page or Instagram account: `platform`
  (`FACEBOOK`, `INSTAGRAM`), `provider_account_id` (unique per platform, ever), `display_name` (≤120),
  `status` (`CONNECTED`, `DISCONNECTED`), `publish_enabled`, `inbox_enabled`, `ads_enabled` (all false on insert, all
  forced false on disconnect), `version`, who connected, timestamps. Reconnecting the same account at the same school
  sets it CONNECTED again with the switches still off.
- `hon.school_social_connect_intents`: one per connect attempt: platform, the person who started it, the SHA-256 of a
  32-byte random state (the raw state lives only in the redirect), `expires_at` (10 minutes), `consumed_at`,
  `outcome`. Single use.
- `hon.school_social_commands`: idempotency (the 0335 pattern).

### 4.2 Who

New permissions, backfilled to every system OWNER role: `marketing.social.manage` (connect, switches, disconnect;
sensitive) and `marketing.social.read` (see the accounts; staff assignable). A direct human at the session school, an
active school, organization and HON entitlement (the 0331 actor checks). HQ, family, student, delegated and agent
callers are refused. Authority is re-checked after the writes.

### 4.3 Flow

1. **Start** `POST …/marketing/social/connect {platform}`. DB: authorize, at most 10 intents per school per hour,
   record the intent with the state hash, return the school's profile id if one exists. API (only when connect is
   READY): if there is no profile, ask the adapter for the school's profile by HON's own name `hon-school-<schoolId>`
   and create it only if none exists (so a retry after an unknown result does not make a second profile), then record it
   (`hon.record_school_social_profile`, first writer wins; a different id for the same school is refused). Then ask
   the adapter for the connect URL for that profile and platform with the fixed return
   `${HON_PUBLIC_ORIGIN}/staff/marketing/social/return` and the state. The URL must be https on an allowed host
   (Zernio, Facebook, Instagram) or nothing is returned.
2. **Return** The browser page posts `{state}` to `POST …/marketing/social/connect/complete`. DB claims the intent by
   state hash: same person, same session school, not expired, not used. Redirect query values (account ids, names) are
   ignored. API lists the accounts on the school's own profile from Zernio and keeps those of the intent's platform.
3. **Record** `hon.record_school_social_accounts(intent, accounts)`: new accounts are inserted with switches off;
   accounts already at this school become CONNECTED; an account bound to another school is skipped as `CONFLICT`
   (counted, not named). The intent records its outcome once.
4. **Switches / disconnect** `POST …/marketing/social/accounts/:id` with `expectedVersion`. Disconnect forces every
   switch off at once; the API then asks Zernio to remove the account (best effort, reported, never assumed).
5. **Read** `GET …/marketing/social/accounts`: accounts, switches, status, plus whether connecting is turned on.

### 4.4 Not in S1

Account webhooks (token expiry, `account.disconnected`) arrive with S2's webhook events; until then a reconnect is
manual. No posting, inbox or ads code runs in S1.

## 5. Provider facts to confirm before any switch is turned on

docs.zernio.com is blocked from the build container, so the adapter is written against these assumptions, each one
isolated in `zernio-social-adapter.ts` and checked against Zernio's docs (by a person, or a container with that host
allowed) before activation:

1. Profile create/list endpoints and that a profile name can hold `hon-school-<uuid>`.
2. The connect endpoint for `facebook` / `instagram` that takes `profileId` and a redirect URL and returns an auth
   URL; that HON's `state` survives the round trip (otherwise HON adds it to its own return URL).
3. Account list per profile: field names for the account id, platform, display name and the owning profile id. HON takes only accounts whose own `profileId` equals the school's profile, and treats an answer with no owner fields as unknown.
4. Account disconnect endpoint.
5. (S2–S4) post create/schedule/cancel fields and statuses, inbox send/reply endpoints, ad create/budget units
   (cents vs currency), PAUSED creation, insights, and webhook event names.

## 6. What David changes in Zernio when a piece is approved

- **Key:** replace the read-only verification key with a profile-scoped **read-write** key limited to the resource
  groups each approved piece needs (accounts/profiles for S1; posts and media for S2; inbox/messages/comments for S3;
  ads for S4). Keep it in Render `hon-api` as `ZERNIO_API_KEY`; never in the web service.
- **Webhook:** keep the same endpoint `/api/v1/communications/webhooks/zernio` and secret, and add the events each
  piece consumes (S2: post published/failed and account disconnected; S3: message and comment received; S4: none
  required). Lead intake keeps `lead.received`.
- **Switch:** set only the approved piece's `HON_ZERNIO_*_APPROVED=true` in `hon-api`.

## 7. Tests (TDD)

- DB proof per piece (`packages/database/scripts/test-school-social-*.mjs`): authority, other school, delegated/HQ/
  family refusal, single-use state, expiry, conflict, idempotent replay, version conflicts, ACLs, audit/outbox.
- API unit tests with the fake adapter: readiness switches, URL host allowlist, redirect values ignored, unknown
  provider results, production refusal of the fake.
- Browser checks for each web piece in English, Korean and Spanish, desktop and phone.
