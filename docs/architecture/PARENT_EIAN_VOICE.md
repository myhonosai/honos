# Eian voice in the parent app

Owner ask (2026-11-21): the family app had no voice. Eian can now read answers aloud and take a question by voice.
App only: no server change, no migration, no paid service, no new account.

## What it does

- **Read aloud.** Every Eian answer has "Read aloud" / "Stop". It uses the phone's own built-in voice (`expo-speech`).
  Only the answer lines are spoken, never the source label or the button.
- **Ask by voice.** A microphone button beside "Ask". One tap hears **one** question (`continuous: false`), shows the
  words in the question box as they are heard, then asks it through exactly the same path as a typed question (same
  300-character cap, same guided-or-AI choice, same idempotency key rule). The answer to a spoken question is read aloud;
  a typed question is not read until the parent asks.
- **Stops by itself.** Asking again, leaving the Eian tab, signing out or closing the screen cancels listening and stops
  reading. Nothing listens in the background and there is no wake word.

## Boundaries

- Voice only fills the question box. It cannot book, pay, send or sign; those rules are unchanged.
- Speech-to-text is done by the phone's own speech service (`expo-speech-recognition`: Google's on Android, Apple's on
  iPhone), which may process the audio off the phone under the phone maker's terms. No audio and no transcript beyond
  the question itself goes to HON. The screen says so in plain words.
- The microphone permission is asked the first time the parent taps the button, with the stated reason. Refused or
  unavailable: a plain note, and typing keeps working. A phone with no speech service shows no microphone button.
- English (`en-US`) only in this slice.
- Answers are read aloud in the room and can include names and invoice amounts; reading is always the parent's tap or
  the parent's own spoken question.

## Code

`apps/parent-mobile/src/eian/voice.ts` (interface, context, spoken text, notes), `expo-voice.ts` (phone adapter),
`EianScreen.tsx` (buttons and stop rules), `ParentApp.tsx` (`voice` prop), `app.json` (plugin and permission wording).
Tests: `test/eian-voice.test.tsx`, `test/eian-expo-voice.test.ts`.

## Needs a new build

`expo-speech` and `expo-speech-recognition` are native modules and Android gains `RECORD_AUDIO`, so this reaches
phones only with a new build. Not yet checked on a real phone with a real microphone.
