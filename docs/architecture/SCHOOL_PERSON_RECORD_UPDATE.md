# School person record update (B-CRM-1a 0217, B-CRM-1b 0218 proposed)

Status: spec for a draft PR. Not deployed. The owner allocates the final migration number.

## Problem

`hon.people` (students, guardians, adult members and contacts) can be created
(`POST /v1/organizations/:org/schools/:school/people`) and listed, but never
corrected. A misspelled name, a new email or a new phone number cannot be fixed
from the school app. The runtime role has no `UPDATE` on `hon.people`, so any
edit needs a reviewed database command boundary. Backlog item B-CRM-1 (R0).

## Scope of this slice

1. **Read one person** for an edit screen:
   `GET /v1/school/schools/:schoolId/people/:personId`.
2. **Edit name and contact details** with optimistic concurrency:
   `POST /v1/school/people/update`.

Birth date correction and CRM enrollment carry-over were added by B-CRM-1b
(0218, below). Out of scope (later slices): student status, family membership changes, merging duplicate people, deleting people,
pagination of the people list (B-CRM-4).

## Contract

### Read

`GET /v1/school/schools/:schoolId/people/:personId`, same-origin human browser
read, no query string, no `x-hon-*` header except the command header.

```json
{ "data": {
  "personId": "uuid", "schoolId": "uuid",
  "givenName": "Ana", "familyName": "Rivera",
  "email": "ana@example.invalid", "phoneE164": "+15555550100",
  "version": 3, "updatedAt": "2026-11-07T06:30:00.000Z",
  "student": { "birthDate": "2015-04-02", "status": "ACTIVE", "version": 1 },
  "consents": { "EMAIL": "OPTED_IN", "SMS": "NOT_RECORDED" },
  "canEdit": true
} }
```

`student` is `null` when the person has no student profile at this school.
`consents` values are `OPTED_IN`, `OPTED_OUT` or `NOT_RECORDED`.
`canEdit` is whether the caller currently holds `people.update` at this school.

### Edit

`POST /v1/school/people/update` with headers `X-HON-Human-Command: school-person-record`,
a UUID `Idempotency-Key`, same-origin fetch metadata and the configured Origin.

```json
{ "schoolId": "uuid", "personId": "uuid", "expectedVersion": 3,
  "givenName": "Ana", "familyName": "Rivera-Lopez",
  "email": "ana@example.invalid", "phoneE164": null }
```

The body is closed (exactly these keys) and replaces all four fields; `null`
clears an email or phone. The response is `{ "data": { "person": <read shape>,
"changedFields": ["familyName"] } }`. The same key and body replays the stored
response; the same key with a different body is refused.

### Errors (closed codes, no SQL text)

| Status | Code | When |
|---|---|---|
| 400 | `PERSON_INPUT_INVALID` | Body/selector shape, name length, email or E.164 format |
| 400 | `PERSON_UNCHANGED` | Nothing differs from the current record |
| 403 | `PERSON_FORBIDDEN` | No live `people.update` + `people.read` human authority at this exact school, school paid access not in effect, or authority ended before commit |
| 404 | `PERSON_UNAVAILABLE` | Person missing or at another school (indistinguishable) |
| 409 | `PERSON_VERSION_CONFLICT` | `expectedVersion` is not the current version |
| 409 | `PERSON_CONTACT_CONSENT_REVIEW_REQUIRED` | Email (or phone) changes or is cleared while that channel's consent is `OPTED_IN` |
| 409 | `PERSON_IDEMPOTENCY_CONFLICT` | Key reused for a different body |
| 503 | `PERSON_BUSY` / `PERSON_UNAVAILABLE` | Lock timeout (retry) / unknown failure |

## Security boundary

- Subject comes only from the verified HON session; school, organization and
  principal are never accepted from the body or headers.
- One `SECURITY DEFINER` command `hon.update_school_person(text,jsonb,uuid)` and
  one read `hon.read_school_person(text,uuid,uuid)`; runtime gets `EXECUTE` on
  exactly these and still has no table `UPDATE`.
- Actor: active human principal resolved by `hon.resolve_authorized_scope` with
  `people.update` and `people.read` at the exact school, and the organization's
  paid access in effect (same predicate as 0205 family invitations). Reads need
  `people.read` and paid access.
- Exact school: a person id from another school or organization reads as missing.
- Order inside the command: authority, `hon.people` ROW EXCLUSIVE table lock (the
  CRM registration and DRAFT flows 0160-0176 lock `hon.people` before
  `hon.idempotency_records`, so taking people first prevents a deadlock), idempotency reservation (replay returns
  the stored response only while authority is current), person row
  `FOR NO KEY UPDATE`, version check, consent rule, update (`version + 1`,
  `updated_at`), audit event `people.update` with prior/next state, outbox
  `people.person.updated` (ids, version and changed field names only, no contact
  values), idempotency completion, then **authority is decided again after the
  last write** so a grant revoked while the command waited commits nothing.

## Consent serialization (Manus P1-161-1)

For each channel whose address changes (EMAIL for email, SMS for phone) the command
takes the canonical consent writer's transaction advisory lock
`pg_advisory_xact_lock(hashtextextended(personId || ':' || channel, 0))`
(`COMMUNICATION_CONSENT_ADVISORY_LOCK_SQL` in `communication-consent.service.ts`), EMAIL before SMS, held to commit, and only then
reads that channel's consent row `FOR SHARE`. A consent capture in flight for the old
address (an update or a first insert) therefore finishes first and the edit refuses;
an edit that wins first finishes before the consent capture, which then applies to the
new address. The consent writer never waits on the person row (its FK check takes
KEY SHARE, compatible with the edit's NO KEY UPDATE), so the order person row ->
advisory lock cannot deadlock. Proof group 10 covers EMAIL and SMS, existing opt-in
and first insert, change and clear, and the reverse order.

Both sides derive the key from canonical uuid text (Manus P1-161-1 follow-up): the consent
writer hashes `$1::uuid::text`, not the raw route spelling, because its UUID check and
`ParseUUIDPipe` accept an uppercase person id. Proof group 11 drives the real
`CommunicationConsentService` with an uppercase selector: its first opt-in, held open after
the insert, makes the edit wait and refuse with no contact, audit, outbox or key effects
(with the old raw-text key the edit commits and carries consent; checked by mutation). The
consent writer's idempotency fingerprint is unchanged.

## Permission

New permission `people.update` ("Edit a person's name and contact details within
an authorized school"): granted to every existing system OWNER role, and staff
assignable so an owner can delegate it to a custom front-desk role.

## Consent rule (fail closed)

Consent rows record a channel, not an address. Changing or clearing the email of
a person whose EMAIL consent is `OPTED_IN` (or the phone with SMS `OPTED_IN`)
would silently carry consent to a new address, so it is refused. Staff can record
an opt-out through the existing consent endpoint, edit the contact, then capture
consent again for the new address. Automating that is an owner decision.

## Owner decisions (defaults used here)

1. Who may edit: system OWNER plus any custom role the owner gives `people.update`.
2. Contact change with active consent: refuse (default) vs automatically mark the
   channel opted out vs allow and carry consent.
3. Suspended school: edits and the detail read refused (consistent with the
   2026-11-01 CRM suspension policy; the owner read-only window does not cover
   people detail yet).

## Tests

- DB proof `test-school-person-record-update-integrity.mjs` (champions-club
  fixture): ACL/definer posture, exact-school isolation, permission matrix
  (owner, delegated, read-only staff, other school, parent, inactive principal),
  suspended school, version conflict, unchanged, consent rule, replay and key
  reuse, audit/outbox rows without contact values in outbox, authority revoked
  while the command waits on the person lock commits nothing (both a revocation
  and a grant whose `effective_until` passes by the clock; authority uses
  `clock_timestamp()`, not statement time), and a CRM-style SHARE ROW EXCLUSIVE
  holder of people + idempotency records never deadlocks with an edit.
- API unit test `school-person-record.test.cjs`: closed validators, human guard,
  SQLSTATE mapping without SQL leakage.

## B-CRM-1b (0218 proposed): birth date correction and CRM enrollment carry-over

Owner decision 2026-11-07 ("Carry the fix into the enrollment"): a governed name
or birth date correction of a CRM guardian/child enrolled child carries into
that enrollment as an audited correction. Before 0218 any name edit sent the
child to `NEEDS_STAFF_REVIEW` with no way forward except reverting the edit,
because `crm_guardian_child_child_relation` compared live identity with the
immutable 0176 snapshot.

### Birth date command

`POST /v1/school/people/birth-date` (human guard, command header
`school-person-record`, `Idempotency-Key`), closed body:

```json
{ "schoolId": "uuid", "personId": "uuid", "expectedVersion": 1,
  "birthDate": "2016-05-05", "reason": "Birth certificate checked at the desk" }
```

`expectedVersion` is the **student profile** version (`student.version` in the
read). `birthDate` is a real `YYYY-MM-DD`, from 1900-01-01 up to today in the
school's time zone. `reason` is required (1–300 characters, no control
characters). Response: `{ person, changedFields: ["birthDate"], enrollmentCorrected }`.

Rules: same `people.read` + `people.update` live human authority and paid-access
rule as the name edit. A change that turns a **known minor into an adult**
(under 18 to 18+ in school time) requires a live school **OWNER** grant
(403 `PERSON_BIRTH_DATE_OWNER_REQUIRED`), because it removes the 0177 D3
guardian-of-record requirement at activation. Making a date stricter, or any
change that keeps the student on the same side of 18, is allowed for delegated
editors. Clearing a birth date is not offered. Authority (and OWNER, when
crossing) is decided again after the last write.

Lock order: `hon.people` then `hon.student_profiles` in ROW EXCLUSIVE before the
idempotency insert, so it serializes with CRM flows (SHARE ROW EXCLUSIVE) and
activation (SHARE). Audit `people.student.birth_date.update` holds prior/next
date, reason, `minorToAdult` and `enrollmentCorrected`; outbox
`people.student.updated` holds ids, version and `changedFields` only, no date.

### Enrollment carry-over

- `hon.crm_guardian_child_identity_corrections`: append-only (update/delete/
  truncate refused), forced RLS, no runtime access. One row per correction:
  version, corrected names and birth date, prior values, actor, request id.
- Both governed commands (`update_school_person`, `update_school_student_birth_date`)
  record a correction after their write when the person is an enrolled child
  and the live identity differs from the held one. The corrected name must pass
  the 0176 snapshot rules, else 400 `PERSON_INPUT_INVALID` and nothing commits.
- `crm_guardian_child_child_relation` compares live identity with the latest
  correction (else the snapshot); the family read shows the held display name.
  The 0176 snapshot itself is never changed.
- An ungoverned change (anything that bypasses these commands) is still drift
  and still `NEEDS_STAFF_REVIEW`.

### Owner decisions (defaults used in 0218)

1. Known minor becoming an adult needs a school OWNER (default) vs any editor.
2. A reason is required for every birth date correction (default).
3. Clearing a birth date is not allowed (default).
4. Corrections carry into the enrollment record in every state, including after
   a DRAFT exists or the membership is active; existing DRAFT/membership terms
   are not changed (default).

### Tests (0218)

- Person proof groups 12–14: posture, delegated correction with audit/outbox/
  replay/refusals, minor-to-adult OWNER rule incl. an OWNER grant revoked while
  the command waits on the student lock (nothing commits).
- Guardian/child proof group 13: ungoverned drift still staff review, invalid
  corrected name refused, governed name and birth date corrections recorded
  (snapshot unchanged), display name follows the correction, DRAFT created
  against the corrected identity, corrections immutable and private. Posture
  pins the replaced family read as 0176 with exactly the displayName change.
