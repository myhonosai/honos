# Eian natural voice (E-V2)

**Status:** built and tested with a fake speech provider. Not deployed, not switched on, no paid call from HON's servers. (Voice samples and two timing clips were made by hand on the owner's $2 sample key.)

**Owner approval (David):**
- 2026-11-21 04:09Z, after trying the phone voice: "Need voice that matches image" (Eian is a young boy).
- 2026-11-21 04:15Z: chose "Yes, plan it with exact costs" for a paid natural voice.
- 2026-11-22 06:51Z: picked sample **8** after hearing ten samples. "Eian" is said "Ian".

This covers building the path. A real call from HON still needs every owner step in "Turning it on".

## Goal

In the HON Family app, Eian's answers are read aloud in one fixed child voice instead of the phone's built-in voice. If the natural voice is off, over a limit, slow or failing, the app reads the same answer with the phone voice (#555, #561) and nothing else changes.

## The voice

- Provider path: OpenRouter `POST https://openrouter.ai/api/v1/audio/speech`, model `fish-audio/drama-3`, provider Fish Audio.
- The voice is locked with a **reference clip**: the sample David picked (12.8 seconds, a synthetic voice, not a recording of a real child) plus its transcript, sent as `input_references` on every request. Three test lines came out at 340, 340 and 320 Hz against 340 Hz for the reference; a fourth with a 103 KB MP3 reference came out at 333 Hz.
- The reference clip ships inside the API as a constant (`apps/api/src/eian/eian-voice-reference.ts`, 103 KB MP3, 64 kbps mono, sha256 `ff89e6b4…`), so no build step has to copy a file. It holds no family data.
- Delivery instruction: "Cheerful and friendly." The spoken text never carries instructions (one provider read them aloud in testing).
- "Eian" is said "Ian" (owner, 2026-11-22). The server writes the name that way in the words it sends; the screen still shows "Eian".
- Measured speed on 2026-11-22: 2.5 seconds for a 143-character answer, 6.2 seconds for 542 characters.
- Measured price on 2026-11-22: $10 per 1,000,000 characters. A 65-character line with the instruction cost $0.0009 as reported by OpenRouter's generation record. A typical 150-character answer is about $0.002; the longest allowed answer (1,500 characters) is about $0.015.

## What is spoken

- Every Eian answer the app would read aloud today: guided answers (made on the phone) and AI answers.
- The app sends the exact text it would have given the phone voice (`spokenText`, at most 1,500 characters). The server does not accept any other field.
- The app asks for the natural voice only for answers up to 600 characters (about 7 seconds to make). Longer answers are read by the phone voice.
- The server speaks only plain text: no control characters, no links, at most 1,500 characters. It masks emails and ids like the Eian facts do. It does not check the text against the family's records, because guided answers are made on the phone. The limits below bound what a modified app could cost.

## Who can use it

The same scope and gate as Eian AI (`hon.eian_scope`, `hon.eian_access`, the 4-argument `ai_spend_allowed`, the organization ceiling). A school without the gate, or with AI paused, gets the phone voice.

## Limits

Owned by the database (`hon.eian_speech_limits()`), mirrored in `@hon/contracts`:
- at most 1,500 characters and 20,000 provider microunits ($0.02) per clip
- burst: 20 new clips per guardian per rolling 10 minutes
- **per family per day: 60 clips** (UTC day)
- per school per month: the existing school cost ceiling and organization credit ceiling; speech counts in both
- credits: 1 credit per started 1,000 characters

David said "no limit or cap" for Eian AI questions (D3). The daily family limit here is new and is for speech only; it is in the plan he approved ("per-family daily cap"). The number 60 is this spec's proposal.

## Data model (migration number from the coordinator)

`hon.eian_speech_clips`: forced RLS, no policies, no grants, the four S4 triggers.
- organization, school, family, guardian, idempotency key (unique per guardian)
- `text_digest` (sha256) and `characters`. **The text and the audio are not stored.**
- status `PENDING`, `BLOCKED`, `CONFIGURATION_REQUIRED`, `SENDING`, `COMPLETED`, `FAILED`, `UNKNOWN`; reason code
- `reserved_credits`, `held_at`, `usage_id`, `provider_request_id`
- No route plan and no work item: the provider and model are fixed in `hon.eian_speech_limits()`, so no HQ routing policy applies.

Functions (SECURITY DEFINER, runtime gets execute only):
- `read_eian_speech_status(subject, ready)` returns `{ voice: 'NATURAL' | 'PHONE', reason }`
- `begin_eian_speech(subject, key, digest, characters)`: scope, gate, burst and daily limit under a per-guardian lock; replay returns the same clip
- `prepare_eian_speech(subject, clip, ready)`: budget lock first, S4 decision, ceilings, reservation, then `SENDING`
- `fail_eian_speech(subject, clip, outcome, reason)`: `PRE_SEND` and `FAILED` release the hold, `UNKNOWN` keeps it for the HQ queue
- `record_eian_speech_result(subject, clip, result)`: one ledger row (`modality` VOICE_OUTPUT, `spend_class` AGENT_INFERENCE, measured characters and provider-reported cost), releases the hold. A cost above the per-clip maximum is still recorded and the clip is marked `FAILED` / `RESULT_BUDGET_EXCEEDED`.

The shared S4 functions gain the agent `EIAN_SPEECH`, as 0474 did for `EIAN`: committed credits, open holds, school committed cost, unknown validate and resolve, late expense, HQ unknown queue, HQ school usage. When HQ records the cost of an unknown clip, the evidence field `inputTokens` carries the clip's characters.

The HQ AI screens now also know the agents `EIAN` and `EIAN_SPEECH` (contracts and labels). Before this, usage from an Eian answer would have made the HQ usage read fail its shape check.

## API

| Route | Guard | Notes |
|---|---|---|
| `GET /v1/parent/eian/speech/status` | `EianReadGuard` | `{ voice, reason }`; never a provider, model or amount |
| `POST /v1/parent/eian/speech` | human UI command `parent.eian.speak`, `Idempotency-Key` | Body `{ text }`. Returns `{ audio: <base64 mp3>, mime: 'audio/mpeg' }`. |

- One provider attempt, fixed URL, no redirects, no fallbacks, `provider: { allow_fallbacks: false, data_collection: 'deny' }`, 30-second timeout.
- **The cost arrives after the sound.** OpenRouter publishes a call's cost record (`X-Generation-Id`) more than 5 seconds after the audio. So the API returns the verified audio while the clip is still `SENDING` (its hold still counts against the budget) and records the provider-reported cost in the background at about 6, 12 and 24 seconds. If the cost never arrives, or the API restarts first, the clip keeps its hold and goes to the HQ queue as `UNKNOWN`, like any other call with an unknown outcome.
- If the audio itself cannot be verified (wrong type, not MP3, no generation id, any 5xx or network error), the clip is `UNKNOWN`, no audio is returned and it is never resent.
- A replay of a finished clip returns 409 `EIAN_SPEECH_ALREADY_MADE` (audio is not stored); the app falls back to the phone voice. A replay never calls the provider again.
- Errors: 503 `EIAN_SPEECH_UNAVAILABLE`, 429 `EIAN_SPEECH_BUSY`, 429 `EIAN_SPEECH_DAILY_LIMIT`, 503 `EIAN_SPEECH_OUTCOME_UNKNOWN`.
- The runtime is inactive unless `OPENROUTER_API_KEY` is set, `OPENROUTER_PAID_CALL_APPROVED=true` and the new switch `HON_EIAN_NATURAL_VOICE_APPROVED=true`.

## App

- New `createNaturalEianVoice(api, phoneVoice, player)` implements the existing `EianVoice` interface, so `EianScreen` does not change.
- `speak(text)`: if status says NATURAL, request the clip and play it; on any failure, a slow clip, or a stop, use the phone voice (or stay silent if stopped). The wait is 3 seconds plus 12 ms per character (4.8 seconds for 150 characters, 10.2 at most). Leaving Eian or signing out stops playback and drops the audio.
- The status is checked once per 5 minutes. A definite refusal (not included, limit reached) sends the next answers straight to the phone voice for 5 minutes (1 minute for the burst limit). A clip is never asked for twice.
- The clip is written to the app's private cache only while it plays and deleted when it ends or is stopped (iOS cannot play audio from memory). It is never saved or shared.
- Needs `expo-audio` and `expo-file-system` (native modules), so a new build. Background playback is off.
- On-screen wording: "Reading aloud uses Eian's voice when your school has it on. Eian's voice is made by a speech service: the words of the answer, which can include your children's names, are sent to it. No recording of you is sent. Otherwise your phone's own voice reads the answer."

## Privacy

- Sent to OpenRouter and Fish Audio: the answer text and the fixed reference clip. Not sent: the parent's audio, ids, contact details.
- Requests ask for no data collection. Before turn-on, the owner confirms the provider's no-training terms (same step as #478 for text).
- HON stores a digest and a character count, not the words or the sound.

## Turning it on (owner steps, none done)

1. Deploy the API with the migration.
2. Set `HON_EIAN_NATURAL_VOICE_APPROVED=true` on hon-api (the OpenRouter key and paid-call switch are the same ones Eian AI uses).
3. Confirm the provider no-training setting.
4. Install the new app build.

## Tests

- Database proof script over signed HTTP with a fake speech provider: scope, gate, limits (burst, daily), replay, every outcome, HQ queue and usage, direct SQL refusals, ACLs.
- API unit tests for the runtime: request shape, no instructions in the text, cost verification, UNKNOWN rules.
- App tests: natural voice plays, each fallback, stop, leave, sign-out, wording.
- AI-0 spend inventory updated.

## Not in this slice

- The microphone side stays on the phone's speech service.
- No per-school voice choice, no other languages.
- Long answers (over 600 characters) in the natural voice. That needs streamed or sentence-by-sentence playback.
