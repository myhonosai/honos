# AI team group chat (Team chat on the school Dashboard)

Status: source only, not deployed. Fake/stand-in providers only; the real runtime stays behind
`OPENROUTER_PAID_CALL_APPROVED`. Browser speech only (as Ask HON voice, PR #389); no paid voice.

## Owner ask (David, 2026-11-17)

"Yes" to voice for the other agents. "Where in dashboard I can speak to all of them or take turns as we change
topics. But best is group chat setting so all plans can be planned together with agents."

## What it is

A **Team chat** card on the school Dashboard (Home), in Big Button, Modern and Classic. It is one HON conversation
shown as a group chat:

- **Everyone** (default): one question goes to HON and then to every specialist who can answer in text for this
  person now (Claire, Alex, Jordan, Lena, each only when readiness offers them). Each answer appears as that teammate's
  chat message with their portrait and name.
- **Take turns**: tap a teammate (or start a message with "@Jordan" / say "Jordan, ...") and the next messages go to
  that teammate only, until you pick someone else. Topic changes are just picking another teammate.
- **Make a plan together**: after the team answered, one tap asks HON (detailed answer) to combine what everyone said
  into one plan that names which teammate each point comes from. This needs migration 0451 (below).
- **Voice for every agent**: tap-to-talk sends the spoken question exactly like a typed one; each answer is read
  aloud in the browser with the teammate's name first ("Jordan says: ...") and a slightly different browser voice per
  teammate. "Hey HON" hands-free works as in Ask HON (on-device recognition only).

Marcus, Chad, Kai and Maya are shown as team members. They do not chat in text yet: Marcus and Chad write drafts for
one campaign or lead, Kai prepares classes, Maya answers about one at-risk student. Their card says where to ask them
(HON suggests them; confirming opens their draft flow as today). Letting Chad and Marcus answer plain questions is a
later backend piece (needs its own migration number).

## Rules (unchanged security)

- Every message is an ordinary turn on the existing `POST .../hon/conversations/:id/turns`: the server re-checks the
  person, school, capability, AI access, HQ pause, per-school cost ceiling and budget lock for each one. "Everyone" is
  several ordinary turns, sent at the same time (2026-11-28: one after another took ~37 s live for five answers); each
  has its own idempotency key and exact-retry on an unknown outcome, and a retry resends only to the teammates who have
  not answered. Each answer appears as it arrives. The server already serializes turn creation on the conversation row
  (`FOR UPDATE`), so parallel turns get distinct sequence numbers. Nothing is sent, scheduled or changed by any agent.
- HON knows HON OS itself (2026-11-28): its prompt ends with a fixed product guide (`HON_OS_PRODUCT_GUIDE`: the team
  chat, voice, "Make a plan together", the menu headings). The specialists answer a question about HON OS in one or
  two sentences and hand it to HON.
- Input size (2026-11-28): the pre-send check estimates tokens as half the UTF-8 bytes plus 128 (was: bytes). With six
  team turns of history a follow-up to HON and every "Make a plan together" were over the byte rule and refused before
  sending. The database still holds any answer whose reported input tokens exceed the plan's budget.
- The AI team is included in HON OS; nothing is charged per message. The existing internal $0.08/call ceiling and
  per-school limits apply to every turn.
- The browser decides nothing: who may answer comes from the server's readiness.

## Backend: migration 0451 (HON reads the team's answers)

Before 0451 HON's history showed a specialist's turn only as `delegatedTo` (never the answer), so HON could not
combine the team's views. 0451 changes `hon.prepare_hon_reply` (0284 body plus this change only):

1. HON's history is the last 6 turns (was 3). An earlier COMPLETED Claire, Alex, Jordan or Lena answer is included as
   `answer` (first 900 characters) next to `delegatedTo`, only while `hon.hon_reply_source_allowed` says this person
   may see it now.
2. The permissions behind the included answers are stored on HON's invocation (`source_permissions`), re-checked at
   the live clock before anything leaves prepare, and conceal HON's plan later if any lapses (the 0260 rule).
3. `available_sources` marks `specialistResults` when team answers were included.
4. Maya's answers (one named student's record) and the draft specialists' work never reach HON as text; HON rows may
   never carry Maya's retention or tuition permissions (table check).

The HON system prompt explains that `delegatedTo` + `answer` entries are teammates' answers and how to build a plan.

Evidence: AI-0 INV-44 (new) and INV-36 (updated: HON now sees visible team answers).

## Plan (slices)

1. **0451 backend** (this PR): prepare change, table check, prompt, AI-0 INV-44.
2. **Team chat web** (next PR): `hon-team-chat.tsx` card on Home for all three modes, Everyone/Take turns,
   Make a plan together, member strip with readiness, voice per agent (agent voice profiles in `hon-voice.ts`),
   en/ko/es copy, unit tests and browser screenshots.
3. **Later**: Chad and Marcus plain-question answers (new migration), Maya aggregate answers.

## Voice choices per teammate (0460)

Owner ask (2026-11-17): "choose voice for all AI agents, give few choices each".

- **Choices:** three free browser voices per teammate (HON, Claire, Alex, Jordan, Lena, Marcus, Chad, Maya, Kai). Choice 1 is the voice each teammate already had; choices 2 and 3 change pitch, pace and which of the device's own voices is used (`HON_AGENT_VOICE_OPTIONS` in `hon-voice.ts`, labels Usual / Warm / Bright / Deep / Calm / Lively in en/ko/es). The device decides which voices it has, so the same choice can sound different on each phone or computer.
- **Saved to the account:** `hon.principal_agent_voice_preferences` (migration 0460): one row per person, school and teammate, `voice_choice` 1-3, forced RLS per school, runtime SELECT/INSERT/UPDATE only. `GET/PUT /v1/organizations/:org/schools/:school/agent-voices` with the personal interface-preference permissions (`settings.interface_theme.read/update`), the scope from the verified identity, an Idempotency-Key per change, audit + outbox. No row means choice 1.
- **Where:** "Choose voices" in the Team chat card: each teammate's three voices with a ▶ to hear a sample first (nothing is saved by hearing). A change shows at once and is saved; if saving fails the previous voice comes back with a note. Only the newest request may change what is shown.
- **Used by:** the team chat reads each answer in the chosen voice; Ask HON reads HON's answers in HON's chosen voice.
- **Not:** no paid or cloud voice, no provider, no AI call, no spend. Paid natural voices stay off until the owner approves them.
