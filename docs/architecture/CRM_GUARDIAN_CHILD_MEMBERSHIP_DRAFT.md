# Guardian-child CRM registration to membership DRAFT

**Status:** Delivered and locally validated on the isolated CRM enrollment branch. This is the separate conventional staff path for an immutable `GUARDIAN_CHILD` CRM registration. It does not broaden the adult workflow or infer a payer from a lead, trial, registration receipt, family access, a name match, an arbitrary family member, a billing account, or `is_billing_contact` alone. It does not authorize payment collection, agreement/consent, schedules, invoices, provider calls, communication, AI, automation, activation, deployment, existing-record linking, multi-child convenience, or correction/supersession.

## Intent and bounded lifecycle

```text
verified REGISTERED GUARDIAN_CHILD conversion
  → explicit source-guardian payer designation
  → separate canonical billing-account review/create-or-reuse when necessary
  → source-bound child Membership DRAFT
  → separate source-bound current-DRAFT confirmation
  → existing separate human activation review
```

Every arrow is a fresh direct-human boundary. A same-origin URL may carry only an opaque untrusted `studentProfileId`; it cannot prove relationship, payer responsibility, account, scope, authority, receipt state, or command eligibility, and it performs no I/O or command by itself.

## Initial payer-designation policy

The first safe scope is intentionally limited to the exact original lead contact from one immutable `REGISTERED` `GUARDIAN_CHILD` conversion. That person is the only source guardian who may be designated by this workflow. There is no guardian directory, family-member picker, arbitrary payer selector, account picker, name search, existing-person linking, or co-guardian choice.

The server must derive and revalidate, under transaction-local organization/school context and forced RLS:

1. exactly one current-school `crm_lead_registration_conversions` row for the selected child with `registration_path = GUARDIAN_CHILD`, response `outcome = REGISTERED`, non-null family, original source contact, and matching child receipt facts;
2. one active child student profile whose person differs from the original guardian, whose primary family is the conversion family, and whose profile/person facts match the conversion;
3. one active conversion family containing the original source contact exactly as a `GUARDIAN` and the child person exactly as a `STUDENT`;
4. no competing current `GUARDIAN` `is_billing_contact` projection in that family;
5. exactly one current-school `CANONICAL` billing account for the derived original guardian, with a valid currency. Additional accounts may exist but are never selected; absence of a canonical account is unavailable and does not create one.

The direct-human staff member attests that the school’s own operational relationship and responsible-payer review was completed. This is an HON operational designation, not proof of legal guardianship, consent, payment authorization, identity-document verification, or a chargeable agreement. No free-text evidence, documents, credentials, images, document numbers, or customer communications are captured in this slice.

## Designation command and provenance

A dedicated route/function pair requires a current sole ordinary `HUMAN_USER` from `HUMAN_UI`, same origin, JSON, same-origin Fetch Metadata, a closed human-command marker, an exact confirmation literal, current active organization/school/entitlement, and both `billing.membership.create` and `family.member.manage`. It rejects family, HQ, AI, Action Engine, automation, integration, delegation, mixed roles, stale/revoked scope, and unexpected authority headers.

The only browser command input is the selected `studentProfileId` plus direct-human confirmation. Guardian, person, family, conversion, account, currency, plan, price, provider, schedule, payment, agreement, and authority data are never browser inputs.

The command locks/rechecks the source graph and canonical account, then atomically records one private forced-RLS immutable payer-designation provenance row, one ordinary audit event, one inert `billing.guardian_payer.designated` outbox event, and the idempotency result. The immutable source is unique per conversion and captures the derived guardian, child, family, canonical account, acting principal, key, fingerprint, closed receipt, and time. A same key with the identical closed input replays only its stored historical receipt; changed input conflicts; a distinct actor/key cannot consume the same source. The receipt contains only bounded child/guardian display labels, canonical currency, `PAYER_DESIGNATED`, and the canonical recorded time—no identifiers, account details, source history, payment facts, or verification material.

Within this narrow fresh-family scope only, the same transaction may set the exact source guardian family-member row’s `is_billing_contact` projection to `true`, after proving that no competing guardian projection exists. Immutable payer-designation provenance, not this mutable Boolean, remains the authority source. Any later graph/account/projection drift fails the subsequent child-DRAFT/current-confirmation proof closed; no operation silently chooses a replacement guardian, payer, or account.

If a matching canonical account is missing, staff must separately use the existing direct-human billing-account workbench. That workbench alone decides whether an existing canonical account is reused or one canonical account is created under its own audit/idempotency boundary. The designation and child-DRAFT functions never create, update, merge, reassign, reclassify, or otherwise mutate billing accounts.

## Child DRAFT and database enforcement

A distinct guardian-child source-bound DRAFT function reuses the existing `hon.memberships` model only after it rederives the immutable payer designation, child/family/guardian relation, and the same frozen current `CANONICAL` account. Its closed input is `studentProfileId`, bounded plan code, optional canonical UTC-millisecond terms, exact direct-human confirmation, and a UUID idempotency key. It never accepts participant, guardian, payer, family, conversion, account, schedule, amount, currency, agreement, provider, or authorization fields.

The function creates only one `DRAFT` membership, a separate private immutable designation-to-membership source row, idempotency result, ordinary audit evidence, and inert `billing.membership.drafted` outbox evidence. It creates no payment schedule, invoice, payment attempt/method/authorization, provider effect, account, person, family, family-member, curriculum, attendance, communication, AI/Action Engine work, automation, activation, or external effect. The source row is inserted before the membership under a deferred composite foreign key so a narrowly scoped database trigger can reject a generic membership insert for a child originating from a `GUARDIAN_CHILD` CRM conversion unless the private source-bound provenance exists. The generic membership API gains no guardian shortcut and remains unsuitable for this path.

A separate lock-backed current-DRAFT confirmation is creator-owned for the child-DRAFT actor. It returns the exact closed `RECORDED_DRAFT` receipt only while the source designation, original child/guardian/family relation, canonical account, version-one `DRAFT` membership, plan/terms/time receipt, and no-schedule/no-invoice condition all still match. It writes no audit, outbox, idempotency, provider, or financial record and never falls back to a generic membership.

## User-interface and handoff rules

New isolated staff workbenches may show only response-backed child/guardian labels and currency following explicit preparation. They begin idle; use memory-only preparation, confirmation, receipt, and uncertain-command retry state; allocate an idempotency key only on explicit DRAFT confirmation; and clear derived state on any relevant input/scope/access/focus/visibility/unmount change. They do not list/search guardians, accounts, families, or memberships.

A verified `REGISTERED` `GUARDIAN_CHILD` CRM registration receipt may link to the designation workbench with only `studentProfileId`. A verified payer-designation receipt may link to the child-DRAFT workbench with only `studentProfileId`. A current source-bound child-DRAFT confirmation, and only that confirmation, may link to the existing activation workbench with only `membershipId`. All destinations remain inert until their own current human/school/permission/preparation/confirmation controls are used.

## Deferred policy decisions

This initial contract deliberately does not decide co-guardian choice, existing-record/family linking, multi-child payer convenience, correction/supersession/revocation of a payer designation, legal identity/guardianship evidence retention, payment authorization, agreement meaning, schedule/invoice rules, or financial responsibility transfer. Those require separate reviewed policy and data contracts; no code in this slice may infer or simulate them.

## Validation evidence

Migrations `0164`–`0167` provide the payer-designation provenance, private designation-to-membership source, generic child-membership insert guard, and fresh conversion-time child source facts. `0167` does not backfill mutable data: a guardian-child conversion created before its capture trigger has no eligible source facts and fails closed. Current child person/profile name and birth-date facts must equal the immutable conversion-time snapshot before payer designation, DRAFT creation, or current confirmation.

Validation passed with 167 PostgreSQL migrations: focused contracts/API tests (3), focused guardian registration/designation/DRAFT browser tests (6 files / 21 tests), `pnpm db:check`, the dedicated guarded restricted-runtime proof (440 assertion groups; 778 all-table snapshots across 247 tables), the full guarded dispatcher (18 disposable proofs across 6 fixtures; forced RLS on 243 tracked tables), root `pnpm test` (443 tests), `pnpm check`, `pnpm build`, and `git diff --check`. The proof covers fresh source capture, historical no-backfill denial, pre-designation child name/person/birth-date drift, canonical-account reuse with additional accounts present, absent-account/foreign/revoked/mixed-context rejection, replay/race behavior, immutable sources, generic child insert refusal, current-DRAFT drift, ACL/RLS/signature/hash/trigger/constraint drift, and no external transport calls. No remote database, provider, payment, customer communication, deployment, shared visual component, portrait, or Claude experimental asset was changed.
