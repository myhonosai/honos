# Automatic contact consent at lead intake (IC1, migration 0555)

Status: spec, 2026-11-19. Owner ask (David, 2026-11-19 05:07Z): "Any contact info coming in is through lead input,
so it should be assumed consent. Can we make it that way so we don't have this step?" The step is the contact card's
**Record agreement** button (0046 consent writer, `communication-consent.service.ts`).

## Goal

Every contact that reaches a school through lead intake gets email and text consent recorded **when the record is
created**, with how and when it was captured kept as evidence. Staff no longer press Record agreement for them.
An opt-out always wins: a STOP reply or unsubscribe still flips the record to Opted out, and automatic capture never
overwrites an existing opt-out, including one recorded on another record with the same phone or email.

## Policy (owner decision 2026-11-19 05:12Z: "Email automatic, texts one tick")

| Intake path | How the record is created today | Email | Text |
|---|---|---|---|
| Website / lead form (0075) | `create_public_form_lead`, source `PUBLIC_API` | automatic | when the lead ticks the unticked "Text me" box |
| Walk-in kiosk, incl. phone QR form (0414/0537) | kiosk submit, source `WALK_IN_KIOSK`; its existing "school news" tick already writes both channels | automatic | when the visitor ticks the existing box, relabelled "Text me" with the texting wording |
| Facebook / Instagram via Zernio (0250) | `record_zernio_lead`, source `ZERNIO_META` | automatic | not automatic (HON cannot show wording or a box on Meta's form; follow-up: map a Meta consent question) |
| Text conversation / missed-call text-back (0364, 0249) | staff "create lead" from a conversation, source `CONVERSATION_SMS` | n/a (no email) | automatic **only if the person has texted the school** (an inbound message exists) |
| Staff add (lead create, add person) | API `lead.service` / `person.service` | default ticked, staff can untick | default ticked, staff can untick |
| Lead CSV import (0067/0074), student CSV import (0226) | import finalize via API | default ticked, staff can untick | default ticked, staff can untick |

"Parent sign-up" for a school contact today is the kiosk's phone QR form (same submit path as the kiosk). Demo data
(0459) and registration child/guardian records (0160/0176) never get automatic consent.

## Rules

1. **Never overwrite.** If the person already has a consent row for the channel (either status), nothing changes.
2. **Address-level opt-out wins.** If any person in the same school with the same phone (SMS) or email (EMAIL) is
   `OPTED_OUT`, the new record gets `OPTED_OUT` (source `RECIPIENT`, method `PRIOR_OPT_OUT`, evidence = the earlier
   consent id) instead of an agreement. A later STOP still flips every matching record (0248 unchanged).
3. **Only channels with an address.** No email address, no email consent; same for phone.
4. **Serialization.** Same per person/channel advisory lock as every consent writer (0217 / consent service).
5. **Evidence, no PII.** One append-only capture row per automatic record: method, consent version, the form or
   batch id and version, the disclosure wording version shown, and the actor. Never a name, email, phone or IP.
6. **Audit and outbox.** `communication.consent.intake_recorded` audit event and the existing
   `communication.consent.recorded` outbox event (same payload shape as 0243), so downstream readers see one kind.
7. **Nothing sends.** Recording consent starts no message, automation or welcome.
8. **Staff paths are opt-in by the API.** Staff/import capture happens only when the API calls
   `hon.record_staff_intake_consent` for a direct human staff command with the right permission, and only for
   people created in that transaction; anything else that inserts people (demo data, registration, merges) records
   nothing.

## Mechanism (no rewrite of existing intake functions)

- `hon.communication_consent_captures` (new, forced RLS, append-only, runtime SELECT only).
- `hon.record_intake_consent(org, school, person, channel, method, evidence, actor)` SECURITY DEFINER, applies
  rules 1-7. Not granted to runtime.
- Deferred constraint trigger on `hon.crm_leads` INSERT (fires at commit, after the path's own writes such as the
  kiosk tick): maps `PUBLIC_API`, `ZERNIO_META`, `WALK_IN_KIOSK`, `CONVERSATION_SMS` to methods and evidence from the
  lead's attribution.
- Runtime entry point `hon.record_staff_intake_consent(subject, {method, channels, personId | batchId})` for staff
  add and imports (methods `STAFF_ADD`, `LEAD_IMPORT`, `STUDENT_IMPORT`; channels any of `EMAIL`, `SMS`, or none).
  It re-checks the signed-in subject, the permission for the method, and touches only people created in this
  transaction.
- The wording version is kept as evidence only where HON showed the wording (website form, kiosk).
- `hon.read_published_form` adds `schoolName` so the form can show the wording.

## Wording (shown next to submit)

Under submit: "By submitting, you agree that {school} may email you about your enquiry and classes. You can
unsubscribe at any time."

Unticked box: "Text me about my enquiry and classes. Message and data rates may apply. Message frequency varies.
Reply STOP to opt out, HELP for help. Consent is not a condition of purchase."

Korean and Spanish translations ship with it. Version `IC1-2026-11-19` is stored in evidence.

## UI

- Contact card: the consent line names how it was captured, e.g. "Recorded Nov 19 from the website form". Record
  agreement stays for contacts with nothing recorded (older records, staff who unticked).
- Website form: the email wording above submit and the unticked "Text me" box (sent as `textOptIn: true` only when
  ticked). Kiosk: the existing tick is relabelled to the texting wording and the email wording sits under it.
- Add lead dialog and both import finalize steps: "Record email and text consent" box, ticked by default; unticked
  sends `consentChannels: []`. There is no add-person dialog in the web app today; the API accepts `consentChannels`.
- Follow-up: privacy and terms links next to the Text me box once schools have those pages (A2P thread, PR #501).

## Known effect

0217 blocks editing an email or phone while that channel is `OPTED_IN`. With automatic consent, far more records are
`OPTED_IN`, so staff fixing a typo in a new lead's phone will hit "record an opt-out first". Follow-up (not in IC1):
allow an address correction to carry consent across when the change is a correction made by staff.

## Out of scope

Backfilling consent onto existing contacts (would be assuming consent for records with no evidence of how they
arrived); Meta form consent-field mapping; any send.
