# Face check-in with parent consent: spec (v1, 2026-11-16)

Owner request (David, 2026-11-16): a camera matches a student's face to their profile photo and records attendance.
Opt-in per school. Notification and consent form made for the school's state or country (Illinois BIPA, Texas CUBI,
Washington, California and others; GDPR and Korea PIPA outside the US), with written consent, retention and deletion
policy. Schools are told about it at onboarding based on their address.

**Status of legal text: every notice and consent form in this feature is a TEST-ONLY DRAFT and must be reviewed by a
lawyer before any real school uses it.** Nothing here is legal advice. The database refuses a "lawyer approved" form
until a later reviewed migration adds one.

## Verified starting point

- Onboarding does **not** collect an address. Sign-up (0241, `hon.register_hon_os_school`) takes owner name, school
  name, legal name and time zone only, and no table anywhere stores a school's street, city, state or country
  (checked `packages/database/migrations/*`, contracts and web, 2026-11-16). So this work adds it.
- Student profile photo: 0390 `hon.person_photos` (other thread, branch `claude/project-thread-wn0g0o`). Remove is a
  hard delete; replace is an update with a new checksum.
- Check-in: 0391 internal `hon.attendance_check_in_student(subject, session, student, method, method_ref, status, key,
  request, correlation)` calls the existing `hon.record_attendance` (0115) and writes `hon.attendance_check_ins`.
  Face check-in calls it with method `FACE` (0393 widens `attendance_check_ins_method_check`).

## Design rule: one strict baseline everywhere, plus local add-ons

Rather than a different standard per state, every school that turns this on gets the strictest common baseline:

1. Written (electronic) consent before any face data is made. For anyone under 18, or with no birth date on file, only
   a parent or guardian can sign. Adults sign for themselves, and a guardian cannot sign for a student who is 18 or
   older (0443 refuses it with FACE_CHECKIN_ADULT_SIGNS). Age is counted on the school's own calendar date (its time zone).
2. A published retention and deletion policy shown before signing.
3. Face data is never sold, shared, or used for anything except check-in at that one school.
4. Anyone can refuse or withdraw at any time and still check in another way (card, name list). Refusing never blocks
   class or membership.
5. Deletion (see Retention). No camera picture is ever stored.
6. A staff member confirms every match before attendance is recorded (no unattended kiosk in v1, same as 0391).

The school's location picks a **jurisdiction profile**, which adds the local form wording and any extra steps:

**United States only for now (owner decision 2026-11-16).** HON OS launches with US schools, so 0443 reports every
non-US profile as `NOT_LAUNCHED` and refuses to turn face check-in on there. The EU, UK and Korea drafts stay in the
database, unused, for a later launch (after legal review).

| Profile | Where | Status | Local add-ons |
|---|---|---|---|
| US_IL_BIPA | Illinois | Available with consent | Written release naming purpose and length of storage; public retention schedule; private right of action warning to school |
| US_TX_CUBI | Texas | Available with consent | Notice before capture; destroy within 1 year of purpose ending (baseline is stricter) |
| US_WA_BIOMETRIC | Washington | Available with consent | RCW 19.375 notice + My Health My Data consent wording (biometric = consumer health data) |
| US_CA_CCPA | California | Available with consent | Notice at collection, sensitive personal information wording |
| US_CO_CPA | Colorado | Available with consent | Biometric amendment (HB24-1130): written policy, consent, no denying service for refusing |
| US_NYC | New York City | Available with consent | Entrance sign that biometric data is collected (NYC Admin Code 22-1202); school confirms the sign is posted |
| US_PORTLAND_BAN | Portland, Oregon (city) | **Blocked** | City ordinance bans private face recognition in places of public accommodation |
| US_GENERAL | Other US states | Available with consent | Sensitive-data consent wording; under-13 parental consent (COPPA) covered by baseline |
| EU_GDPR / UK_GDPR | EEA countries, UK | Available with consent | Explicit consent (Art. 9); school confirms a data protection impact assessment (Art. 35) is done; alternative check-in stated |
| KR_PIPA | Korea | Available with consent | Separate consent for sensitive information; items, purpose, retention, right to refuse and its effect; legal representative under 14 (baseline is under 18) |
| NOT_REVIEWED | Everywhere else (incl. Canada/Quebec) | Unavailable | Shown as "not available in your area yet" |

Unknown or missing location means Unavailable. The table is data (versioned rows), so a lawyer's changes are a new
migration, not code.

## Onboarding notice (0392)

- Sign-up asks for the school address: country, state/province (where the country has them), city, postal code,
  street (street optional). Stored in `hon.school_locations` with an append-only change history.
- After sign-up, and on a new **Settings > School location** page, the school sees a plain notice for its profile:
  "Face check-in is optional. In Illinois it needs a parent's written consent before use ..." or "Face check-in is not
  available in your area". It is information only; it does not turn anything on.
- Existing schools without an address see "Add your school address" on that page and in the face check-in settings.

## Face check-in program (0393)

- **Program switch**: `hon.face_checkin_program` is CLOSED; only the migration owner of a test database can set
  TEST_MODE (same pattern as 0241 sign-up). Production stays closed until a reviewed migration with approved forms.
- **School opt-in**: owner-only, verified human. Requires: location set, profile available, the school ticks the
  required acknowledgements (retention policy posted, sign posted for NYC, impact assessment for GDPR). Turning it off
  deletes every face template at that school immediately; consents stay as records but must be re-confirmed.
- **Consent forms**: one immutable version per profile and language (en/ko/es), status TEST_ONLY_DRAFT, content digest.
- **Consent records**: student, signer (guardian with family access to that student, or the adult student), signer
  relationship, form version + digest, typed full name, signed time, method (PARENT_PORTAL, or IN_PERSON witnessed by
  staff who attests they checked the signer). Withdrawal by the signer in the portal or staff on request; withdrawal
  deletes the template at once. A guardian with family access may also withdraw an adult student's consent (withdrawal
  only ever removes data, so it is allowed from any guardian of the family and from staff).
- **Enrollment**: when the school is on, consent is active and a profile photo exists, staff enroll the student. The
  face template is made from the current photo. If the photo is removed or replaced, the template is deleted (re-enroll
  from the new photo).
- **Matcher**: SYNTHETIC only. It treats a picture as matching when it is byte-identical (after metadata stripping) to
  the enrolled photo; it is a stand-in, not face recognition. A real provider (on-device or paid) needs owner approval
  and a new migration (cost, data-transfer terms, accuracy testing across ages and skin tones).
- **Check-in**: staff open Face check-in for a class session, the camera takes one picture, HON proposes at most one
  student from that school who is enrolled and consented, staff confirm, and attendance goes through
  `hon.attendance_check_in_student(..., 'FACE', match_id, ...)`. The picture is discarded after matching; the match
  record keeps no image.
- **Retention**: the template is deleted at the earliest of: consent withdrawn, photo removed or replaced, school turns
  it off or moves to a different profile, 30 days after the student is no longer ACTIVE (measured from the student
  record's last change in 0443, so a later edit restarts the clock; a status-change timestamp is a follow-up), 12 months without a
  face check-in. An identifier-only record (who, when, why deleted) remains. Sweep runs on access and as a daily job
  (deployment requirement, like 0388).

## Out of scope (v1)

Real face matching provider, unattended kiosk, parent paper upload of consent, HQ-wide reports, selling or AI use of
face data (never).

## Owner decisions still open

1. Lawyer review of all notices and forms before real use (required).
2. Which real matcher, if any (on-device in browser vs paid provider). Not built.
3. Whether HQ should be able to see which schools have it on (proposed: yes, counts only).
