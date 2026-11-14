# Real AI images and video: Higgsfield and HeyGen (design)

Status: design, 2026-11-14. Owner request (David, 2026-11-14): build AI image and video generation into HON using
**Higgsfield** (images and video) and **HeyGen** (talking avatar video), mainly for school social posts and ads.

Nothing in this document calls a paid provider, deploys, or spends money. Every provider path stays **off** until David
turns on its switch, and the build is tested only against deterministic fake providers. Provider keys are never handled
by a build thread: David pastes them into Render `hon-api` himself when he approves a piece.

## 1. What already exists (reused, not rewritten)

| Piece | Where | What it gives us |
|---|---|---|
| Per-school creative wallet | 0202, 0209 ([HON_OS_CREATIVE_CREDIT_WALLET.md](HON_OS_CREATIVE_CREDIT_WALLET.md)) | 12,000 credits per paying school per month, top-ups ($30 = 3,000, so **1 credit = $0.01**), HQ-published versioned rates per operation, reserve / settle / UNKNOWN for HQ, provider cost recorded separately from credits |
| Creative Studio generations | 0216 ([CREATIVE_STUDIO_AVATARS.md](CREATIVE_STUDIO_AVATARS.md) §CS1) | one generation row per request, idempotency, 3-in-progress cap per school, closed result verification |
| Avatars and talking-avatar video | 0276, 0277 | school avatars (look + description), `avatar.video` priced per second |
| Own-photo avatars (open PR #294, 0305) | A3 plan | adult staff's own photo with signed likeness consent and delete |
| HQ Creative Studio | 0253 ([HQ_MARKETING_AND_CREATIVE.md](HQ_MARKETING_AND_CREATIVE.md)) | HON's own marketing, paid from an HQ creative budget, never a school wallet |
| Spend safety | S4 (0193-0199), 0288, 0353 (PR #340; C1 builds on its spend-decision bodies) | HQ emergency pause per org / platform / school, per-school AI cost ceiling, creative reservations refused for paused schools; image and video off for free-access schools |
| Provider seam | `apps/api/src/creative-studio/creative-provider-runtime.ts` | `CreativeProviderRuntime` (readiness, route, generate). Production is `UnconfiguredCreativeProviderRuntime` (always NOT_CONNECTED) |
| Social posts | S2 (PR #341, 0348) | drafts, human approval, publish worker; Instagram refused with `SOCIAL_MEDIA_REQUIRED` until real media exists |

So the money path, limits, idempotency and HQ recovery are already built. What is missing is: real provider adapters,
asynchronous jobs (video takes minutes), real media storage, moderation and human approval of results, and attaching
approved media to social posts and ads.

## 2. Providers

Both providers' documentation hosts are blocked from the build container. The facts below come from web search
summaries on 2026-11-14 and are marked **to confirm**. Each assumption lives in one adapter file and is checked
against the live docs (by David, or by a container with those hosts allowed) before a switch is turned on, the same
rule as Zernio (`SOCIAL_POSTING_INBOX_ADS.md` §5).

### 2.1 Higgsfield (images and short video)

- Base URL `https://api.higgsfield.ai`. Auth: `Authorization` header carrying a key id and secret pair (legacy
  `hf-api-key` / `hf-secret` headers also accepted). Server side only, never in the browser. *To confirm: exact header
  format.*
- Submit a generation per model (text-to-image, text-to-video, image-to-video) and get a request id back; poll
  `GET` request status until a terminal state; a queued request can be cancelled. *To confirm: endpoint paths, field
  names (model, prompt, aspect ratio, duration), status values, whether webhooks exist.*
- Results are downloadable for a limited time (third-party guides cite a 7-day window), so HON copies every result into
  its own storage at once (§5).
- Billing: pay-as-you-go US dollar balance, $5 minimum top-up; images priced per image, video per second of output.
- Prices seen (they disagree by source and date): images about $0.003 to $0.016 each (Soul, Marketing Studio Image);
  video about $0.05 to $0.12 per second (Wan, Kling, Seedance). HON assumes the **upper** figures for pricing.
- *To confirm: NSFW / policy rejection behaviour and whether a rejected job is charged; rate limits.*

### 2.2 HeyGen (talking avatar video)

- Auth header `X-Api-Key`. Create a video with `POST /v2/video/generate` (avatar id, voice id, script, dimension) and
  get a `video_id`; status at `GET /v2/videos/{id}` (newer docs: `/v3/videos/{id}`) until `completed` / `failed`.
- Webhooks: register an endpoint (`POST /v3/webhooks/endpoints`), which returns a signing secret shown once; events
  `avatar_video.success` and `avatar_video.fail`. HON treats a webhook only as a hint and always re-reads the video
  from the API before recording anything. *To confirm: signature header and algorithm.*
- Billing: pay-as-you-go API wallet (no free API credits since February 2026), charged per second generated.
  Prices seen: Avatar III $0.60 to $0.99 per minute, Avatar IV photo avatar $2.31 per minute, Avatar IV studio or
  digital twin $4.83 per minute, Avatar V digital twin $7.20 per minute.
- Result video URLs expire, so HON copies the file at once (§5). *To confirm: URL lifetime, max video length,
  concurrency limits, moderation error codes, photo-avatar (talking photo) upload endpoint.*

### 2.3 Which provider does what (server routing, never chosen by the client)

| Operation (HQ rate code) | Provider | Model class |
|---|---|---|
| `image.generate` | Higgsfield | a standard image model (default Soul or Marketing Studio Image) |
| `video.generate` (5 or 10 s) | Higgsfield | a standard text/image-to-video model (default Kling or Wan) |
| `avatar.create` | Higgsfield | portrait image of the avatar's look (the same image model) |
| `avatar.video` | HeyGen | Avatar IV studio avatar with a stock voice |
| `avatar.photo.video` (with A3, own photo only) | HeyGen | Avatar IV photo avatar |

The exact model id per operation is server configuration in the adapter, reviewed in each PR. Schools never pick a
model, a provider or a price.

## 3. Cost and credits

Credits are what the school pays from its wallet. Provider cost is what HON pays. They are recorded separately
(0202), and the rate HQ publishes is the only link between them. Proposed launch rates (HQ publishes them through the
existing rates command; they stay `PROVISIONAL` until a real invoice is linked as cost evidence):

| Operation | Unit | Proposed credits | = school price | HON cost (upper estimate) | Margin |
|---|---|---|---|---|---|
| `image.generate` | per image | **10** | $0.10 | $0.016 | about 6x |
| `video.generate` | per second | **20** | $0.20/s (5 s clip = 100) | $0.12/s | about 1.7x |
| `avatar.create` | per avatar | **10** | $0.10 | $0.016 | about 6x |
| `avatar.video` | per second | **15** | $0.15/s (30 s = 450) | $0.0805/s ($4.83/min) | about 1.9x |
| `avatar.photo.video` | per second | **8** | $0.08/s (30 s = 240) | $0.0385/s ($2.31/min) | about 2x |

What 12,000 monthly credits buys (one type only): about 1,200 images, or 120 five-second clips, or 26 thirty-second
avatar videos. A typical mix for a school (40 images, 8 short clips, 4 avatar videos of 30 s) is 3,000 credits,
a quarter of the allowance. HON's provider cost for that mix is about $15.

Provider costs above HON's estimate are caught three ways: the result's real cost is recorded on the reservation, the
HQ wallet read shows actual provider expense per school, and the platform daily guard in §4 stops new work.

## 4. Limits

Per school (most already enforced):

- **Credits:** the school's own wallet (0202). Nothing runs without a reservation.
- **In progress:** at most 3 generations per school at once (0216).
- **Size:** video 5 to 10 s for `video.generate`; 5 to 60 s for avatar video (0277); images at most 4 per request.
- **New: daily caps per school**, HQ-editable, defaults 50 images, 12 video clips and 10 avatar videos per UTC day, so a
  runaway retry loop or a compromised staff login cannot drain a month in an hour.
- **Free-access schools:** image and video stay off (0353). **Trial schools:** only their trial creative lot (PR #265).
- **HQ pause:** the existing S4 / 0288 pause for one school, an organization or the whole platform also stops creative.

Platform wide (new, protects HON's provider balances):

- **Daily provider spend guard** per provider, set by the HQ owner (proposed defaults: Higgsfield $25/day,
  HeyGen $50/day). No limit set means no real submissions. Every submit counts its worst-case cost first, under one
  lock per provider. Today's committed cost is every job permitted today: its recorded cost where one is recorded, and
  its worst case (reserved credits × $0.01) for jobs still permitted, submitted or unknown, or whose cost is
  unrecorded; at the limit new submissions are refused with
  `CREATIVE_PROVIDER_DAILY_LIMIT` (credits never reserved) and HQ sees an alert. Jobs already submitted finish.

## 5. How a generation runs (asynchronous)

Today the API reserves, calls the provider once and records the outcome in one request. Video takes minutes, so the
flow becomes asynchronous. The money rules do not change.

1. **Request** (human command, `Idempotency-Key`). Closed input check, then **prompt moderation** (§6). Then the
   existing `create_creative_generation` reserves credits (pause, eligibility, rate, wallet lock, caps).
2. **Submit.** The API submits to the provider once and records the provider job id (`SUBMITTED`). A submit with no
   answer is `UNKNOWN` (credits held, HQ resolves) and is never resent. A clear refusal is `FAILED` (credits returned).
3. **Wait.** A worker with a lease polls each `SUBMITTED` job (HeyGen webhooks only wake it sooner), backing off from
   10 s to 60 s. A job with no terminal answer after 30 minutes becomes `UNKNOWN` for HQ.
4. **Copy.** On success the worker downloads the result from the provider's https URL (allowed hosts only, size limit
   25 MB per image and 200 MB per video, magic-byte type check, metadata stripped) into HON's private storage, and
   records the stored object, its SHA-256, size, dimensions and duration. The provider URL is never stored or shown.
   A download failure keeps the generation in `SUBMITTED` for a retry by the worker (the provider is not called
   again); after the 30-minute limit it becomes `UNKNOWN`.
5. **Settle.** The existing 0216 `record_creative_generation_result` is human-bound: it proves the caller is the
   requester's own active subject. A worker that finishes minutes later has no such subject, so C1 adds
   **worker-only, lease-bound recording functions** (granted to the worker login only, never to `hon_runtime`) for
   success, failure, unknown and the 30-minute timeout. Download failures from C3 use the same functions. These
   functions do not take a subject from the caller; they act only on the leased job. Inside the database they run the
   same 0216 validation and the same CW1 settle (wallet lock, finalize actual units never above the reservation,
   release, unknown held), recording the **requester as the original actor**. The job row records that the
   **worker** (or the deadline) closed it, as the integration source. If the requester is no longer an active
   single-principal person, nothing is settled: the job closes as `REQUESTER_UNAVAILABLE` and the reservation stays
   RESERVED for the existing HQ resolution. The human-bound function stays for the synchronous path, and refuses a
   generation whose provider job was submitted, so only the worker can record it. The asset starts as
   **`PENDING_REVIEW`**.

Storage: one private Supabase Storage bucket `creative-media` on the existing Supabase Pro project, object keys
`<orgId>/<schoolId>/<generationId>/<n>`, written only by `hon-api` with the service key. Reads are short-lived (5 min)
signed URLs issued by the API after an exact-school permission check. HQ Creative Studio assets use an `hq/` prefix
and never mix with school keys. A signed read is authorized against the **asset row** (its school, organization or
HQ ownership, and its review status), never from the object key or its prefix. Deleting an asset removes the object and keeps an identifier-only audit record.
*To confirm with David: storage size on Supabase Pro (100 GB included) is enough; retention proposal: delete unused
assets after 12 months.*

## 6. Moderation and approval

Martial arts schools mostly market to families with children, so the bar is high.

**Before anything is sent (deterministic, free):**
- A closed input: prompt 1 to 1,000 characters, no URLs, no email or phone numbers, no uploaded images except the A3
  own-photo flow.
- A HON blocklist (sexual content, nudity, graphic injury, weapons used on people, hate, drugs, self-harm, real public
  figures and brand names, "realistic photo of a child"), maintained in one reviewed file with EN/KO/ES terms.
  A hit is refused with `CREATIVE_PROMPT_NOT_ALLOWED` before any credit is reserved.
- **No real students or children are ever sent to a provider.** Generated people are fictional. Children may appear only
  in illustrated or chibi styles, never photorealistic. Real likeness only through A3 (an adult staff member's own
  photo with signed consent).

**Optional AI check (off by default, its own switch):** a cheap text moderation call through the existing OpenRouter
route under the school's normal AI limits, `HON_CREATIVE_AI_MODERATION_APPROVED`.

**At the provider:** a policy refusal is `FAILED` with reason `PROVIDER_POLICY`, credits returned.

**After generation (human approval, always on):**
- Every new asset is `PENDING_REVIEW`. Only the person who asked and staff with `marketing.social.manage` can view it.
- The blocklist cannot see a picture, so the rule that children appear only in illustrated or chibi styles is
  **enforced by this human review** (and by HON's prompt wording for each style). The prompt checks only reduce what
  reaches review.
- A person with `marketing.social.manage` marks it `APPROVED` or `REJECTED` (human command). AI team members can
  never approve. Proposed: the requester may approve their own asset when they hold that permission, because most
  schools have one or two marketing people. A school can still require a second person later. This is an owner
  decision (§10).
- Only `APPROVED` assets can be attached to a post or an ad, downloaded at full size, or used as an avatar look.
  Approval is re-checked when a post is published, so a later rejection or deletion stops a scheduled post.
- Approving records who approved it and when, kept as evidence. A rejected asset can be deleted at once.

## 7. Social posts, ads and the AI team

- **Posts (after S2 #341):** a post draft can carry up to 4 approved images or 1 approved video from the same school.
  The publish worker uploads the media to Zernio at publish time from a fresh signed URL. This lifts the Instagram
  `SOCIAL_MEDIA_REQUIRED` refusal. Ads (S4) reuse the same attachment.
- **AI team:** Marcus (marketing), Chad (growth) and HON can draft a **creative brief** (operation, prompt, format,
  suggested caption) inside a post draft. A person presses Generate, which spends credits through the normal human
  command. Agents never start a paid generation and never approve one in this build.
- **HQ Creative Studio (0253):** the same adapters and storage, paid from the HQ creative budget, for HON's own ads.

## 8. Switches (all off by default)

`hon-api` environment, the same shape as `HON_SMS_SEND_APPROVED`. A provider is READY only when its key is present,
its switch is exactly `true`, the HQ creative program is ACTIVE in the database, and the environment is not using a fake.

| Switch | Key(s) David pastes | Allows |
|---|---|---|
| `HON_CREATIVE_HIGGSFIELD_APPROVED` | `HIGGSFIELD_API_KEY_ID`, `HIGGSFIELD_API_SECRET` | images, short video, avatar looks |
| `HON_CREATIVE_HEYGEN_APPROVED` | `HEYGEN_API_KEY`, `HEYGEN_WEBHOOK_SECRET` | talking avatar video |
| `HON_CREATIVE_AI_MODERATION_APPROVED` | none (uses OpenRouter) | the optional AI prompt check |
| `HON_CREATIVE_FAKE_PROVIDER=1` | none | deterministic fake providers; refused in production and staging |

Turning a switch on also needs: the HQ owner publishing the rates in §3, setting the daily guard in §4, and topping up
each provider wallet (HON's money, David's decision). The first real run is one image and one 5-second video in a
test school, watched end to end, with David's explicit OK.

## 9. Build pieces (small PRs, each with tests, independent review and a merge slot)

| # | Piece | Migration |
|---|---|---|
| C0 | This design doc | none |
| C1 | Async provider jobs: submit/poll runtime interface, job records with a worker lease, 30-minute UNKNOWN timeout, daily per-school caps, HQ platform daily provider spend guard | 0354 |
| C2 | Higgsfield and HeyGen adapters with fake HTTP servers in tests, readiness switches, HeyGen webhook receipt (hint only) | none |
| C3 | Private media storage: download and verify, Supabase Storage bucket, signed reads, delete | 0355 |
| C4 | Moderation (blocklist) and human approval of assets | 0356 |
| C5 | Attach approved media to social posts and ads; AI team creative briefs | 0357 (merges after 0348, #341) |
| C6 | Creative Studio screens: review queue, approved library, attach to post; EN/KO/ES, desktop and phone | none |

Tests in every piece: DB proofs with the restricted runtime role (exact school, other school refused, caps, guard,
pause, idempotency, UNKNOWN handling), API unit tests against fake providers (success, refusal, policy refusal,
timeout, lost submit, bad download, oversized file, wrong host), and browser checks for the screens.

## 10. Decisions for David

1. Credit rates in §3 (10 per image, 20 per video second, 15 per avatar-video second, 8 per photo-avatar second).
2. Daily caps per school and the platform daily provider guard in §4.
3. Human approval of every asset before it can be posted (recommended always on), and whether the requester may approve
   their own asset (proposed yes).
4. Media retention (12 months for unused assets) and the 30-minute timeout.

Risky items for the final pre-launch review: real provider calls and spend, the storage service key in `hon-api`,
the HeyGen webhook endpoint, and moderation coverage.

## 11. C2 as built (adapters, no migration)

- `apps/api/src/creative-studio/providers/`:
  - `higgsfield-runtime.ts`: `image.generate`, `avatar.create` (look style phrase + description, square, one image; the
    avatar's name is never sent) and `video.generate` (duration = reserved seconds).
  - `heygen-runtime.ts`: `avatar.video` with a server-configured stock avatar per look style
    (`HON_CREATIVE_HEYGEN_AVATAR_REALISTIC|ILLUSTRATED|CHIBI`) and one stock voice (`HON_CREATIVE_HEYGEN_VOICE_ID`).
    An unconfigured style is never sent (NOT_SENT, credits back). Charged by the seconds actually generated (rounded
    up); a video longer than reserved fails verification and is held UNKNOWN for HQ.
  - `creative-provider-router.ts`: one runtime over both; the server picks the provider per operation and each job is
    polled only at the provider recorded on it. `createCreativeProviderRuntime({ mediaStorageReady })` is the production
    wiring and returns the unconfigured runtime unless storage is ready, **so production stays NOT_CONNECTED in C2
    whatever keys or switches are set.**
  - `creative-provider-http.ts`: one bounded JSON request (no redirects, no cookies, timeout, 16 KB / 64 KB body cap);
    nothing about provider traffic, headers or bodies is logged or returned.
- Readiness: key(s) well-formed **and** the switch exactly `true`. Polling needs only the key, so a job already
  submitted is still followed after a switch is turned off (while the other provider keeps the worker running).
- Submit answers: 400/401/402/403/404/413/415/422/429 are a clear refusal (FAILED, credits back); a 5xx, 409, timeout,
  dropped connection, redirect, oversize or malformed answer is UNKNOWN (held for HQ, never resent).
- Poll answers: only an explicit final status closes a job (failed / nsfw / canceled = FAILED; an unrecognised status
  or a completed answer without acceptable files = UNKNOWN). Any HTTP or transport error is retried until the deadline.
- Result files: download URLs must be https on the provider's host list (exact host or subdomain, no port, no
  userinfo). They are handed back in memory as `downloads` and are never part of the recorded result. **The worker
  never records a result that carries downloads until C3 copies the files into HON storage**; until then the job stays
  open and becomes UNKNOWN at its deadline (telemetry `creative.result_storage_unavailable`).
- Provider cost recorded on success is HON's upper estimate per unit from §3 (image $0.016, video $0.12/s, avatar
  video $0.0805/s) until a real invoice is linked; rates stay PROVISIONAL. Image dimensions, type and video duration
  are provisional in C2 and are replaced by the measured file values in C3.
- **Still to confirm against the live docs before any switch is turned on** (all in the `HIGGSFIELD_API` /
  `HEYGEN_API` objects): base URLs, model paths, auth header format, request field names, status values, result
  shape, download hosts, and whether refused jobs are charged.
- Not in C2: the HeyGen webhook (C2b, a hint that only wakes the worker sooner), the `HON_CREATIVE_FAKE_PROVIDER`
  environment fake (tests inject fakes directly), and `avatar.photo.video` (needs A3, #294).
- Tests: `apps/api/test/creative-provider-adapters.test.cjs` (9) against fake HTTP providers on 127.0.0.1.
