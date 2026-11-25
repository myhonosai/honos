# Staff agent speech (0652)

Owner ask (2026-11-22): "Let's use Gemini voices for all agents." Each of the nine school AI teammates reads its answer
aloud in its own Gemini voice. If that voice cannot be used, the browser's own voice reads it, so a reply is always heard.

## Voices

| Agent | Gemini voice |
|---|---|
| HON | Kore |
| Maya | Leda |
| Chad | Puck |
| Kai | Charon |
| Alex | Orus |
| Jordan | Iapetus |
| Marcus | Fenrir |
| Claire | Despina |
| Lena | Aoede |

The model is `google/gemini-3.8-flash-lite-tts` through OpenRouter, with `allow_fallbacks: false` and
`data_collection: 'deny'`. No style instructions are sent, because the model reads them aloud.

## Path

UI (`agent-natural-voice.ts`, wrapped around the browser voice in HON chat, team chat and each agent panel)
-> `GET|POST /api/v1/organizations/:org/schools/:school/agents/:agent/speech`
-> human UI guards (`agent.speech.read`, `agent.speech.speak`) and `resolveAuthorizedScope` with `ai.agent.<agent>.use`
-> `AgentSpeechService` -> database functions in migration 0652.

- `hon.read_agent_speech_status` returns `NATURAL` or `BROWSER`, with a reason: `NOT_INCLUDED`, `PAUSED`,
  `NOT_CONFIGURED` or `BUDGET_REACHED`.
- `hon.begin_agent_speech` checks the person's per-staff agent switch (0635, `hon.principal_has_ai_agent`), the limits
  and the S4 spend holds. It then reserves the clip under an idempotency key.
- `hon.prepare_agent_speech` gives the runtime its one fixed provider request.
- `hon.fail_agent_speech` records a failure.
- `hon.record_agent_speech_result` settles the real cost later. The cost is read from OpenRouter's generation record
  at 6, 12 and 24 seconds; the audio is returned to the person before that.
- `hon.agent_speech_clips` has forced RLS, stores no audio and no text (only a digest and a character count), and
  carries the four S4 guard triggers.

## Limits (proposal, not owner-approved numbers)

- 1,000 characters a clip and 20,000 µ$ a clip.
- 30 clips a person in 10 minutes, and 200 clips a person in a UTC day.
- 1 creative credit for each started 1,000 characters.

At about $0.00023 for 1.5 seconds, a busy school is about $3 a month.

## Switch

Off by default. It needs all three of these on the API:

- `OPENROUTER_API_KEY`
- `OPENROUTER_PAID_CALL_APPROVED=true`
- `HON_AGENT_NATURAL_VOICE_APPROVED=true`

## Turning it on (owner steps)

1. Deploy migration 0652, after 0635 and 0638, with the API and web.
2. Set `HON_AGENT_NATURAL_VOICE_APPROVED=true` on the API, which David has to OK first.
3. Keep Google via OpenRouter as the only provider.

## Evidence

- `packages/database/scripts/test-agent-speech.mjs` (AS1): 11 groups, fake provider only, no network calls.
- `apps/api/test/agent-speech.test.cjs` and `apps/web/test/agent-natural-voice.test.ts`.
