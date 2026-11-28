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

# C5 (migration 0701): filters in plain sight, expired members, program order, parents and children

Owner ask (David, 2026-11-27): "i need sort function of belt levels, expiration dates, program, active or inactive, or
other contact type." C4 already had most of it, but the filters sat in a closed fold and David did not find them. He
chose (decision card, 2026-11-27 08:23Z) "show filters + fill gaps".

## What C5 adds

One more `CREATE OR REPLACE` of `hon.read_school_contact_list` (same signature, owner, grants and actor check). No new
table, no write, nothing sent or charged. **The response shape does not change** (rows, counts and options keep their
exact keys), so HON Staff app builds already installed keep verifying the list.

| Query key | New value | Meaning |
|---|---|---|
| `sort` | `PROGRAM` | Current membership's program name A to Z (case-insensitive). People without a program come last, then name order. |
| `membership` | `EXPIRED` | No current membership, but the person had a started membership at this school before (the same "former" test the Inactive segment uses). Unlike the Inactive chip it also lists former members who now have an open lead. |
| `contactType` (new key) | `GUARDIAN` | The person is a guardian (`family_members.member_role = 'GUARDIAN'`) in a family of this school. |
| | `CHILD` | The person is a student or dependent in a family of this school that also has a guardian who is someone else (the blasts "children" test, 0695). |

### Rules

- **C5-1** Paging stays keyset on the last person id. `PROGRAM` adds a text key (lower-cased program name, empty when
  there is none) after the numeric key; the anchor recomputes it from the same snapshot.
- **C5-2** `contactType` and the new values are part of what the API signs the cursor to.
- **C5-3** Closed input as before: unknown `contactType` values are refused (400 VALIDATION_FAILED) in the contract, the
  API and the database.

## Screen

- The Filters panel is no longer a fold: Sort, the segment chips and every filter show at once in a filter bar, with
  "Clear filters" when any is set.
- Membership menu gains "Expired (no current membership)". Sort menu gains "Program A–Z". New "Contact type" menu: Any,
  Parents and guardians, Children. Copy in en / ko / es.

## Tests

- DB proof `test-school-contacts-integrity.mjs`: PROGRAM order across both pages, EXPIRED, GUARDIAN, CHILD, refusals.
- Contract tests for the validator; API test that the cursor is signed to `contactType`.
- Web test: the bar renders open, the new choices send the right query.
