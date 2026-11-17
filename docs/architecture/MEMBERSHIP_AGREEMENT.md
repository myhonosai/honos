# Membership agreement with one signing (0463)

Owner decisions (David, 2026-11-17): one signing page; face check-in is a separate, optional box with its own photo step on
that page; parents can upload their child's photo in the parent portal; face check-in stays US only.

## What it does
- **School agreement.** Staff with `membership.agreement.manage` (OWNER by default) save a draft per language (en required,
  ko/es optional) and publish exactly the drafts they previewed as a new immutable version. Each language text has a
  SHA-256 digest of `title + "\n\n" + body`. HON ships no agreement text; the school confirms it is responsible for its wording.
- **One signing.** In the parent portal a PRIMARY or SECONDARY guardian reads the current version, ticks the e-sign consent box,
  types their full name and signs once for every listed child. One server command, one transaction:
  - one signature row per child, bound to the version, language and digest;
  - for each child whose face box is ticked, that child's 0443 face consent (`hon.face_checkin_write_consent`, PARENT_PORTAL,
    GUARDIAN), linked from the signature row. Either everything is saved or nothing is.
- **Parent photos.** A guardian adds, replaces or removes a photo of a child under 18. The API strips metadata (0390 rules);
  a change deletes the face template through the 0443 trigger and the reply says how many were deleted.

## Rules
- Covered child: a DRAFT or ACTIVE membership at the school. A guardian signs for a child under 18 or with no birth date
  (school calendar date). A student aged 18 or over signs for themselves; the portal cannot yet tell that the signed-in
  person is that student, so such a child is shown as `SELF` and refused here. VIEWER grants read only.
- Face box refused (and then nothing is saved) when the program is CLOSED, the school is OFF, the form changed, the child
  has no photo, or a current face consent already exists. Never a condition of signing.
- A new version never edits earlier signatures; they read "Needs signing (new version)". An unsigned agreement blocks
  nothing (owner decision D2 open).
- Audit and outbox carry identifiers only; the typed name lives only in the signature row (never in receipts).
- Same security pattern as 0443: SECURITY DEFINER entry points, forced RLS, EXECUTE-only runtime grants, infra 010/011
  sections, human-command markers, idempotency receipts, authority re-checked after the last write.

## Entry points
| Who | Route | Function |
| --- | --- | --- |
| Staff | `GET /v1/school/schools/:schoolId/membership-agreement` | `read_membership_agreement` |
| Staff | `POST /v1/school/membership-agreement/draft` | `save_membership_agreement_draft` |
| Staff | `POST /v1/school/membership-agreement/publish` | `publish_membership_agreement` |
| Parent | `GET /v1/parent/membership-agreement` | `read_family_membership_agreement` |
| Parent | `POST /v1/parent/membership-agreement/sign` | `sign_family_membership_agreement` |
| Parent | `POST /v1/parent/person-photo/set` | `set_family_child_photo` |
| Parent | `POST /v1/parent/person-photo/remove` | `remove_family_child_photo` |

Proof: `packages/database/scripts/test-membership-agreement-integrity.mjs` (Champions Club fixture).

## Open owner decisions
D1 lawyer review of the face forms and a sample agreement template; D2 whether an unsigned agreement blocks activation;
D3 re-signing on a new version for existing members; D4 an installable app for parents. Adult self-signing in the portal
needs a verified link between a sign-in and a student record (later work).
