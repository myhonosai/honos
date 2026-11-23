# Contacts list: sort and more filters (C4, migration 0623)

Owner ask (David, 2026-11-21): "contact list ... needs to be able to sort, filter to see the list in different way to
figure out different group like by belt, membership, end date, age". Reference: the Contacts page of David's Manus CRM
(belt colours incl. "No rank assigned", programs, memberships "Has / No membership" + per plan, expiration "already
expired / next 7 / next 30 days / custom range", segment chips, tag chips). Manus has no sort and no age; HON adds both.

## What already exists (0521 / 0523)

`hon.read_school_contact_list` returns one page of 50 in name order with segment counts (All, Students, Trial,
Prospects, Inactive, Archived) and filters: search, belt (`rankId`), program, plan, `endsWithinDays` 7/30/60/90.

## What C4 adds

One `CREATE OR REPLACE` of `hon.read_school_contact_list` (same signature, same grants, same actor check). No new
table, no write, nothing sent or charged. The contact card is not touched.

| Query key | Values | Meaning |
|---|---|---|
| `sort` | `NAME` (default, may be left out), `ENDS_SOONEST`, `BELT_HIGH`, `BELT_LOW`, `AGE_YOUNGEST`, `AGE_OLDEST`, `NEWEST` | Order of the list. People without the sort value (no end date, no belt, no birth date) come last, then name order. |
| `membership` | `HAS`, `NONE`, `ACTIVE`, `PAUSED`, `CANCELLING` | Current membership: any / none / its state is ACTIVE / FROZEN / CANCELLATION_PENDING. |
| `noBelt` | `true` | No active belt in any curriculum. Not with `rankId`. |
| `endsFrom`, `endsTo` | `YYYY-MM-DD` | Current membership ends on or between these days in the school's time zone (either end may be left out). Not with `endsWithinDays`. |
| `ageMin`, `ageMax` | 0 to 120, min ≤ max | Age today in the school's time zone from the student birth date. People without a birth date never match an age filter. |
| `tag` | a contact tag (1 to 40 letters, digits, space, `-`, `_`) | People with that tag (case-insensitive). |

Each row adds `age` (whole years or null) and `membershipState` (`ACTIVE` / `PAUSED` / `CANCELLING` / null).
Options add `tags` (up to 100 of the school's tags, A to Z).

### Rules

- **C4-1** Segment counts keep following every filter (as in 0521), so the chips show how many match.
- **C4-2** Paging stays keyset: the cursor still carries only the last person id and is signed to the school and every
  filter including `sort`. The database recomputes that person's sort position from the same snapshot; a person who
  no longer exists gives `SCHOOL_CONTACTS_STALE_CURSOR` (400), as before.
- **C4-3** Belt order uses the rank's `progression_order` (highest of the person's active belts for `BELT_HIGH`, lowest
  for `BELT_LOW`). Belts from different curricula are compared by that number only.
- **C4-4** Age and dates use the school's time zone (`hon.schools.timezone`), falling back to UTC if it is not a known
  zone.
- **C4-5** Closed input: unknown keys, wrong types, out-of-range ages, `ageMin > ageMax`, `endsFrom > endsTo`,
  `noBelt` with `rankId`, and a range with `endsWithinDays` are refused (400 VALIDATION_FAILED) in the contract, the API
  and the database.

## Screen

The contacts card keeps search and the segment chips. Under them: a **Sort** menu always visible, and the Filters panel
gains Membership, Age (from / to), Ends between (two dates) and Tag, plus "No belt yet" in the Belt menu. Rows show the
age next to the name and a "Paused" / "Cancelling" badge. Copy in en / ko / es.

## Tests

- DB/HTTP proof `test-school-contacts-integrity.mjs` extended: every sort in both pages of a 62-person school, each new
  filter, the refusals, the 011 section.
- Contract unit tests for the query validator and the row verifier.
- Web test `people-contacts-ui.test.tsx`: the sort menu and new filters send the right query; age and badges render.

## Not in C4

- "Membership ended in the last N days" (win-back list): the Inactive chip already lists former students; a dated
  "ended" filter needs the last end date in `school_contact_facts` and can follow.
- Saving a filter set as a named group, and sending a blast to the current filter (blasts PR #489 has its own audience
  groups; reusing this list as a blast audience is a later step).
