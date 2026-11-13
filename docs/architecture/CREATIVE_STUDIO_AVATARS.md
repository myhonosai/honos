# Creative Studio avatars (migrations 0276, 0277)

Owner request (David, 2026-11-12): Creative Studio needs an avatar option, and a trial school should be able to try
making one inside its trial creative budget. This builds it on the CS1 generation pipeline (0216) and the per-school
creative wallet (0202). No provider is connected: production stays `NOT_CONNECTED`, tests use the synthetic provider.

## What an avatar is

An **avatar** is a school's own AI presenter: a named, consistent character look (for example "Master Kim, friendly
instructor in a black dobok") that the school can reuse in marketing. Slice A1 creates the avatar's look; slice A2 lets
the avatar present a short video by speaking a script (the "talking avatar" planned for HeyGen-class providers in the
AI model plan).

Out of scope (owner decision needed later): an avatar made **from a photo of a real person** (needs reviewed media
upload storage and recorded likeness consent), voices or voice cloning, editing an avatar after creation.

## Slices

| Slice | Migration | What it adds |
|---|---|---|
| A1 Create an avatar | 0276 | `hon.creative_avatars`, create/list/read, API `/creative-studio/avatars`, Avatars card in Creative Studio |
| A2 Avatar video | 0277 | a generation that names a READY avatar and a script, operation `avatar.video` |

## A1 contract

**Input** (closed): `{ name, style, description }`. `name` 1–40 printable trimmed characters; `style` one of
`REALISTIC`, `ILLUSTRATED`, `CHIBI` (the three looks HON already uses); `description` follows the CS1 prompt rule
(1–1,000 characters). Clients never choose an operation, provider, model, price, units or school.

**Price**: the avatar is one CS1 generation with operation code `avatar.create`, priced by whatever rate the HQ owner
publishes (media kind `IMAGE`, 1 unit, `PORTRAIT`). If HQ has not published `avatar.create`, creating is refused with
`SAAS_OPERATION_NOT_PRICED` and the card says avatars are not available yet. Trial schools pay from their trial lot
(0275) like any other operation; nothing here changes funding, eligibility or rates.

**Database (0276)**
- `hon.creative_avatars`: school, organization, creator, idempotency key + fingerprint, name, style, description,
  `generation_id` (unique, same school, the avatar's creation generation), created_at. Forced RLS, deny-all, immutable.
- `hon.create_creative_avatar(subject, school, input, provider, key, request, correlation)`: exact-school actor;
  idempotent per (creator, key); same key with a different body is `IDEMPOTENCY_KEY_REUSED`. Calls the unchanged
  `create_creative_generation` (so reserve, S4 pause and spend decision, eligibility, rate, wallet lock, 3-in-progress
  cap and finality re-checks all apply) under a key derived from the avatar key, then checks the generation is
  `IMAGE` with 1 unit and records the avatar. Fair use: at most 12 avatars per school that are not failed or refunded.
- A deferred constraint trigger refuses any `avatar.*` generation that has no avatar row at commit, so the generic
  generation path cannot create an orphan avatar charge. The API contract also refuses `avatar.*` on the generic route.
- `hon.read_creative_avatars(subject, school)` (newest 50) and `hon.read_creative_avatar(subject, school, avatar)`.
- Avatar view: `{ avatarId, schoolId, name, style, description, status, createdAt, generation }`, status from the
  creation generation: `GENERATING`→`CREATING`, `SUCCEEDED`→`READY`, `UNDER_REVIEW`→`UNDER_REVIEW`, anything else
  →`NOT_CREATED` (credits returned, or HQ charged without a usable image).
- The result is recorded by the existing `record_creative_generation_result` (requester only, never blocked by a pause).

**API**
- `GET /v1/schools/:schoolId/creative-studio/avatars` → `{ data: { provider, avatars, limit: 50 } }`
- `GET /v1/schools/:schoolId/creative-studio/avatars/:avatarId` → `{ data: CreativeAvatar }`
- `POST /v1/schools/:schoolId/creative-studio/avatars`, `Idempotency-Key`, `x-hon-human-command: saas-creative-avatar-create`
  → `{ data: { avatar, balance, replayed } }`. Same flow as a generation: create → one provider call with the avatar's
  name and style → record. A replay never calls the provider again; a stuck one is recorded UNKNOWN after 120 s.

**Web**: an Avatars card in Creative Studio with the school's avatars and a Create form (name, style, description,
cost from the published `avatar.create` rate). The generic Create form no longer lists `avatar.*` rates. EN/KO/ES.

## Tests (written first)
- Contracts: closed avatar input/view/list/receipt; generic input refuses `avatar.*`.
- API unit: not connected → 503 with no DB call; create → record once; replay; unverified result → UNKNOWN; guards.
- DB proof `test-creative-studio-avatars.mjs`: create charges the avatar rate; replay; key reuse 409; unpriced refused;
  generic `avatar.create` refused at commit; non-image rate refused; 12-avatar cap; sibling school cannot read;
  security inventory (runtime has no table access, only the three entry points).
- Web: avatar card states (not connected, unpriced, ready form, list statuses) in three languages.

## A2 contract (0277)

**Operation** `avatar.video`: HQ prices it as a VIDEO rate per second (`VIDEO_SECOND`). The school picks one of its own
READY avatars, a script (1..1000 characters, the generation's prompt), a length of 5..60 seconds (also bounded by the
rate's max units) and a format. The client never sends the operation, units, provider, model, price or school.

**Database** (`0277_creative_studio_avatar_videos.sql`):
- `hon.creative_avatar_videos`: immutable, forced RLS, deny-all; FKs to the school's wallet, the avatar `(id, school_id)`
  and the generation `(id, school_id)`; one row per `avatar.video` generation; `(creator, key)` idempotency.
- `create_creative_avatar_video(subject, school, {avatarId, script, seconds, format}, provider, key, request, correlation)`:
  exact-school actor → same-key replay (a different body is `IDEMPOTENCY_KEY_REUSED`) → the avatar must be this school's
  (`SAAS_UNAVAILABLE` otherwise) and READY, meaning its creation generation SUCCEEDED (`CREATIVE_AVATAR_NOT_READY`) → the
  unchanged `create_creative_generation` (`avatar.video`, units = seconds) → the rate must be VIDEO with units = seconds
  (`CREATIVE_AVATAR_RATE_INVALID`) → insert → the A1 finality re-checks (actor, `CREATIVE_MEDIA` spend, eligibility).
- `read_creative_avatar_videos` (newest 50) and `read_creative_avatar_video`: exact school only.
- The deferred commit guard from 0276 is replaced: `avatar.create` needs its avatar row, `avatar.video` its video row,
  and any other `avatar.*` operation is refused, so the generic route can never create an avatar charge.

**API**: `GET/POST /v1/schools/:schoolId/creative-studio/avatar-videos`, `GET …/avatar-videos/:videoId`, command
`saas-creative-avatar-video-create`. The avatar's look is read first under the requester's authority (nothing is
reserved if that fails), then create → one provider call with the avatar's name, style and description and the script
as prompt → record → read the video back. Production stays not connected (503); the synthetic runtime routes it to
`synthetic-avatar-video-1`. A real provider integration will also need the avatar's portrait asset server side; that is
out of scope until a provider is approved.

**Web**: a "Talking avatar videos" card after the Avatars card (avatar picker of READY avatars, script, seconds, format,
cost = per-second rate × seconds), the list with presenter, length, status and credits, and the same keyed fail-unknown
retry. EN/KO/ES.

**Tests**: contracts and API unit tests (`creative-studio-avatar-videos.test.cjs`), DB proof
`test-creative-studio-avatar-videos.mjs` VD1–VD11b, web tests (`creative-studio-avatar-videos.test.tsx`) and the local
mounted browser check (desktop and phone, axe).
