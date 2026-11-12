# What HON remembers: school notes (migration 0255)

Status: spec + plan, 2026-11-11. Owner direction (David, 2026-11-11): build visible memory. Inspired by public assistant
memory that users can see and delete; no third-party branding. Stacked on 0254 (follow-ups and sources).

## Goal

Staff with the new permission `ai.school_notes.manage` (school OWNER role by default, staff-assignable) save short notes
about the school that HON should know, e.g. "We close the first week of August" or "Kids classes are 45 minutes". HON uses
them in every answer and can cite them ("Based on: School notes"). Everyone who can ask HON at that school sees the same
list ("What HON remembers"), so nothing is remembered in secret. A manager deletes a note with one click; its text is
erased at once (only an id/time evidence row stays).

Not in scope: anything HON learns by itself from chats (memory is only what a person saves on purpose), notes about a
student, family or staff member, per-person memory, cross-school memory.

## Rules

- Per school: at most **20** active notes and **2,000** characters in total, each note 3–200 characters, plain text, one
  line. (Lower than the 30 first mentioned, so notes always fit HON's Standard input limit with the facts and history.)
- Refused (`22023`, nothing stored): email addresses, phone-number-like digit runs (7 or more digits), links (`http`,
  `www.`, `://`), markup (`<`, `>`), control characters (C0, C1, U+2028/2029). Length counts code points, and the
  contract (`isHonSchoolNoteText`) and the database (`hon.hon_school_note_ok`) spell out the same Unicode space list
  instead of locale classes, so both refuse exactly the same text. The screen says: "Notes are about the school, never about a
  student, family or staff member."
- Add and delete are human commands (HUMAN_UI, direct principal), idempotent by key, audited (ids only, never the text),
  outbox internal only, and authority is checked again after the last write.
- Read needs the HON question permission (`ai.invocation.plan`) at the school, or the manage permission.
- HON's context (`prepare_hon_reply`) gets `schoolNotes: [text, ...]` (newest first) for HON answers only; Claire keeps
  metrics only; notes are untrusted data like every fact. `schoolNotes` joins the closed source keys.

## Plan (TDD)

1. AI-0 invariant INV-33 (DB): add/delete/read authority, limits and refusals, idempotent replay, erase on delete,
   audit without text, HON context carries notes, a citation of `schoolNotes` only when notes were sent.
2. Migration 0255: permission, tables (notes, requests) with forced RLS and guards, functions, prepare (0254 body + notes),
   source keys + `schoolNotes`; 010 grants; pins.
3. Contracts + API (`/v1/organizations/:org/schools/:school/hon/school-notes`) with unit tests.
4. Web "What HON remembers" panel under Ask HON on the full `/staff/hon` workspace, with tests: every HON user sees the
   list; add and one-by-one delete only when the server says `canManage`; writes frozen with their key (an unknown
   outcome keeps one exact retry); a full list is a definitive 409 `HON_SCHOOL_NOTES_FULL`.
