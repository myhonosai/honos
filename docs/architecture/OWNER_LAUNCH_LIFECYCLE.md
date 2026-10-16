# Owner launch lifecycle — bounded conventional setup

**Status:** adult-only bounded vertical (`0133`) retained unchanged; separate guardian-and-child extension (`0134`), saved-student confirmation (`0135`–`0136`), receipt-only first-class booking (`0137`), receipt-bound fixed-term membership DRAFT (`0138`), receipt-backed Owner Launch setup progress, and the additive StaffDashboard confirmation-only progress presentation are completed bounded surfaces. They are not production readiness; final checkpoint evidence is recorded in TODO.

This is the conventional path from an already provisioned and authorized school-owner context to saved program, class, student-registration, one canonical booking/waitlist receipt and one receipt-bound fixed-term membership DRAFT. The DRAFT is not activation. This is **not** public sign-up, parent onboarding, family readiness, enrollment-to-membership completion, attendance, payment setup or a complete school readiness checklist.

> The sole authority for school provisioning remains the separate HON HQ onboarding boundary. `/staff/launch` never creates an organization, school, login, HQ grant, staff account or cross-school access.

### Delivered presentation-only interface preference

After the existing verified owner-launch context read succeeds, `/staff/launch` presents the shared **Big-Button / Phone**, **Modern HON**, and **Classic CRM** interface cards. Their labels describe touch-first, balanced daily-work, and high-density keyboard-and-mouse interaction respectively. Selection is optional and can be changed later.

This reuses the existing per-principal interface-theme preference contract and scoped `GET`/`PUT /organizations/:organizationId/schools/:schoolId/interface-theme` API. The saved value is scoped to the current authenticated principal plus its verified organization/school; it is never a tier, role, feature, permission, authority, entitlement, school-context, or data switch. The cards load only after the verified launch context provides that scope, disable while loading/saving, and state unavailable/error outcomes without claiming a save. The responsive shared picker retains semantic button labels, pressed state, keyboard operation, and a live status message.

The three existing owner-launch commands and their fixed endpoint paths, bodies, direct-human markers, idempotency behavior, receipts and results are unchanged. The preference is sent only to the existing preference endpoint; no preference field enters a launch command, and no selector is added to a launch command. It has no provider, Action Engine, payment, membership, booking, attendance, communication, worker, or external effect. Focused preference API/UI regressions plus the complete web test, type-check, and build validation passed for this presentation-only delivery.

### Receipt-backed Owner Launch setup progress

After the existing verified owner-launch context and its existing selector-free booking/DRAFT confirmation reads settle, `/staff/launch` displays six passive facts: verified school context, first program, first class, student registration, first-class booking, and membership DRAFT. Each tile is only **RECORDED**, **NOT_RECORDED**, or **UNAVAILABLE**. Recorded means the exact existing context or receipt is present; it is never a school-readiness score, lifecycle completion claim, activation, payment, attendance, eligibility, parent-access, communication, or permission proof.

The booking tile deliberately does not manufacture a seat/attendance outcome; it describes only a current receipt-linked booking confirmation. The membership tile is explicitly **DRAFT only — not active**. The guide makes no request beyond the page's existing fixed reads, stores no state, adds no command or selector, and has no provider, Action Engine, financial, automation, worker, or external effect. It is a visual guide over the same existing direct-human/current-school boundaries, not a new onboarding model.

### Conventional dashboard handoff

Once Owner Launch has already obtained its verified current-school context, it offers one ordinary link to `/staff/dashboard`. The link carries only that context's organization and school UUIDs as URL-encoded **untrusted prefilled text**. The authenticated dashboard server route bounds these query values to short strings and renders its normal idle form; it does not request a report, derive authority, display data, persist a preference, or issue a command from the link. The owner must explicitly load the dashboard, and the existing dashboard API independently resolves the current human, exact school, entitlement and `reporting.view` permission before any report is shown.

No receipt, registration/student/family data, booking/membership context, tier or permission proof, theme state, Action Engine request, financial/provider value or external effect crosses this handoff. It is navigation only—not a scope grant, dashboard auto-load, onboarding-completion claim or lifecycle transition.

## Purpose and routes

The authenticated, dynamic, no-index `/staff/launch` flow uses only fixed same-origin API paths, under `/api/v1`:

| Method/path | Fixed boundary |
| --- | --- |
| `GET /owner-launch` | Current direct-human school context and requester-owned saved creation receipts; not a directory or current-eligibility read |
| `GET /owner-launch/saved-students` | Selector-free current requester confirmation of at most five newest receipt-linked current student profile/display-name records; not a student/family directory |
| `POST /organizations/:organizationId/schools/:schoolId/programs` | Existing Program command |
| `POST /organizations/:organizationId/schools/:schoolId/schedule/sessions` | Existing Class Session command |
| `POST /organizations/:organizationId/schools/:schoolId/student-registrations` | Unchanged adult-only `hon.register_owner_launch_student` |
| `POST /organizations/:organizationId/schools/:schoolId/guardian-child-registrations` | Separate closed `hon.register_owner_launch_guardian_child` |
| `POST /owner-launch/membership-draft` | Fixed receipt-only canonical account/membership DRAFT command; never activation or payment |
| `POST /owner-launch/first-class-booking` | Fixed receipt-only wrapper over the canonical class-booking row/capacity/waitlist path |

The page route and its manifest entry are unchanged. The API derives verified identity and one exact eligible school. Receipt IDs select fixed server routes but never confer authority. No freeform destination, selector/query, source/action/delegation header or client tier/permission/role is accepted. Every mutation requires trusted exact configured same-origin JSON, an Idempotency-Key, and its fixed direct-human marker. The child route uses `X-HON-Human-Command: owner-launch-guardian-child-registration`; the adult route retains `owner-launch-student-registration`. Neither marker authorizes the other route.

## Authority and scope

All launch reads and both registration commands require the existing `0133` scope:

- verified direct `HUMAN_USER` / `HUMAN_UI`, no delegation or Action Engine request;
- exactly one live human principal and unambiguous active organization/school;
- exactly one active Essential, Core or Complete entitlement;
- no live family/parent/guardian or HON HQ grant or excluded parent/student/HQ/system role context;
- every existing permission: `school.view`, `people.create`, `student.profile.manage`, `curriculum.progress.record`, `program.manage`, `schedule.session.manage`.

**Child registration additionally requires the exact sensitive `family.manage` permission.** Existing `family.create`, `family.read` and `family.member.manage` are not substitutes. Migration `0134` registers that permission and follows the established **system OWNER-only bootstrap** mapping; it does not give ordinary staff, parents or HQ school authority. Authorized custom roles still require the complete permission set, as in `0133`; the OWNER label alone is not authorization.

SQL resolves actual live scope before/after bounded IAM locks, after advisory/context/identity waits, immediately before writes and again before returning. Revocation, expiry and ambiguity fail closed, including replay. IAM locks prevent permission/grant phantoms and writes during execution; clock-based reauthorization handles expiry. Runtime transaction context and its verified external subject are independently matched by the fixed definer. UI, supplied IDs and forged GUCs cannot replace live authorization.

The additive owner projection has `guardianChildRegistration: null | redacted receipt`. It selects only this actor's receipts matching that actor's saved program/class. Without current `family.manage` it returns **null**, never a family directory, another owner's receipt or a readiness assertion. Family authority is checked again before returning a child receipt. Parent reads, grants, sessions and privacy policies are unchanged.

### Saved-student confirmation — additive `0135`–`0136`

`GET /owner-launch/saved-students` has no organization, school, registration, student, family, cursor or query selector. It repeats the same live direct `HUMAN_USER`/`HUMAN_UI` owner-launch resolver and lock/recheck, including exact current role/permission, one active Essential/Core/Complete entitlement, parent/family/HQ exclusion and delegated/Action Engine denial. The response is either **`NO_RECORDED_REGISTRATIONS`** or a fixed maximum of five newest **`RECORDED_REGISTRATIONS`** entries, each containing only authoritative organization/school scope, registration ID, current student profile ID, sanitized current display name, receipt creation time, `NEW_ADULT_NO_GUARDIAN` or `NEW_CHILD_WITH_NEW_GUARDIAN`, and honest **`REGISTERED_NO_BOOKING`**.

The immutable receipt is the sole authority link: the function first limits to the current actor's exact current-school adult/child receipt, then joins that receipt to the current same-school student profile and person. It returns neither receipt JSON nor a general profile/person row, and it has no path to guardian/family/birth/contact/payment/booking/attendance/testing/curriculum/grade/rank data. Private receipt relations remain forced-RLS/no-policy/no-runtime-table-grant; the runtime has only fixed function execution. The staff dashboard calls this same-origin no-store GET only after the existing operations-dashboard read succeeds and renders it only when the returned authoritative organization/school exactly matches that verified dashboard result; any mismatch is unavailable, not a cross-school display.

### First-class booking — in-progress `0137` boundary

`POST /owner-launch/first-class-booking` accepts exactly an immutable adult or guardian-child **registration receipt ID**, `expectedReceiptVersion: 1`, and the exact current `expectedClassSessionVersion`. It has no student, family, program, class or school selector. The fixed wrapper independently resolves the existing owner-launch scope and the canonical `schedule.booking.manage` scope, then joins the requester-owned current-school receipt to its exact student profile, enrollment, program and class session before acquiring the existing canonical class-session lock.

The only durable booking record is the existing `hon.class_bookings` row with canonical `REGULAR` / `STAFF` semantics. The capacity decision remains canonical: **`BOOKED`** when capacity permits and **`WAITLISTED`** when it does not (including the existing `WALK_IN` rule). A matching canonical regular booking is returned as a replay rather than duplicated. The bounded response contains only registration ID, booking ID, class-session ID, canonical `BOOKED` or `WAITLISTED` status, booking version and recorded time; it does not assert a seat beyond that canonical status, membership, payment, eligibility, attendance, parent contact or family readiness.

This wrapper is fail-closed for stale receipt/class versions, cancelled/unavailable class context, foreign receipt/student/school context, parent/family/HQ/nonhuman/delegated/Action Engine contexts, lost owner or booking permission, inactive tier and idempotency mismatch. It preserves canonical booking audit/outbox/idempotency behavior and does not introduce a booking table, generic owner booking selector, cancellation behavior, ClassPass/Kiosk path, payment, membership, attendance, parent access, message, provider, AI, Action Engine, worker or external execution boundary. Its local proof and wider checkpoint validation remain in progress; this description is not a completion or production-readiness claim.

## Two deliberately separate registration commands

### Adult — unchanged `0133`

The adult command accepts only one new adult, exact program/class IDs and expected versions, bounded given/family names, birth date and `NEW_ADULT_NO_GUARDIAN_REQUIRED`. It creates an existing person, student profile and program-only enrollment with **no family**. Its historical current-date adult guard remains unchanged as well as its class-date program age check. Children, guardians and potential existing people remain unsupported at this boundary.

### Exactly one new guardian and one new child — `0134`

The separate child command accepts exactly eleven keys:

- `programId`, `expectedProgramVersion`, `classSessionId`, `expectedClassSessionVersion`;
- `guardianGivenName`, `guardianFamilyName`, `guardianBirthDate`;
- `childGivenName`, `childFamilyName`, `childBirthDate`;
- `attestation: NEW_CHILD_WITH_NEW_GUARDIAN`.

No existing person/family ID, array of guardians/children, parent account, contact, billing, authority, role, tier or financial field is allowed. Missing/unknown keys, impossible dates, unbounded names and alternate attestations fail closed.

The guardian must be **adult (18+) at the exact future class's UTC date** and the child must be **under 18 at that date**; neither birth date may be future or before 1900. Guardian and child cannot be the same normalized potential person. The exact current-school program must be DRAFT/SCHEDULED; its exact class must be SCHEDULED and future, in that same school/program. Both versions must match, and the child's age in complete months must satisfy the program's bounds.

Potential existing identity is **staff work**, never a merge or lookup response: school-local names are compared case/spacing/punctuation-insensitively, independent of birth date; an existing student with the child's surname and birth date is also treated as ambiguous. The command reveals no matching IDs, existence details, siblings or co-guardians. It makes no cross-school identity inference. This is conservative duplicate prevention, not a verified identity service; nicknames/aliases/identity verification and linking existing families remain separate human workflows.

On success it atomically creates:

1. Two existing `people` rows: one guardian, one child, with **no email/phone/contact**.
2. One existing `families` row, using a generic non-PII display label.
3. Exactly two existing `family_members`: explicit `GUARDIAN` and `STUDENT`, both **not billing contacts**.
4. One existing child `student_profiles` row linked to that child person and exact primary family, with child birth date. No guardian student profile is created. The guardian birth date is validated but not added to an invented identity model; no existing guardian-person birth-date field exists.
5. One existing `student_curriculum_enrollments` record targeting only the program, with curriculum/rank null.
6. Private immutable receipt, redacted `student.guardian_child.register` audit, and permanently **INERT** fact/event evidence.

No family-access grant, user/principal/login/session, sibling or co-guardian is created or inferred.

## Idempotency, relations and immutable evidence

Migration `0133` remains the sole program-only enrollment schema change; applied migrations `0001–0133` are not altered. Migration `0134` adds only exact unique relationship keys on existing family/student tables plus **evidence tables**, not duplicate enrollment/family/identity models:

- `guardian_child_registration_receipts`;
- `guardian_child_registration_outbox`.

Private receipt composite foreign keys bind both family members' exact role/person/family/school, the child's student/primary-family relation, enrollment/student/program/school and class/program/school. Guardian and child person/member IDs must differ. Receipts, audits and inert facts contain no names, dates of birth, email, phone, parent identity, contact or payment data; only fixed redacted receipt-safe identifiers/status/timestamps and input/key digests are stored in the private evidence domain.

Both new tables have forced deny-all RLS, no policies, no runtime/client/PUBLIC table or column grants, and immutable update/delete/truncate triggers. Only the fixed registration function is added to runtime execution rights; the family-authority helper is private. Canonical runtime reconciliation and exact verifier register both tables, exact function ACL/ownership/search-path/volatility/no-overload posture, immutable triggers, exact columns, composite constraints, replay uniqueness and permanently inert event/state checks.

The command shares school-level advisory serialization with the adult command. Replay is scoped per organization/school/actor/key digest within the separate command, requires identical input fingerprint and **live current authority**, and returns the original immutable receipt without writes. Changed input/key conflicts; new requests must pass current expected versions. A replay is a historical creation receipt, not current program/class eligibility. Program/class/identity locks and all business/evidence inserts are one transaction; failed audits/facts roll back every record.

## Truth labels and absent effects

Both results are **`REGISTERED_NO_BOOKING`**. In child mode the UI explicitly says **one guardian/child relationship recorded — not family readiness or parent access**. Program-only enrollment is not membership or class booking. The page displays saved creation receipt facts only, hides further registration after a verified saved receipt, and links only existing conventional staff modules.

The UI clears both people's private inputs, attestation and retry state on mode change, visibility/focus invalidation and access denial. A changed operation/input gets a fresh key; uncertain outcomes require saved-receipt reload or the exact same request/key, never guessed success. Transport remains same-origin fixed HTTP only, with no browser storage or external calls.

Neither registration command itself creates membership, billing/payment account or method/outcome, invoice, booking, attendance, curriculum/rank progression, testing/promotion, ClassPass, communication/contact delivery, parent login/session/access, Action Engine request, AI/provider execution, automation, worker or outbox consumer. The separate receipt-only booking wrapper creates only the existing canonical booking/audit/outbox/idempotency effects described above; it creates none of the other outcomes in this paragraph. No provider, external HTTP, deployment or publishing is performed. Broader school readiness, existing-identity/family linking, siblings/co-guardians, parent accounts, verified identity, contact, billing and downstream operation remain unsupported by this bounded extension.

## Local validation boundary

`pnpm db:setup-owner-launch` requires the explicit marked localhost-only target and a fresh private job-directory descriptor file; it refuses remote/unmarked targets, inherited database URLs/PG overrides, provider/payment/communication/execution environment values and unsafe files. `pnpm db:test-owner-launch` loads credentials only through the verified mode-0600, non-symlink, descriptor-bound loader. All non-local networking is disabled and external call count must remain zero.

The same guarded local proof exercises both registration commands, selector-free confirmation and the receipt-only booking wrapper: two-school independent registrations; receipt-to-current-profile/person/enrollment/class links; adult/child display-name redaction; booking `BOOKED`/capacity `WAITLISTED`, same-key and new-key replay, canonical-booking coexistence and concurrent capacity contention; receipt/class stale/mismatch and foreign context denial; staff/family/HQ/principal/source/delegation/action/tier/revocation denial; forced RLS and raw ACL/function denial; canonical drift probes; atomic canonical booking audit/outbox/idempotency rollback; whole-HON-table snapshots and zero membership/payment/attendance/AI/provider/message effects for those registration/read/booking commands. The in-progress membership extension separately allowlists only canonical account/membership/audit/outbox/idempotency changes and covers adult/child account create/reuse, generic billing coexistence, exact input, replay/concurrency, authority denials and audit/outbox/idempotency rollback. Every other HON table, including payment schedules/methods/invoices/attempts, booking, attendance, family, communication, AI and provider evidence, must remain unchanged by that command. Focused API/UI/domain tests retain receipt-only transport, redaction and truthful unavailable labels. TODO remains in progress for membership drafting; no delivery claim follows from this documentation.

```bash
# In a scrubbed shell, with no provider/execution/database overrides:
HON_OWNER_LAUNCH_VALIDATION_TARGET=postgresql://localhost:5432/hon_owner_launch_validation \
HON_OWNER_LAUNCH_ENV_FILE=/home/ubuntu/jobs/<job>/owner-launch.env \
pnpm db:setup-owner-launch
# Do not source credentials for this proof; its loader verifies the descriptor.
HON_OWNER_LAUNCH_ENV_FILE=/home/ubuntu/jobs/<job>/owner-launch.env pnpm db:test-owner-launch
```

Generated credentials are never committed or displayed. Parent Journey/Billing regression proofs, `pnpm test`, `pnpm check`, `pnpm build`, `pnpm db:check`, marked-local `pnpm db:verify-rls` and `git diff --check` remain the checkpoint validation boundary. Local tests are not production readiness; the parent agent records final actual validation evidence in TODO.

## Receipt-bound membership DRAFT (`0138`) and confirmation (`0139`)

`POST /api/v1/owner-launch/membership-draft` requires exact same-origin JSON, `Idempotency-Key`, and `X-HON-Human-Command: owner-launch-membership-draft`. The closed body is exactly `{registrationId, expectedReceiptVersion: 1, planCode, termStartedAt, termEndsAt, currency}`. It is available in the launch UI only after one saved registration. Plan code is an exact bounded (1–80 character) opaque staff declaration, **not** a commercial catalog, price, discount or auto-renewal promise. Both timezone-qualified fixed terms and an exact supported ISO currency code are mandatory; no term, currency or price is inferred or defaulted. The fixed ISO code snapshot is shared by contract and SQL; it is not a commercial product catalog.

Migration `0138` adds **one fixed SECURITY DEFINER function**, no account/membership/evidence table or parallel model. The immutable current-requester receipt selects the current same-school composite enrollment/profile/person relation. Adult payer and participant are that student's person; guardian-child payer is the receipt guardian and participant the receipt child, with exact family/member/profile composite links rechecked. It requires all live owner-launch permissions plus **both `billing.membership.create` and `billing.account.create`**, an active Essential/Core/Complete tier, direct human/nondelegated/no-action context, and immutable receipt version 1. Only current system OWNER roles receive the established permission bootstrap; custom roles must explicitly retain the full current permission set. IAM locks and final rechecks retain the existing authority boundary.

Canonical account/membership locks include ordinary billing writers: exactly zero payer accounts creates one normal `billing_accounts` row; exactly one same-currency account is reused; multiplicity or a different currency returns bounded **NEEDS_STAFF** with no matching-person/account identifiers. One normal fixed-term `memberships` row is created as **DRAFT**. No payment schedule or auto-renewal is created. Append-only canonical redacted audit evidence links the registration to the membership; no parallel receipt store is added. Same-key replay and concurrent/new-key repeats of that declaration return one receipt without another membership or duplicate evidence. A different declaration for the same receipt conflicts; changed/activated/scheduled draft context requires staff rather than claiming a current DRAFT. Account and membership, redacted canonical audit/outbox, and idempotency commit atomically; failed evidence rolls everything back. The existing outbox remains unconsumed in local validation; no worker or external execution is introduced.

The bounded creation receipt includes only registration/membership IDs, DRAFT state/version, declared plan/terms/currency, historical account-created boolean and recorded time. It exposes **no payer/participant/account/family IDs**. This is not payment, activation, invoice, communication, booking, attendance, eligibility or family readiness. Existing separate human membership activation is unchanged and is **not linked** from launch. No schedule, method, processor, invoice, attempt, activation, communication, provider, AI, Action Engine, worker or external effect is authorized.

Migration `0139` adds the selector-free current-requester confirmation read. Its only authority link is the immutable canonical `OWNER_LAUNCH_MEMBERSHIP_DRAFT` audit relation; it rechecks the current receipt-derived adult/guardian-child payer/participant relation, one matching current account, DRAFT state, original version/plan/terms/currency/recorded time, and absence of linked schedule or invoice. It returns at most one `RECORDED_DRAFT` receipt with `{registrationId, membershipId, state, membershipVersion, planCode, termStartedAt, termEndsAt, currency, recordedAt}`. Missing canonical evidence yields `NO_RECORDED_DRAFT`; ambiguity or any drift yields `DRAFT_UNAVAILABLE`. It never falls back to a generic membership, emits no read audit/outbox/event, and exposes no actor/account/payer/participant/payment/provider/policy source.

> **Activation remains an owner/product policy blocker.** Before any receipt-bound activation is built, the owner must decide: (1) sufficient contractual signature/consent/schedule evidence; (2) Essential versus Core/Complete availability; (3) required permission and human confirmation; and (4) exact current-draft drift conditions that require staff review. HON must not silently select those policies or use the generic ID-addressable activation route as an owner-launch surface.

## Receipt-linked first-class confirmation (`0140`)

`GET /api/v1/owner-launch/first-class-booking-context` accepts no selectors, query values, body, command marker, source/delegation marker or action request. It is a same-origin `private, no-store` observation only. The function derives the current requester’s immutable adult or guardian-child registration receipt and completed owner-launch booking evidence before joining the one exact canonical `REGULAR` booking, current student/person and class session. It performs the existing live owner-launch/tier/direct-human checks and additionally rechecks `schedule.booking.manage`; parent, HQ, nonhuman, delegated, action, foreign, stale and ambiguous contexts fail closed.

The closed result is `NO_RECORDED_BOOKING`, `BOOKING_UNAVAILABLE`, or `RECORDED_BOOKING`. The recorded projection has only the receipt registration ID, the already-receipted student profile ID and sanitized display name, one class session’s ID/name/start/end/current status/capacity/booking policy, and the one booking’s ID/kind/status/version/recorded time. A currently cancelled class is shown only as `CANCELLED`; a drifted booking never becomes a historical success. It is not a roster, directory, attendance, membership, payment, eligibility, parent-access or communication assertion.

No table changes, audit, outbox, idempotency, booking/capacity, attendance, membership, invoice/payment, provider, message, AI, Action Engine or work effect follows this read. The owner launch browser renders the card only after strict registration/student/class alignment and clears it on unavailable/error/context mismatch. A generic class roster is separate future work with its own authority and bounded pagination policy.

### StaffDashboard first-class confirmation

Only after the existing aggregate-only operations report independently verifies the selected organization and school does `/staff/dashboard` optionally read the existing fixed `GET /api/v1/owner-launch/first-class-booking-context` transport/parser. It first requires the existing selector-free saved-student confirmation to have the exact same authoritative organization/school as that verified report, then requires the booking context's immutable registration ID and student-profile ID to match one of those receipt-linked saved-student entries. There is no dashboard booking, class, student, school, roster, query or fallback read; the fixed context parser remains the sole booking/class boundary.

The concise passive card uses the already-sanitized saved-student name, plus the parser-validated class name/time/status and canonical booking status. It is explicitly labelled **confirmation only** and says it is not attendance, membership, payment, eligibility, parent access or communication. It offers no control, command, action or link. `401`, `403`, unavailable, no-recorded-booking, malformed/error, saved-scope mismatch, registration mismatch or student mismatch clears/hides the card without affecting the ordinary verified dashboard. Focused match/mismatch/no-recorded and exact selector-free GET tests, complete web test/type-check/build and `git diff --check` passed; this display adds no migration, provider/payment or external call/effect, or production-readiness claim.

### StaffDashboard saved-workflow progress — presentation only

After the independently verified current-school operations report, `/staff/dashboard` can make only the existing fixed selector-free, same-origin no-store owner-launch reads: current owner context, saved students, first-class booking context and membership-DRAFT confirmation. It displays the compact passive progress card only after the owner-context organization/school exactly matches the report. That makes this an owner convenience; an ordinary staff member whose owner-context read is denied, unavailable or mismatched receives no owner progress card or owner-record data.

The card&apos;s **School context ready** fact is the existing verified report only. A saved student appears only when a current owner receipt and a saved-student entry have the exact same registration and student-profile IDs in that same report scope. A first-class booking additionally needs that exact receipt/student pair and the exact receipt/current-owner class-session ID. Membership is shown only as a **DRAFT** when its confirmation receipt has the exact already-matched registration ID; it is never activation or a payment result. `NO_RECORDED_*` and unavailable results are explicit only for their own read; missing, denied, malformed or mismatched sources hide dependent steps or label the affected step unavailable. No lifecycle step is inferred from another step.

The card has no action, form, link, selector, directory, generic-staff fallback, command, payment/activation/attendance/eligibility/parent-access/communication claim, or data model/API change. Its screen-reader description states confirmation-only limits, and generation-guarded dashboard loading clears all transient owner progress on scope change, reload, error or late response. Focused exact-read/alignment/mismatch/no-recorded tests plus the complete web test, type-check, build and diff checks passed for this presentation-only surface; it creates no database, provider, payment or external effect and is not a production-readiness assertion.
