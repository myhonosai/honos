# Student and guardian CSV import (0226)

Backlog item B-CRM-7. Migration number 0226 was allocated by the owner on 2026-11-09.

A school that moves from another system can bring in its students and their guardians from a CSV file. Staff go through three steps:

1. **Stage.** Upload the file and match its columns.
2. **Decide.** Mark each row to import or skip.
3. **Finalize.** Import exactly the rows marked to import.

**What importing creates:** people, families, family links (GUARDIAN and STUDENT) and student profiles. Nothing else.

**What importing never creates:** a membership, plan, payment schedule, invoice, payment, billing account, class enrollment, booking, lead, user account, invitation, family portal access, consent, message, automation, AI call or credit effect.

**No merging:** a duplicate suggestion is only a warning. Importing always creates a new person and never merges into an existing one.

## Routes

All routes sit under `/v1/organizations/:organizationId/schools/:schoolId/student-imports`.

- **Scope.** Each route resolves its scope from the verified session using `students.import`. The route's ids are never authority.
- **Live authority.** Each protected database function re-proves the direct human subject and the live, school-scoped `students.import` grant. It checks before the writes, on replay and after the last write, all against `clock_timestamp()`.
- **Paid access.** The grant only counts while the organization has an ACTIVE ESSENTIAL, CORE or COMPLETE entitlement.

| Method and path | Browser command header | Database function |
|---|---|---|
| `GET /` | (GET) | `read_student_imports`: the 25 most recent batches plus the published limits |
| `GET /:batchId` | (GET) | `read_student_import`: one batch with every row |
| `POST /` `{csv, mapping}` | `students.import.stage` | `stage_student_import` |
| `POST /:batchId/decisions` `{expectedVersion, decisions:[{index, choice}]}` | `students.import.decide` | `decide_student_import` |
| `POST /:batchId/finalize` `{expectedVersion, selectedIndices}` | `students.import.finalize` | `finalize_student_import` |

**Idempotency.** Every POST needs an `Idempotency-Key`.

- An exact retry returns the stored receipt with `replayed: true`.
- Reusing a key for a different body returns 409 `IDEMPOTENCY_KEY_REUSED`.
- A retry while the first request is still running returns 409 `STUDENT_IMPORT_BUSY`.

**Reads.** Reads refuse an `Idempotency-Key` and any query string. Rows hold names, contacts and birth dates, so reads need the same live `students.import` grant as the commands.

**Contracts.** Types and strict verifiers are in `@hon/contracts` (`student-imports.ts`).

## The file

The API parses the file with `csv-parse` in strict mode:

- UTF-8 text with no NUL characters, lone surrogates or replacement characters;
- consistent columns and RFC 4180 quoting;
- unique plain headers of at most 80 characters, none starting like a spreadsheet formula;
- 1 to 1,000 data rows, at most 24 columns and 256 KiB.

The database then checks everything again. It recomputes the SHA-256 checksum of the exact text and revalidates every mapped cell.

**Mapping.** The mapping assigns every column exactly once, to one of:

`studentGivenName`, `studentFamilyName`, `birthDate`, `studentEmail`, `studentMobile`, `guardianGivenName`, `guardianFamilyName`, `guardianEmail`, `guardianMobile`, `familyKey`, or `ignore`.

Each field can be used once. The mapping has these rules:

- Student first and last name are required.
- Guardian first and last name go together.
- A guardian email or mobile needs the guardian name columns.

Ignored columns are blanked before the row is stored.

## Row rules (decided in the database)

### Cell problems

Each problem is recorded as a `field:PROBLEM` code.

| Code | Meaning |
|---|---|
| `TOO_LONG` | The cell is too long. |
| `CONTROL_CHARACTER` | The cell contains control or bidirectional characters. |
| `FORMULA_INJECTION` | The cell starts with `= + - @`. A valid `+` phone number is allowed. |
| `INVALID` | The email is not valid. |
| `USE_E164` | The mobile number is not in E.164 format. Spaces, dashes and brackets are stripped first. |
| `USE_YYYY_MM_DD` | The birth date is not a real date in YYYY-MM-DD form. |
| `OUT_OF_RANGE` | The birth date is in the future or more than 120 years ago. |

### Names

- `student:NAME_REQUIRED`: the student needs both a first and a last name.
- `guardian:NAME_REQUIRED`: a guardian with partial details needs both names. A half-named guardian is never treated as a guardian.

### Family key

Rows that share a `familyKey` (compared case-insensitively) form one family.

- The family uses the one guardian named on any of its rows.
- If two different guardians appear under one key, every row with that key gets `familyKey:GUARDIAN_MISMATCH`.

### Minors

- `guardian:REQUIRED_FOR_MINOR`: a student whose birth date is less than 18 years before the school's local date needs a guardian.
- `birthDate:REQUIRED_WITHOUT_GUARDIAN`: a row with no guardian needs a birth date, so an adult is never assumed.

### Duplicate suggestions

Each row gets at most 20 suggestions. They are advisory and never merged. Matches are found only at the exact school:

- an existing person with the same student or guardian email, or the same mobile;
- an existing student with the same name and birth date;
- the same student on another row of this file.

A row with any problem can only be skipped. To bring it in, fix the file and stage it again.

## Finalize

Finalize succeeds only when:

- every row is decided; and
- `selectedIndices` is exactly the set of IMPORT rows on the expected version.

Otherwise it returns 409 `STUDENT_IMPORT_SELECTION_REQUIRED`. A stale version returns 409 `VERSION_CONFLICT`.

**Lock order.** Finalize locks `hon.people` in ROW EXCLUSIVE mode before the key reservation. This matches the CRM registration flows.

**Per row, in order:**

1. Reuse the family (and its guardian) already created for an earlier row with the same family key. If there is none, create a family named "<guardian or student last name> family", plus the guardian person and their GUARDIAN link.
2. Create the student person and their STUDENT link.
3. Create the student profile, with its birth date and the family as primary family.

The created ids are recorded on the row, and the batch becomes FINALIZED.

**Audit and outbox.**

- **Audit.** One audit event per command (`students.import.stage|decide|finalize`) and one per applied row (`students.import.row_applied`).
- **Outbox.** Outbox events carry the same names and are marked `internalOnly`. They are deliberately not "student created" events, so nothing downstream sends a welcome or starts an automation.
- **Identifiers only.** Audit and outbox payloads carry ids only: never a name, contact value or birth date.

## Storage and evidence

The import uses three private tables with forced RLS and no policies:

- `hon.student_import_batches`
- `hon.student_import_rows`
- `hon.student_import_requests`

The runtime role has no privilege on these tables, or on people, families, family links or student profiles. It has EXECUTE on the five entry points only.

The settings-free trigger `hon.guard_student_import()` enforces the following, even for the table owner:

- Nothing is deleted or truncated.
- A batch only moves forward one version at a time, finalizes once and never changes after that. Its content, counts and checksum never change.
- A row's staged content never changes. Its choice moves only while the batch is STAGED and never back to undecided. Its created ids are written once.
- A request records its response once.

`infra/postgres/010` holds the deny-first grants. `infra/postgres/011` pins all 15 functions by body hash, along with the guard triggers and the permission.

## Permission

`students.import` is sensitive and staff-assignable. The migration grants it to every system OWNER role. Other staff get it only through a role the school assigns.

Some grants never count, even if a role carries the permission:

- roles whose code looks like a family, HQ or system role (`PARENT…`, `GUARDIAN…`, `STUDENT…`, `FAMILY…`, `HQ…`, `HON_…`, `PLATFORM…`, `SYSTEM…`);
- principals with HQ operator grants or live family access.

## Staff screen

The staff screen is at `/staff/migration/students` (Students > Import students), in English, Korean and Spanish.

**Flow.**

1. Pick a CSV file. The screen reads the header row and suggests a mapping from familiar header names. Staff review the mapping before the file is checked.
2. Review the rows. Problems are shown in words. Rows with problems can only be skipped. "Import every ready row" and "Skip every row" set the choices.
3. Save the decisions.
4. Import. The import button names the number of students and is enabled only when every decision is saved.

**Requests.** Each command sends its own `X-HON-Human-Command` and an `Idempotency-Key`.

**Unknown outcomes.** When an outcome is unknown, the screen keeps the exact request in memory. Try again replays it with the same key.

**Privacy.** Blur, a hidden tab, a school change or the end of a session hide the page. They also drop the file and any kept request.

## Proof

`packages/database/scripts/test-student-import-integrity.mjs` runs over signed HTTP on the guarded disposable CRM-close fixture and passes 139 checks. It runs in CI as part of `run-db-proofs.sh`.

**Refusals:**

- closed API input;
- every authority refusal: no permission, a family-type role, another school, another organization, suspended paid access, a revoked grant;
- browser transport refusals;
- evidence triggers;
- runtime ACL, plus the 011 section run against the fixture.

**Behavior:**

- every row rule;
- suggestions, including none from another school;
- replay and key reuse;
- the exact-selection rule;
- the created records and family grouping;
- no side effects beyond inert import events.

The API unit test is `apps/api/test/student-import.test.cjs`. The screen test is `apps/web/test/student-import-ui.test.tsx`.

## Not in this slice

- Updating or merging existing people from a file.
- Importing memberships, belts or rank, attendance history or billing.
- Staff accounts, and family portal invitations for imported guardians. Invitations stay a separate, consented flow.
