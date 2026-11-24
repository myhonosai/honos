# Talk to HON by voice: spec and plan (V1)

Owner ask (David, 2026-11-15): "Hey HON", HON answers out loud, and you keep talking back and forth.

## What exists today (checked on main 18572d9)
- Ask HON (`apps/web/src/components/hon-command/hon-conversation-panel.tsx`, API from #148, UI from #153) is typed chat only. It is shown wherever the HON launcher has a server-verified school (school app and the HQ pages that open HON for a school). HQ has no school-free HON conversation backend.
- `/staff/voice` (`voice-workspace.tsx`, `@hon/contracts` voice) is an inert "human handoff evidence" record. No microphone, no audio, no provider. Left unchanged.
- No code uses the browser's SpeechRecognition or speechSynthesis.

## Scope (V1, frontend only, no migration, no paid provider)
1. **Talk button** in the Ask HON composer. Tap, speak, HON gets the words as a normal question. Uses the browser's built-in speech recognition (Chrome, Edge, Safari). Firefox and others: the button explains voice is not supported in this browser.
2. **HON speaks its answer** with the browser's built-in voices (prefers on-device voices). A "Stop talking" button cuts it off. Long answers are trimmed when spoken ("the rest is on screen").
3. **Conversation mode**: after HON finishes speaking, it listens for a follow-up for about 8 seconds without needing the wake phrase. Saying "stop", "goodbye", "that's all" or "never mind" ends it.
4. **"Hey HON" hands-free** (separate switch): while the Ask HON panel is open and the tab is in front, HON waits for "Hey HON" (also "Hey HON, how many trials do we have?" in one breath). Ko: "헤이 혼", Es: "Oye HON".
5. Language follows the app language (en-US, ko-KR, es-US).

## Safety rules
- **Same path as typing.** A spoken question becomes the composer's text and goes through the exact same `send()`: same signed session, school, permission, readiness (`honReply`), AI spend limits, idempotency and audit on the server. Voice adds no API, no new permission and no new spend path.
- **Voice only asks questions.** It cannot confirm a suggestion, send a specialist request, approve anything or press any other button. Those stay tap-only.
- **Runaway spend guard.** Hands-free/conversation mode stops after 10 spoken questions in a row and needs a tap to keep going. A question needs at least 4 letters, so a cough or an "uh" never spends a question, on every path including "Hey HON". Nothing is sent while a previous question is still in flight.
- **Privacy.** Voice is off until the person turns it on, on that device, after a notice: the browser turns speech into text, and some browsers (Chrome, Edge) do that on the browser maker's servers. HON stores only the resulting text question, same as typing; no audio is recorded or stored.
  - "Hey HON" always-listening is offered **only when the browser can recognise speech on the device** (Chrome's on-device speech). Otherwise only the tap-to-talk button is offered, so no room audio is streamed anywhere while waiting for the wake phrase. (Owner may relax this later.)
  - Listening and speaking stop immediately when Ask HON conceals itself (window loses focus, tab hidden, page hidden, session ends) or the panel closes.
- **Not a paid provider.** Real cloud speech (e.g. paid TTS/STT voices) is out of scope and stays off until David approves it.

## Design
- `hon-voice.ts` (pure, tested): wake-phrase parsing per language, stop-phrase detection, speakable-text cleanup and trimming, browser support detection, and `HonVoiceController`, a small state machine (`OFF | IDLE | WAITING_WAKE | LISTENING | SENDING | SPEAKING | FOLLOW_UP | BLOCKED`) with injected recognition and speech adapters so it is tested with fakes.
- `hon-voice-control.tsx`: the controls in the composer (Talk, hands-free switch, Stop talking, status line with what was heard). Rendered by `HonConversationView` via a `voice` prop so existing tests keep working.
- `HonConversation` container: owns the controller, sends final transcripts through `send(text)` with `voice: true` on the pending command, and on that command's receipt speaks `receipt.reply` (or a short status line when there is no answer). Conceal and unmount call `controller.shutdown()`.
- Per-device opt-in kept in `localStorage` (`hon.voice.v1`), guarded by try/catch.

## Plan (TDD)
1. Tests for wake/stop parsing, speakable text, support detection.
2. Tests for the controller state machine with fake adapters (talk, wake, follow-up timeout, stop phrase, 10-question cap, shutdown, recognition errors, restart limits).
3. Render tests for the controls in each state and for unsupported browsers.
4. Container wiring + tests that a spoken question uses the same prepared turn as typing.
5. `pnpm --filter @hon/web test`, `check`, `build`; manual check in Chromium with a fake speech adapter.
6. Review, then PR.
