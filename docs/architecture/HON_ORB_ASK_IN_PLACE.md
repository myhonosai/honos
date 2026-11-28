# Ask HON right from the dashboard orb

Owner ask (David, 2026-11-27): pressing the HON orb card ("Ask HON anything", mic and expand icons) on the HQ
dashboard sent him away to the HON workspace. "This should be working from here, not sent to workspace. Same for
school CRM dashboard HON." Frontend only. No migration, no new API, no paid provider, no new switch.

## Spec

**Where.** The HON card in the HQ dashboard command stage (`hq-modern/dashboard.tsx`, `CommandStage`) and the HON card in
the school Home hero (`home/view.tsx`, `honCore`).

**What the card offers.** One bar with three controls:

| Control | Before | Now |
| --- | --- | --- |
| "Ask HON anything" | HQ: opened the side assistant (full screen on phones). School: navigated to `/staff/hon` | Opens a HON chat **anchored to the card** on the same page, cursor in the question box |
| Microphone | Decorative icon | Opens the same chat and starts listening at once (tap-to-talk). The answer is shown and read aloud |
| Expand | Decorative icon | Opens the full HON workspace as before (HQ: the side assistant; school: `/staff/hon`) |

**The in-place chat.**
- A non-modal panel directly under the card, over the page (the dashboard stays visible and usable). Close (X) and
  Escape fold it back into the card and return focus to the card. It keeps its content while folded within the page.
- HQ: the real HQ Ask HON (`HqHonPanel`, agent `hon`, compact) — the server decides access, budget, provider and
  every rule exactly as in the side assistant. Nothing new is sent or stored.
- School: the real school Ask HON conversation (`HonConversation`, `dock` presentation, the one the corner HON uses),
  for the school the shell already verified (the same scope the Home Team chat uses). Same conversation as the full
  workspace and the corner chat.
- Voice: the existing browser speech (`useHonVoice`): a spoken question goes through the same ask path as a typed one.
  HQ answers are read with the browser voice; school answers in HON's chosen voice (existing 0652 path).
  Pressing the microphone is the person turning voice on (remembered on this device, as "Turn on voice" was). The voice
  controls now keep the privacy line ("Your browser turns your speech into text… HON gets only the text… No audio is
  recorded or saved by HON") on screen while voice is on, everywhere they appear. Turning voice off stays available.
- Escape (focus in the chat, or dropped to the page after sending) and the X fold the chat; a tap outside does not, so
  the answer can be read while using the page. The newest answer is scrolled into view.

**Unchanged.** The HQ "How can HON help today?" composer, the HQ "Ask HON anywhere" launcher on other pages, the
school corner HON, the full workspaces, all permissions and server checks.

**Out of scope.** New voices, hands-free defaults, any server change.

## Plan

1. `useHonVoice`: add `talkNow()` (turns voice on, remembers it, starts listening).
2. HQ: extract the ask logic of `HqHonPanel` into `useHqHonAsk` with `askText(text, spoken)`; `HqHonPanel` keeps its
   behaviour. Add optional voice to the panel (`voice`, `startVoice`) that sends spoken questions through `askText` and
   reads the answer back with `honVoiceReplyText`.
3. HQ dashboard: `HqHonOrbAsk` card bar (ask, mic, expand) and an anchored chat panel.
4. School: `HonConversation` gets `startVoice`; new `HonHomeAsk` card bar and anchored chat; `SchoolHomeView` takes an
   optional `honAsk` node (pure renders keep the old link).
5. Tests: `test/hon-orb-ask.test.tsx` (bars, expand targets, one ask path, voice start, privacy, copy); browser proof
   `scripts/hon-orb-ask-browser.mjs` (synthetic fixtures, fake speech): typed and spoken questions answered on the card,
   expand, Escape and focus return, desktop/tablet/phone fit, for HQ and school.
