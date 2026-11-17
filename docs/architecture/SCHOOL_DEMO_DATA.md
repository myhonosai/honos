# School demo data (0459)

Owner request (David, 2026-11-17): a school can fill its account with demo data to try HON, then remove all of it with
one action before importing real records. It lives in **Settings > Demo data** for every school, so a school that does
not trust HON with a real import yet can still see every page working. The owner chose to include everything at once:
contacts, leads, classes, memberships, invoices and attendance.

## What a load writes
One fixed demo school, with dates that follow the school's own calendar and time zone:

- 3 programs (Little Dragons 4-6, Kids Karate 7-12, Teens and Adults 13+), a weekly class for each, and class sessions
  for the last 4 weeks (completed) and the next 2 weeks (scheduled).
- 20 families (a guardian and one or two children, 30 children in all) and 8 adult students in their own families.
- A billing account per payer and an ACTIVE membership per student, recorded with the same 0177 evidence that the 0334
  import uses (decision `STAFF_ACTIVATION_PRE_POLICY`, source `GENERIC_LEGACY`, origin `DEMO_DATA`), a monthly payment
  schedule, invoices 55 and 25 days ago (paid in cash or by card terminal, two members overdue) and one due in 5 days.
- Attendance for past classes (about seven in ten students of the class's program, a few late).
- 15 open leads in the school's first pipeline, or in a "Demo leads" pipeline when the school has none.

Phones are in the fictional `+1 201 555-0100..0199` range and emails end in `@example.com`. Load writes **no outbox
event**, so no automation, AI, welcome message or notification starts from demo rows, and one audit event with counts.

## Safety rules
1. **Registry.** Every row the load writes is registered in `hon.school_demo_data_rows` under one
   `hon.school_demo_data_sets` row (one LOADED set per school). Both tables have forced deny-all RLS and no client
   privilege.
2. **Removal touches only demo data.** `remove_school_demo_data` marks the set REMOVING with its own transaction id,
   follows every foreign key that points at the set's rows and registers what staff added to demo people while trying
   HON (a booking, a cash payment, a note). A dependent goes with the demo data only when it is in this school, has a
   uuid key and points at demo people only. If it also points at a real person, student, family, lead, billing account,
   membership or invoice, or points at demo structure (a demo class or program) without a demo person, removal stops
   with `DEMO_DATA_IN_USE` and the table names, and nothing changes. Rows are then deleted children first, in one
   transaction.
3. **Append-only guards.** 42 append-only guards on tables that can point at demo rows got one added line:
   `IF TG_OP='DELETE' AND hon.demo_data_removal_allows(TG_TABLE_NAME,to_jsonb(OLD)) THEN RETURN OLD; END IF;`.
   The check is true only for a row registered in a set that the current transaction is removing; the rest of each
   guard is unchanged. A later migration that replaces one of these guards drops the line, which makes removal stop
   safely and the canonical 011 check fail.
4. **Never contacted, never charged.** Inserts into `communication_messages` (texts and emails) and
   `school_family_access_invitations` for a demo person or family, and into school-pay customers, payment method setups,
   autopay plans and charge attempts for a demo billing account, are refused in the database
   (`DEMO_CONTACT_NOT_CONTACTABLE`, `DEMO_ACCOUNT_NOT_PAYABLE`). Demo invoices are paid only with offline records.
5. **Authority.** `school.demo_data.manage` (sensitive, staff-assignable, OWNER by default), the same live human identity
   rules as 0392, and the paid or trial access students need (a pre-trial school cannot hold students). Commands are
   idempotent and re-prove authority after their locks.

## API
- `GET /v1/organizations/:org/schools/:school/settings/demo-data` -> `{status, setId, version, loadedAt, counts, lastRemovedAt}`
- `POST .../settings/demo-data/load` body `{}` (`X-HON-Human-Command: school.demo_data.load`, `Idempotency-Key`)
- `POST .../settings/demo-data/remove` body `{setId, expectedVersion}` (`school.demo_data.remove`)

Refusals: 403 `DEMO_DATA_FORBIDDEN`, 409 `DEMO_DATA_ALREADY_LOADED`, 404 `DEMO_DATA_NOT_LOADED`, 409 `DEMO_DATA_IN_USE`
with `tables`, 409 `VERSION_CONFLICT`, 409 `IDEMPOTENCY_KEY_REUSED`, 400 `VALIDATION_FAILED`.

## Evidence
`packages/database/scripts/test-school-demo-data-integrity.mjs` (10 groups) and `apps/api/test/school-demo-data.test.cjs`.

## Screen
Settings > Demo data (`/staff/settings/demo-data`): Load, or the counts and Remove with one confirm step; a DEMO_DATA_IN_USE answer lists the tables to fix first. A card on the Settings summary links to it, and the staff shell shows a banner while demo data is loaded (read with the same permission, so only staff who can manage demo data see it).

## Not in this version
- A "Demo" badge on each contact in lists (the Settings page and a staff banner say demo data is loaded).
- Friendly messages in other screens when a command is refused for a demo person (the refusal code is returned).
