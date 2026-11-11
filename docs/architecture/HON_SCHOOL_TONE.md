# HON tone per school (migration 0256)

Status: spec + plan, 2026-11-11. Owner asked for all three extra ideas from the assistant research ("Can we try to do all
3?"); defaults announced to the owner and still open to override. No third-party branding, characters or voice.

## Goal

The school owner picks how HON and Kai word their answers for this school:

| Key | Shown as | Instruction added to the prompt |
| --- | --- | --- |
| `STANDARD` (default) | Standard | nothing (today's wording, byte for byte) |
| `FRIENDLY_COACH` | Friendly coach | warm, encouraging coach's voice |
| `STRAIGHT_TO_THE_POINT` | Straight to the point | lead with the answer, no greetings or filler |
| `FORMAL` | Formal | professional, complete sentences, no slang or exclamation marks |

Tone changes wording only. Every facts rule, the trailer lines, Claire (business analysis keeps her own neutral voice),
budgets, models, S4 controls and costs are unchanged. No new AI call, spend path or personal data.

## Rules

- One tone per school; no row means `STANDARD`. The tone is a closed key: the prompt sentence comes from a fixed table in
  the API, never from stored or typed text, so a tone cannot carry instructions.
- Change: human command (HUMAN_UI, direct principal) with `ai.school_tone.manage` (OWNER by default, not staff-assignable:
  "the owner picks"). Idempotent by key, per-school lock, audited with the previous and new key (no personal data), outbox
  internal only, authority checked again after the last write. Setting the current tone again is a no-op receipt.
- Read (`read_hon_school_tone`): HON users (`ai.invocation.plan`), Kai users (`teaching.assistant.use`) or manage.
- Use: `hon.hon_ai_tone()` returns the key for the session school only. The HON reply service and Kai's teaching service
  read it in the same transaction as their prepare call and pass it to the runtime; the runtime refuses an unknown key
  (PRE_SEND, nothing sent).

## Plan (TDD)

1. Contracts: `HON_AI_TONES`, labels, `validateHonSchoolToneInput`, `validateHonSchoolTone`, receipt; unit tests.
2. Runtime: prompt tests (STANDARD byte-identical to today for HON and Kai; each tone adds exactly its sentence; Claire
   never changes; unknown tone refused before any send).
3. AI-0 INV-34: authority matrix, idempotency, audit/outbox, default, HON and Kai receive the school's tone, Claire not,
   grants (runtime: read, set, tone only), guards.
4. Migration 0256 + 010 grants + pins; API routes `GET/POST /hon/tone`.
5. Web: "How HON talks" picker on the full HON workspace (read-only for HON users, editable with manage).
6. `pnpm check`, `pnpm test`, `pnpm build`, AI-0, `git diff --check`; PR; independent review.
