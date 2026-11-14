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

## 4A. S2 design (0348): posts

### 4A.1 Scope

Text posts, with an optional https link, to the school's own Facebook Pages. Instagram requires an image or video on
every post, and HON has no reviewed real-media storage yet (Creative Studio results are synthetic only, 0216), so an
Instagram target is refused with `SOCIAL_MEDIA_REQUIRED` until a later media piece (its own migration number) lets
staff upload an image to Zernio. Agent drafts come with the AI Action Engine hook in a later piece; S2 is human drafts
only.

### 4A.2 Records

- `hon.school_social_posts`: one per post: `text` (1 to 2,200 characters), optional `link_url` (https, at most 2,000),
  `status` (`DRAFT`, `APPROVED`, `CANCELLED`), `publish_at` (set on approval), who drafted and who approved, `version`.
  The text, link and targets are frozen once approved.
- `hon.school_social_post_targets`: one per (post, connected account): `status` (`PENDING`, `PUBLISHING`,
  `PUBLISHED`, `FAILED`, `UNKNOWN`, `SKIPPED`), the lease (`lease_token`, `lease_expires_at`), `provider_post_id`,
  `failure_code` (a fixed HON code, never provider text), `skip_reason` (`ACCOUNT_OFF`, `SCHOOL_INACTIVE`),
  `resolved_by` for a person's resolution of an UNKNOWN.
- `hon.school_social_post_receipts`: one per Zernio webhook event id (dedup).
- `hon.school_social_commands`: idempotency (reused from 0347).

### 4A.3 Who

New permission `marketing.social.post` (write and edit drafts; staff assignable). Approving, cancelling an approved
post and resolving an UNKNOWN need `marketing.social.manage`. Reads need `marketing.social.read`. Same 0331 actor
checks as S1, re-checked after the writes.

### 4A.4 Flow

1. **Draft** `POST …/marketing/social/posts {text, linkUrl?, accountIds}`: 1 to 4 accounts, each a CONNECTED
   Facebook account of this exact school. Edit with `expectedVersion` while DRAFT.
2. **Approve** `POST …/posts/:id/approve {publishAt?, expectedVersion}`: every target must still be CONNECTED with
   publishing on. `publishAt` empty means now; otherwise between now and 90 days ahead. The approver may be the
   drafter (one-person schools).
3. **Cancel** a DRAFT, or an APPROVED post while every target is still PENDING.
4. **Publish worker** (only when publishing is READY): runs as `hon_communication_worker`. It claims due PENDING
   targets with a 60-second lease. At claim time the account must still be CONNECTED with publishing on and the
   school, organization and HON entitlement active, or the target becomes SKIPPED. The worker asks Zernio to publish
   to that one account with the target id as idempotency key, then records PUBLISHED (with the provider post id),
   FAILED or UNKNOWN. A timeout or lost answer is UNKNOWN. A PUBLISHING target whose lease ran out becomes UNKNOWN,
   never claimed again.
5. **Webhooks** on the existing signed endpoint: `post.published` / `post.failed` settle a target found by provider
   post id and the school binding of its account, so they reach only a target that already holds its provider post
   id. An UNKNOWN target never received one, so only a person settles it (step 6). A
   PUBLISHED target becomes FAILED if Zernio later reports the platform refused it; nothing moves from FAILED back to
   PUBLISHED, and a person's resolution stands. `account.disconnected` marks the bound account DISCONNECTED with every switch off.
   Receipts are deduplicated by event id. These events are handled only when publishing is READY.
6. **Resolve UNKNOWN** a person who checked the Page marks an UNKNOWN target PUBLISHED or NOT_PUBLISHED. HON never
   resends it.
   An approval stands until the post is cancelled: a post approved ahead of time still goes out if the approver later
   loses `marketing.social.manage`; anyone who still holds it can cancel the post before it is due. A Zernio 429 is
   recorded as a definite refusal (FAILED); a later piece may return it to PENDING with a later due time instead.
7. **Read** `GET …/marketing/social/posts?from&to`: the calendar list with targets and statuses, at most 200.

## 4B. S3 design (0349): inbox (Messenger, Instagram DMs and comments)

### 4B.1 Scope

Messenger conversations and Instagram DMs on the school's connected accounts, and comments on the school's own posts,
arrive in one school inbox. Staff read them, reply, hide or unhide a comment, mark a conversation read, assign it to a
staff member, and link it to a CRM lead or person of the same school. Nothing is sent automatically; agent reply
drafts come later with the AI Action Engine.

### 4B.2 Records

- `hon.school_social_conversations`: one per (account, provider conversation id): `kind` (`DM`, `COMMENT`; a comment
  conversation is one top-level comment and its replies), the participant's display name (at most 120, as Meta gives
  it; no Meta user id is stored), `last_inbound_at` (for the reply window), `last_message_at`, `unread` count,
  `assigned_principal_id`, `linked_lead_id` / `linked_person_id` (same school only), `comment_hidden`, `version`.
- `hon.school_social_messages`: one per message: `direction` (`INBOUND`, `OUTBOUND`), `body` (1 to 2,000 characters,
  control characters removed), the provider message or comment id (unique per account), and for outbound messages the
  person who sent it and a send state (`SENDING`, `SENT`, `FAILED`, `UNKNOWN`) with a 60-second lease.
- `hon.school_social_inbox_receipts`: one per Zernio event id.
- Message text is school-private CRM data. It is never written to audit or outbox.

### 4B.3 Who

New permission `marketing.social.inbox` (read the inbox, reply, hide comments, mark read, assign, link; staff
assignable, sensitive because it shows private messages). The same 0331 actor checks, re-checked after the writes.
Linking also needs the lead or person to belong to the same school.

### 4B.4 Flow

1. **Receive** (only when inbox is READY: `HON_ZERNIO_INBOX_APPROVED=true` with a key, or the fake): signed
   `message.received` / `comment.received` on the existing endpoint, as the worker role. The account must be bound to a
   school with its inbox switch on; otherwise the event is acknowledged and nothing is stored (not even the text).
   Deduplicated by event id and by provider message id. A comment on a post that is not the school's own still lands
   (Meta only sends comments on the Page's own posts).
2. **Reply** `POST …/inbox/conversations/:id/reply {text}` (the idempotency key makes a retry safe): refused with
   nothing recorded while replying is off (`SOCIAL_INBOX_NOT_ENABLED`). DB checks the account still has inbox on
   and, for a DM, that the person wrote within the last 24 hours (Meta's standard messaging window; HON does not use
   message tags). It records the outbound message as SENDING with a lease and returns its id; the API then asks Zernio
   to send it once (idempotency key = HON's message id) and records SENT (with the provider id), FAILED or UNKNOWN. A
   SENDING message whose lease ran out reads as UNKNOWN and is never resent; a person can mark it as sent or not sent.
3. **Comment actions** `POST …/inbox/conversations/:id/comment {action: HIDE | UNHIDE}`: same once-only pattern
   (one request in flight per comment); the conversation records the hidden state only after Zernio confirms. An
   UNKNOWN or FAILED request leaves the shown state unchanged and a new request may follow (hiding is repeatable).
   A person settles an UNKNOWN reply with `POST …/inbox/messages/:id/resolve {outcome: SENT | NOT_SENT, expectedVersion}`.
4. **Read / assign / link** `POST …/inbox/conversations/:id {read?, assignedPrincipalId?, linkedLeadId?,
   linkedPersonId?, expectedVersion}`. Assignment needs an eligible staff member at this school.
5. **List** `GET …/inbox?view=ALL|UNREAD|MINE&before=` (at most 50 per page, newest activity first) and
   `GET …/inbox/conversations/:id` (the last 200 messages).

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
