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
  several ordinary turns, sent one after another; each has its own idempotency key and exact-retry on an unknown
  outcome. Nothing is sent, scheduled or changed by any agent.
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
