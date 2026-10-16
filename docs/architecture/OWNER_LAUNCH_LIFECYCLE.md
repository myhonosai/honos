# Owner launch lifecycle — bounded conventional setup

**Status:** adult-only bounded vertical (`0133`) retained unchanged; separate guardian-and-child extension (`0134`) is implemented with local validation; saved-student confirmation (`0135`–`0136`) is a completed additive read boundary. Final checkpoint evidence is recorded in TODO.

This is the conventional path from an already provisioned and authorized school-owner context to saved program, class and student-registration receipts. It is **not** public sign-up, parent onboarding, family readiness, enrollment-to-membership completion, booking, attendance, payment setup or a complete school readiness checklist.

> The sole authority for school provisioning remains the separate HON HQ onboarding boundary. `/staff/launch` never creates an organization, school, login, HQ grant, staff account or cross-school access.

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

Neither command creates membership, billing/payment account or method/outcome, invoice, booking, attendance, curriculum/rank progression, testing/promotion, ClassPass, communication/contact delivery, parent login/session/access, Action Engine request, AI/provider execution, automation, worker or outbox consumer. No provider, external HTTP, deployment or publishing is performed. Broader school readiness, existing-identity/family linking, siblings/co-guardians, parent accounts, verified identity, contact, billing and downstream operation remain unsupported by this bounded extension.

## Local validation boundary

`pnpm db:setup-owner-launch` requires the explicit marked localhost-only target and a fresh private job-directory descriptor file; it refuses remote/unmarked targets, inherited database URLs/PG overrides, provider/payment/communication/execution environment values and unsafe files. `pnpm db:test-owner-launch` loads credentials only through the verified mode-0600, non-symlink, descriptor-bound loader. All non-local networking is disabled and external call count must remain zero.

The same proof now exercises both separate commands plus the selector-free confirmation: two-school independent registrations; receipt-to-current-profile/person links; fixed five-row newest-first output; adult/child display-name redaction; child ages and eighteenth birthdays; conservative identity denial and one-pair contracts; expected-version changes/historical replay/concurrent replay/duplicate races; staff/family/HQ/principal/source/delegation/action/tier/revocation denial; actual IAM revocation and entitlement/grant expiry **after observed lock waits**; forced RLS and raw ACL/function denial; canonical drift probes; composite graph failures; immutable evidence; audit and inert-fact failure rollback; whole-HON-table snapshots and zero extra effects. Focused API/UI/domain tests retain adult closure and cover the fixed GET, no-selector transport, bounded output, redaction and truthful unavailable labels.

```bash
# In a scrubbed shell, with no provider/execution/database overrides:
HON_OWNER_LAUNCH_VALIDATION_TARGET=postgresql://localhost:5432/hon_owner_launch_validation \
HON_OWNER_LAUNCH_ENV_FILE=/home/ubuntu/jobs/<job>/owner-launch.env \
pnpm db:setup-owner-launch
# Do not source credentials for this proof; its loader verifies the descriptor.
HON_OWNER_LAUNCH_ENV_FILE=/home/ubuntu/jobs/<job>/owner-launch.env pnpm db:test-owner-launch
```

Generated credentials are never committed or displayed. Parent Journey/Billing regression proofs, `pnpm test`, `pnpm check`, `pnpm build`, `pnpm db:check`, marked-local `pnpm db:verify-rls` and `git diff --check` remain the checkpoint validation boundary. Local tests are not production readiness; the parent agent records final actual validation evidence in TODO.
