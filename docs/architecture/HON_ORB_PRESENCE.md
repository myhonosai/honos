# HON orb presence (living assistant animation)

Owner request 2026-11-17: make the HON orb feel alive, like a film AI assistant, in HON's own style
(no copied film visuals). Frontend only; no migration, API, provider or data change.

## Spec

One component, `HonOrb` (`apps/web/src/components/hon-command/hon-orb.tsx`), draws the existing orb art
(`/ai/hon-core.webp`) with layers made in CSS and one small inline SVG:

- aura: soft glow behind the orb that breathes;
- shimmer: a slow rotating light sweep over the core;
- two tilted orbit rings that precess at different speeds, each with a travelling spark;
- a thin outer ring with eight tick marks (HON's own detail: the eight directions of a martial arts stance);
- two ripples that pulse outward while HON speaks.

States (`data-orb-state`):

| State | When | Look |
| --- | --- | --- |
| `idle` | Dashboard, screensaver, voice off/ready, microphone blocked | slow breathing, slow rings |
| `standby` | hands-free waiting for "Hey HON" | idle plus a faint attentive pulse |
| `listening` | Talk to HON / follow-up | brighter, rings faster, glow grows with each burst of recognised speech |
| `thinking` | question sent, waiting for HON | rings spin fast in opposite directions, sweeping scan arc |
| `speaking` | HON reads its answer aloud | ripples out, the core swells with each spoken word |

Voice level without a second microphone: the browser's speech recognition already owns the microphone,
so the orb never opens its own audio stream (no new permission, no audio analysed or kept). Instead,
`listening` reacts to each new piece of recognised text and `speaking` reacts to the speech engine's word
boundary events, with a gentle synthetic talking rhythm for voices that do not report word boundaries.

Performance and accessibility:

- CSS animates only `transform` and `opacity` (plus a tiny SVG dash offset for the two sparks); the one script loop (requestAnimationFrame) runs only
  while listening or speaking and only writes one CSS variable (`--orb-level`);
- `prefers-reduced-motion: reduce` stops every animation and the loop (the orb is shown still);
- the orb is decorative (`aria-hidden`); the existing voice status line remains the spoken/visible status.

Placement: Home dashboard HON card (idle), school screensaver (idle), and the Ask HON voice controls (live states).

## Plan

1. `hon-orb-signal.ts` (pure): decaying energy signal, `orbLevel(state, energy, now)`, `honOrbStateFor(voiceState)`,
   `heardPulse(previous, next)`. Unit tests first.
2. `hon-voice.ts`: `browserSpeech(win, { onWord })` reports word boundaries and chunk starts. Unit test with a fake synth.
3. `hon-orb.tsx` + `hon-orb.module.css`: the component and the frame loop (skipped for reduced motion). Render tests.
4. Wire: `useHonVoice` owns a signal (word and heard pulses); `HonVoiceControls` shows the live orb; Home and the
   screensaver use `HonOrb`. Update existing render tests.
5. Browser check (desktop and phone, each state, reduced motion), `pnpm --filter web test`, `check`, focused lint.
