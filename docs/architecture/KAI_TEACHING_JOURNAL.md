# Kai teaching journal (KJ1, migration 0476)

**Status:** built, not deployed (2026-11-18). **Owner request (David, 2026-11-18 05:02Z):** "kai should also be teaching journal.
instructor can speak to it regarding what they taught that day. and kai can recall it when instructor ask what did we work on
last week. at same time have few recommendation from the pattern".

Verified on main d4a765c: Kai (`/staff/teaching-assistant`, 0100 + the legacy `claire` keys) drafts lesson outlines from a
published curriculum through the governed AI runtime. Nothing stores what an instructor actually taught. There is no journal
table, function, route or screen.

## Pieces

| Piece | What | AI | Migration |
|---|---|---|---|
| **KJ1 (this PR)** | Journal entries by voice or text, recall by period ("what did we work on last week?"), pattern suggestions computed by fixed rules | none, free, works today | 0476 |
| KJ2 (next) | Kai answers free-text journal questions and writes richer suggestions through the governed AI runtime (S4 plan, budget lock, spend decision, usage before answer, UNKNOWN), like Eian (0474) | governed, behind the OpenRouter key, the paid-call flag and David's approval | to be allocated |

KJ1 stands on its own: an instructor can keep the journal, recall any period and see suggestions with no provider at all.
KJ2 adds AI on top of the same entries and never changes them.

## KJ1 rules

1. **Who.** A direct human staff member (HUMAN_USER, HUMAN_UI, no action request or delegation) at the exact school, with the
   new permission `teaching.journal.use` (staff-assignable, not sensitive, OWNER by default; owners give it to instructors with
   the Roles & permissions checklist), live **COMPLETE** access (Kai is part of the Complete AI team), active school and
   organization. Family, student, HQ and platform roles are refused. The actor is proved again after the locks and at the end.
2. **Whose entries.** Each instructor changes **only their own** journal. It is **private by default** (owner decision O1:
   "private but each staff can decide to share if they want"). The author can share any single entry, read-only, with the
   school's teaching team: staff who hold `teaching.journal.use` at the **same school** with the same Complete and identity
   checks. They see it in a **Team journal** by the author's display name only (no id, subject or email), never their own
   entries there, and can never edit it. Sharing and unsharing is part of a normal save, so it is the next version, audited and
   idempotent. Unsharing or removing an entry takes it out of the Team journal at once; a removed entry is always unshared.
3. **An entry** is one school-local date (from 400 days ago to today at the school), an optional class name (1-80 characters),
   what was taught (1-2,000 characters), 0-10 topics (1-40 characters each, unique ignoring case) and how it was entered:
   `TYPED` or `SPOKEN`. Free text is trimmed, with no control, markup or invisible direction characters.
4. **Changes.** An entry can be edited or removed. Every change is the next version. A removed entry is final, hidden from
   reads, and its notes, class and topics are erased in the same update. Entries are never hard-deleted. Each save is
   idempotent (exact replay returns the first receipt, key reuse is refused), audited without free text, and has an inert
   outbox event.
5. **Recall.** The read takes a school-local date range of at most 120 days and returns the instructor's active entries, newest
   first, at most 300. The page turns a question into a range with a fixed parser (English, Korean, Spanish): today, yesterday,
   this week, last week, this month, last month, last N days, last N weeks. A question it does not understand shows the last
   14 days and says so. Weeks are Monday to Sunday at the school.
6. **Suggestions (no AI).** `kaiJournalSuggestions(entries, today)` in `@hon/contracts` looks at the last 90 days and returns
   at most 3, in this order:
   - **FOCUS:** in the last 28 days, at least 4 entries and one topic in at least half of them. "Roundhouse kick came up in 5 of
     your last 7 classes. Students may be ready to build on it, or balance it with other skills."
   - **REVISIT** (up to 2): a topic taught at least twice, last taught 21 or more days ago. "Revisit Blocking: last worked on 24
     days ago."
   - **LOG:** entries exist but none in the last 7 days. "You haven't logged a class since Nov 3."
   - **TAG:** at least 3 of the last 5 entries have no topics. "Add topics so Kai can spot patterns."
   They are labelled "Kai's pattern notes, from your journal" and never claim to be AI.
7. **Voice.** The page uses the browser's own speech recognition (the free adapter from `hon-voice.ts`) to dictate into the
   notes box. Nothing is saved until the instructor presses Save, and the entry is marked `SPOKEN`. No audio is stored or sent
   to a paid service. Without browser speech the microphone button is hidden.
8. **Privacy note on the page:** "Write about skills and drills. Avoid student names and personal details." (KJ2 sends journal
   text to a provider, so this matters before AI is switched on.)

## Data model

`hon.kai_journal_entries`: id, organization_id, school_id, author_principal_id, taught_on (date), class_name, notes, topics
(text[]), entry_source, shared (boolean, default false), status (`ACTIVE` | `REMOVED`), version, created_at, updated_at. A removed
entry must be erased and not shared (CHECK). Forced RLS, no policies, no grants. A guard
trigger keeps scope, author and creation time fixed, versions consecutive, a removed entry final and erased, and refuses
DELETE and TRUNCATE.

## Functions

- `hon.read_kai_journal(subject, from date, to date)` returns `{ timezone, today, entries }`.
- `hon.read_kai_team_journal(subject, from date, to date)` returns `{ today, from, to, entries }`: other authors' ACTIVE, shared
  entries at this school, each `{ entryId, authorName, taughtOn, className, notes, topics, updatedAt }`, newest first, at most 300.
- `hon.save_kai_journal_entry(subject, input jsonb, key, request, correlation)` returns `{ entry, replayed }`. Input
  `{ entryId|null, expectedVersion, taughtOn, className|null, notes, topics, source, status, shared }`. A new entry has entryId null,
  expectedVersion 0 and status ACTIVE. Removing sends status REMOVED with the current version (the other fields are ignored
  and must still be well formed).

The runtime gets EXECUTE on those three only. `kai_journal_display_name(uuid)` (markup and invisible characters dropped,
'Staff member' when empty) is a private helper.

## API

| Route | Guard | Notes |
|---|---|---|
| `GET /v1/organizations/:o/schools/:s/staff/kai/journal/entries/:from/:to` | human UI read `kai_journal.read`, no query, no Idempotency-Key | `{ timezone, today, entries }` |
| `GET /v1/organizations/:o/schools/:s/staff/kai/journal/team/:from/:to` | human UI read `kai_journal.team_read`, no query, no Idempotency-Key | `{ today, from, to, entries }`, read-only; there is no write route |
| `POST /v1/organizations/:o/schools/:s/staff/kai/journal/entries` | human UI command `kai_journal.save`, Idempotency-Key | receipt |

Route ids are never authority: the scope is resolved from the session for `teaching.journal.use` and must match the route; the
database proves it again.

## App

- New page `/staff/teaching-assistant/journal` ("Teaching journal"), linked from Kai's workspace intro and the school menu
  next to Kai.
- Top: "Tell Kai about today's class" form (date, class, notes with a microphone, topics with chips that also offer topics you
  used before that appear in the notes).
- "Ask Kai about your journal" box with example chips ("What did we work on last week?"), answered from the journal by the
  parser and shown as the range, a topic tally and the entries.
- "Kai's pattern notes" from the last 90 days.
- A "Share this entry with my school's teaching team" checkbox (off by default) and a "shared" tag on own entries.
- Recent entries with Edit and Remove.
- "Team journal": entries colleagues at this school shared in the last 30 days, read-only, by display name.
- en, ko and es copy.

## Plan (TDD order)

1. Contracts `kai-journal.ts`: validators, period parser, suggestions. Tests in `apps/api/test/kai-journal.test.cjs` first.
2. Migration 0476 and `test-kai-journal-integrity.mjs` (signed HTTP proof): permission, tier, own-only, validation, versioning,
   removal erasure, idempotency, ACLs. Wire 010/011, verify-rls, staging manifest, checksums, run-db-proofs, package script.
3. API controller, service, guards, DTO and unit tests.
4. Web http client, page, copy, route manifest, menu and Kai link, vitest UI tests.
5. `pnpm check`, focused tests, the DB proof, `git diff --check`, self-review.

## Evidence

- `packages/database/scripts/test-kai-journal-integrity.mjs` over signed HTTP: 175 checks, including sharing (private by
  default, author-only, same-school team read by display name, other school/organization/family refused, unshare and remove leave
  the team view at once, no write route, replay record without text, ACL for the new function and helper) and (permission and OWNER grant, own-only reads and
  edits, owners refused, family/other-school/other-organization refused, 120-day range, validation in the API and again in SQL, versioned
  edits, removal final and erased, text-free replay record, stale replay refused, key reuse, revoked grant / suspended school / lapsed or
  non-Complete access, audit and outbox without journal text, guards, ACL and the 011 section, no AI plan, message or payment).
- `apps/api/test/kai-journal.test.cjs`: service (own and team reads, sharing round-trip), guards, period parser (en/ko/es) and suggestion rules.
- `apps/web/test/kai-journal-ui.test.tsx`: http client (own and team reads), sharing in the form, Team journal states, form rules, page states, recall, pattern notes, languages, menu and route manifest.

## Known limits

- Dictation uses the browser's own speech recognition. In Chrome that recognition may run on Google's servers (free, no HON provider);
  nothing is saved until the instructor presses Save, and HON never stores audio.
- The read shows at most 300 entries per range; recall is by period only (no keyword search) until KJ2.

## Owner decisions

- **O1 (answered, David 2026-11-18 05:31Z):** "private but each staff can decide to share if they want". Built as the
  per-entry share and the read-only Team journal above.
- **O2 (answered, David 2026-11-18 05:31Z):** "yes": KJ2 may send journal text to the AI provider as untrusted data, like
  Eian. Paid calls still need the OpenRouter key, the paid-call flag and the no-training confirmation, as for Eian.
