# HON follow-up questions and answer sources (migration 0254)

Status: spec + plan, 2026-11-11. Inspired by public assistant patterns (suggested follow-ups, cited sources); no third-party
branding, characters or voice. Research: `/mnt/project-files/grok-ideas/GROK_IDEAS_FOR_HON_AI.md`.

## Goal

After a complete answer from HON or Claire, show:

1. **Ask next**: up to 3 short follow-up questions. Tapping one only puts the text in the composer; the person still presses
   Send, and it is an ordinary question turn with the normal mode, limits and S4 controls. Nothing runs by itself.
2. **Based on**: up to 5 chips naming the school fact areas the answer used (e.g. "New leads (24h)", "Earlier conversation").
   A chip can only name a fact area the server actually sent with that answer, so a model cannot cite something it never saw.

No new cost class, no new spend path, no new AI call, no tone change, no stored personal data (questions are model text of
the same kind as the reply, bounded and plain).

## Model output format (closed trailer lines)

At the very end of the answer, each optional and at most once, in any order:

```
SOURCES: newLeads24h, conversation
ASK: Which leads have not been called yet? | How many trials are booked this week?
SUGGEST: chad            (HON only, unchanged from 0214)
```

The runtime peels trailer lines off the bottom while each line is a known kind not seen yet. Rules:

- **SOURCES**: keys from the closed set `HON_REPLY_SOURCE_KEYS` (the 11 Command Center metric keys, plus `conversation`
  and `specialistResults`). Unknown keys are dropped; distinct; at most 5, in order.
- **ASK**: split on `|`; each item trimmed, 3–150 characters, no control characters, no `<`, `>`, `http`, `www.` or `://`,
  distinct ignoring case; at most 3. Bad items are dropped (not UNKNOWN: they are presentation hints).
- A cut-off answer (`finish_reason = length`) keeps its text whole and has no follow-ups or sources.
- An answer that is only trailer lines is unverified (UNKNOWN), as today.

## Database (0254)

- `hon.hon_reply_invocations`: `follow_up_questions text[]` (≤3, each 3–150 chars, no newline) and `available_sources
  text[]` (closed set) and `cited_sources text[]` (closed set, ≤5, `<@ available_sources`). Whole-answer CHECK like 0214.
- `prepare_hon_reply` (0229 body) records `available_sources` just before the context leaves: metric keys whose
  `availability = 'AVAILABLE'` in the facts sent, `conversation` when history or a continuation was sent, `specialistResults`
  when a group was sent.
- `record_hon_reply_result` (0214 body) accepts optional `followUps` and `sources`; validates them strictly (22023 on bad
  shape); keeps them only for a whole, recorded (not FAILED, not truncated) answer; keeps only sources in
  `available_sources`.
- `hon_reply_detail` (0229 body) adds `followUps` and `sources`, shown only for a COMPLETED, visible, whole answer (same rule
  as suggestions). A concealed or held answer shows none.

## Contracts / API / web

- `HonReplyDetail` gains `followUps: string[]` and `sources: HonReplySourceKey[]` (strict validation, same whole-answer
  rule). `HonReplyResult` gains the same two fields; `HonReplyService.verified` checks them.
- Prompts: HON and Claire get one added instruction describing the two optional lines.
- Panel: "Ask next" buttons (fill the composer, focus it) and a "Based on" line with human labels.

## Plan (TDD order)

1. Contract: source keys, labels, validator tests (replyDetail with/without, bad shapes, truncated with items refused).
2. Runtime: trailer parser tests (order, duplicates, drops, cut-off, Claire), then parser + prompts.
3. Service `verified`: tests for bad followUps/sources → UNKNOWN.
4. Migration 0254 + AI-0 proof invariant: stored, filtered to available, hidden when concealed/truncated/failed, runs nothing,
   no change to ledger/credits; existing replyDetail assertions gain the two empty arrays.
5. Web: panel tests (chips render only for visible complete answers; tap fills composer, sends nothing).
6. `pnpm check`, `pnpm test`, `pnpm build`, AI-0 locally, `git diff --check`; PR; independent review thread.
