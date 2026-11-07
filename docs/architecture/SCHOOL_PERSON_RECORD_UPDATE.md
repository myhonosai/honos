# School person record update (B-CRM-1a, migration 0217 proposed)

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

Out of scope (later slices): student birth date and student status
(they interact with the E1a activation gate and the open D3 adult-path-minors
decision), family membership changes, merging duplicate people, deleting people,
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
  "student": { "birthDate": "2015-04-02", "status": "ACTIVE" },
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
(`communication-consent.service.ts`), EMAIL before SMS, held to commit, and only then
reads that channel's consent row `FOR SHARE`. A consent capture in flight for the old
address (an update or a first insert) therefore finishes first and the edit refuses;
an edit that wins first finishes before the consent capture, which then applies to the
new address. The consent writer never waits on the person row (its FK check takes
KEY SHARE, compatible with the edit's NO KEY UPDATE), so the order person row ->
advisory lock cannot deadlock. Proof group 10 covers EMAIL and SMS, existing opt-in
and first insert, change and clear, and the reverse order.

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
