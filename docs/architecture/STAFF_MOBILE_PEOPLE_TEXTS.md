# HON Staff app S4: People and Texts (spec)

Status: built 2026-11-22; app PR follows S2 (#596 and the HON tab). Owner asks: David, 2026-11-22. He asked "Does this app
have access to read and search contact?" and then, at 07:52Z, "as long as it's in plan it's good. Keep building."
Plan: `/mnt/project-files/staff-app/STAFF_APP_PLAN.md` section 2 (People, Texts) and phase S4. Builds on
S0/S1/S2 (`STAFF_MOBILE_SIGN_IN.md`, `STAFF_MOBILE_TODAY.md`, `STAFF_MOBILE_HON.md`). There is no migration.
**Security-material: this widens the staff app route allow-list to contact data and replying to texts. It goes on the
pre-launch risk list with S0 to S2.**

## What the app does
- **People**: search the school's contacts by name, phone or email. Results come back as one page of matches in name
  order, so typing more narrows it down. Tapping one opens a short card with:
  - name, segment, program, plan and ranks
  - phone and email
  - when the membership ends
  - the last class attended (from the card's timeline)
  - memberships, family and balance due, but only when the server says the person's role includes that section

  Call and Text hand the number to the phone's own apps. HON sends nothing from this screen.
- **Texts**: the school inbox, newest first, with an unread count.
  - Opening a conversation shows its latest messages and marks it read up to the newest message on screen.
  - A person whose role includes `conversation.manage` can reply. Replies go through the same consent-gated queue as on
    the web.
  - Refusals are explained in plain words, and none of them sends anything: no consent, no texting number, not linked,
    address mismatch, channel not supported.
  - A reply whose outcome is unknown, or that was sent while offline, keeps its idempotency key. Sending again is the
    same command, so it can't send twice.
  - Older messages, attachments, assign, tags, open/close, link and create-lead stay on the web.

## Staff app routes added
These are added to `STAFF_MOBILE_ROUTES` in `apps/api/src/foundation/hon-identity.service.ts`. Each one has exact
methods, is anchored, and has UUID segments.

| Method | Path under `/v1/organizations/:org/schools/:school` | Re-decided live by the existing route |
|---|---|---|
| GET | `/contacts` | `people.read` (0521); the query is closed by `validateSchoolContactQuery` |
| GET | `/contacts/:person` | `people.read`; each card section is re-checked against its own permission (0522) |
| GET | `/conversations` | `conversation.read` (0364) |
| GET | `/conversations/:conversation` | `conversation.read` |
| POST | `/conversations/:conversation/read` | `conversation.read`; no idempotency key (server rule) |
| POST | `/conversations/:conversation/replies` | `conversation.manage`; Idempotency-Key; consent and sender checked in the database |

Still refused from the app with 403 `MOBILE_SESSION_SCOPE`:
- contact archive, restore and merge
- conversation update (assign, tags, status), link and create-lead
- the people directory and staff search pages
- every other method on these paths

## Transport
No guard was changed.
- `SchoolContactsHumanUiGuard` and the `Conversation*Guard`s extend `MembershipActivationHumanUiGuard`, which extends
  `CurriculumHumanUiGuard`.
- GETs pass as long as there is no source or delegation header and no cross-site fetch metadata.
- A native POST already has the M2 rule: no Origin, no Sec-Fetch-Site, the exact `X-HON-Human-Command`
  (`conversation.reply` or `conversation.mark_read`), and a JSON body.
- `SchoolConversationsService.assertStaff` still requires a direct human command.

## Tests
- API `apps/api/test/staff-mobile-people-texts.test.cjs` checks:
  - the six routes and methods are admitted, and the admin and management routes and look-alike paths are refused
  - the family app is refused
  - native GET reads pass, and delegation, automation or cross-site headers are refused
  - the native POST rule and the unchanged web rule for reply and mark read
- App `apps/staff-mobile/test/people-texts.test.tsx` covers:
  - the client: paths, no key on reads or mark read, the reply key and body, verifiers refusing the wrong page or
    person, refusal mapping
  - the screens: search, then card; sections the role lacks are hidden; Call; no access; no match; open marks read;
    reply shown as sent; an unknown outcome reuses the key; blocked reasons; a read-only role sees no reply box
- Screens: `/mnt/project-files/staff-app/s4/`.
