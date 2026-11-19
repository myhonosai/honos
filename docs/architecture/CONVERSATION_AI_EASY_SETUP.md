# Conversation AI, easy setup (CE series)

Owner request (David, 2026-11-19): learn what GoHighLevel's Conversation AI does, then rebuild HON's screens so a
martial arts school owner can set it up faster than in GoHighLevel. **Not a copy of GoHighLevel's layout.**

Backend reused as is: 0364 inbox, 0420 Train AI (settings, training library, knowledge pack), 0424 history.
Migration 0563 (coordinator; 0546 released) is CE2, the "Try it" test chat. No other new numbers.

## 1. What GoHighLevel does, and what is hard about it

GoHighLevel's help center (help.gohighlevel.com) was not reachable from the build machine; this list comes from
public search snippets of its articles ("Conversation AI Bot Explained", "How to Set Up a Conversation AI Bot",
"Guided Form Based Setup") and general product knowledge.

| GoHighLevel feature | What it does | What is hard for a school owner |
|---|---|---|
| Bot modes: Off, Suggestive, Auto-Pilot | Off is the default; Suggestive drafts replies staff send; Auto-Pilot replies itself | Jargon names; mode lives in a settings drawer per bot |
| Channels | Mode per channel (SMS, chat widget, Facebook, Instagram, ...) | Separate toggles per channel, easy to miss one |
| Bot training | Web URLs / crawler, FAQ question-answer pairs, rich text, files | Blank page: owner has to think of every question |
| Bot goals / actions | Book an appointment on a chosen calendar, collect info, hand over to a human, stop the bot, trigger a workflow | Many options, each with its own form |
| Personality | Bot name, tone, response delay, max messages | Fields with no guidance |
| Test bot | Test panel before going live | Separate place from the training |
| Inbox suggestions | Suggested reply above the composer, staff edit and send | Needs the inbox and the bot both set up |
| Guided setup | A form wizard creates the bot | Wizard is one-shot; later edits are back in the drawers |

## 2. HON design: one page, three plain questions

Route `/staff/conversations/train-ai` (unchanged; the nav tab keeps its place). Page title "Conversation AI".

**Top status card** (always visible): one sentence that says what the AI is doing right now, a coloured dot, and what
HQ allows, in plain words:
- HQ OFF: "HON hasn't switched AI replies on for schools yet. You can set everything up now; it will be ready when it does."
- HQ TEST_MODE: "Practice mode: AI replies are only shown to staff, never sent to families."
- HQ LIVE: nothing extra.

**Setup checklist** (replaces the guided wizard, and stays on the page until done): 1 Choose how the AI helps,
2 Add at least 5 answers, 3 Check the hand-off words, 4 Try it (CE2). Each line is ticked from real data and jumps to its tab.

**Tabs** (at most four):
1. **How it helps**: three big choice cards instead of jargon. *Off*. *Suggest replies*: "AI writes a reply, you
   check it and tap send" (ASSIST). *Reply for me*: "AI answers by itself and passes the conversation to you when it
   should" (AUTOMATIC). One choice applies to every channel; "Choose per channel" opens one row per channel
   (Texts, Website chat, Email) with a three-way switch. The old separate "use at this school" checkbox is gone:
   the school is on when any channel is not Off (saved `enabled` = any channel on), so saving the modes also switches the
   school on or off. Languages are chips.
2. **What it knows**: a **martial arts quick start**: tap a common question (free trial, prices, ages, what to wear,
   schedule, contracts, adult classes, parking, belt testing, makeup classes) and only type the answer. Then the
   school's own answers as cards with an on/off switch, Edit and Remove. "Upload a file" (schedule, price sheet, scripts,
   pictures) and "Rules for the AI" (instructions such as "Always invite them to a free trial class") sit in the same tab.
   A small line shows what it also reads automatically (plans, booking types, school articles), from the knowledge pack.
3. **When to hand off**: hand-off words as removable chips with an add box, an after-hours text, and reply length as
   three presets (Short 160, Normal 320, Long 640 characters) for texts and chat, with the exact number still shown.
4. **Try it** (CE2, migration 0563, section 6): a chat box on the same page. Staff type a question, the AI answers from the same
   knowledge pack; nothing is sent to anyone and no conversation changes; the call is metered through S4. Under each
   answer: "Use a better answer" saves a coaching card (0420 COACHING) with the question and the staff's answer.

Everything uses `--hon-*` tokens (dark shell adapter), works in Big Button / Modern / Classic, phone width, en/ko/es.

## 3. Rules kept from 0420
- Every call carries the shell school scope; the server re-checks `conversation.read` / `conversation.ai.configure`.
- Commands keep one idempotency key per unconfirmed change (unknown outcome keeps the key).
- Privacy event clears everything on screen.
- Read-only staff see the page with controls disabled and a one-line reason.

## 4. Pieces
| Piece | What | Migration |
|---|---|---|
| **CE1** | New page (status, checklist, tabs 1-3), quick start, chips, presets. Frontend only. | none |
| **CE2** | "Try it" test chat: a CONVERSATION_TEST kind on the shared AI text caller (0550), one staff command that plans, calls the approved provider with the trimmed knowledge pack and records usage; the text is never sent; "Use a better answer" -> coaching card. | 0563 |
| CE3 | Suggested reply box for the inbox composer (handed to "Redesign texts and email pages" to mount). | ask |
| CE4 | Goals: "Book a free trial class" using the school's booking type (old CA3 design). | ask |

## 5. Tests (CE1)
- Pure helpers: mode summary from settings (all same / mixed), `enabled` derived from modes, checklist state,
  quick start suggestions hide questions already answered, hand-off chip add/remove validation, length presets.
- Render: status sentence per HQ program, tabs, read-only disables controls, quick start fills the question.
- Existing 0420 http tests stay unchanged.

## 6. CE2 "Try it" (0563)
- **Shape.** One test = one row on `hon.ai_text_proposals` (0550) with kind `CONVERSATION_TEST`: agent `chad`, task
  `DRAFT_FOLLOW_UP` (HQ's CHAD_SALES profile), 12,000 input / 600 output tokens, at most 20,000 micro-units. The shared core
  owns the one S4 wiring (pause, access, school limit, organization budget, UNKNOWN queue, late expenses, HQ usage), so no
  shared S4 function is rewritten. HQ usage shows it as `CONVERSATION_TEST`.
- **Who.** `conversation.ai.configure` (0420 actor) plus what the planner needs anyway: `ai.invocation.plan`, Chad's
  capability `crm.assistant.follow_up_draft`, and the live Complete plan. A staff member sees only their own tests.
  The HQ program switch and the school's channel modes are not required, because a test reaches no family.
- **Facts.** Built inside prepare from `hon.school_ai_knowledge` only, in a closed shape under 9,000 bytes (school, tone,
  languages, reply length, hand-off words, rules, answers, plans, booking types, articles, documents). The API sends no facts.
- **Answer.** `{reply (1-1600), needsStaff}`. Anything else is recorded with its usage and shown as "not answered". A
  recorded answer is closed at once (APPLIED). An unknown outcome keeps its hold for the HQ owner and is never retried.
- **Limits.** 30 test questions per staff member per 10 minutes. A key replay never makes a second call.
- **Runtime.** `OpenRouterConversationTestRuntime`: fixed URL, no redirects, no tools, no fallback, 60 s timeout, bounded body.
  It sends nothing unless `OPENROUTER_API_KEY` is set and `OPENROUTER_PAID_CALL_APPROVED=true` (an owner decision); until
  then the tab says the AI service is not connected yet and no question is charged.
- **Proofs.** `packages/database/scripts/test-conversation-ai-test-chat.mjs` (real API services, runtime role, fake
  provider, 9 groups), `apps/api/test/conversation-ai-test.test.cjs`, `apps/web/test/conversation-ai-try-it.test.tsx`, and the
  browser proof's two Try it checks.
