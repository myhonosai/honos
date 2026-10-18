# Human CRM lead registration foundation

**Status:** Implemented and validated direct-human foundation. This is a narrow person/family/student registration boundary, not an enrollment or commercial workflow.

## Route and command path

```text
Selected authorized CRM lead row
  → /staff/crm/register?leadId=<untrusted UUID only>
  → server-authorized current reporting-school resolver / choice
  → POST /organizations/:organizationId/schools/:schoolId/crm/leads/:leadId/register
  → strict direct-human Fetch Metadata / same-origin JSON guard
  → fixed SECURITY DEFINER command
  → immutable conversion evidence + audit + inert outbox
```

`leadId` is an opaque, untrusted prefill. The destination does not load a lead, contact, trial, permission, history, source attribution, or command from the URL. It remains idle until a human selects a path, supplies the bounded path-specific facts, checks the confirmation, and submits. The API independently resolves the verified principal and exact school from the signed identity and live database scope; route selectors do not confer authority.

## Authorization and security

The command requires a current ordinary `HUMAN_USER` in `HUMAN_UI` source, with no Action Engine request or delegation. It rejects non-human, family, HQ, platform, system, mixed-plane, inactive, revoked, expired, out-of-scope, or entitlement-invalid contexts. It requires `crm.lead.read`, the new sensitive `crm.lead.register`, and `student.profile.manage`; the guardian-child path additionally requires `people.create`, `family.create`, and `family.member.manage`.

The browser command requires the configured same origin, JSON, `X-HON-Human-Command: crm-lead-register`, `Sec-Fetch-Site: same-origin`, `Sec-Fetch-Mode: same-origin`, `Sec-Fetch-Dest: empty`, no user-navigation marker, no unexpected `X-HON-*` header, and a UUID idempotency key. The database command rechecks live authorization after locks and immediately before return.

Migration `0153_crm_lead_registration.sql` adds forced-RLS immutable `crm_lead_registration_conversions` evidence. Runtime has no table access; it receives only the narrowly granted fixed resolver and command functions. Registered results atomically persist the person/family/student change, immutable conversion record, audit event, and inert `crm.lead.registration_recorded` outbox event.

## Path semantics

| Path | Bounded effect | Ambiguity response |
| --- | --- | --- |
| `ADULT` | Uses only the exact existing lead primary contact and creates one student profile with the submitted bounded birth date. | Existing student profile, any family relationship, prior registration conversion, invalid/revoked scope, or unavailable source returns `NEEDS_STAFF_REVIEW`/a closed denial with no match IDs. |
| `GUARDIAN_CHILD` | Preserves the lead contact as `GUARDIAN`; creates a distinct child person, child student profile, new family, and explicit `GUARDIAN`/`STUDENT` memberships atomically. | Any guardian family relationship, prior conversion, possible child-name/birth match, or unavailable source returns `NEEDS_STAFF_REVIEW` with no match IDs and no writes. |

A source lead must be `WON` **or** have one `TRIAL` appointment with status `COMPLETED` to open this bounded human review. That gate is not identity proof, eligibility, consent, student status, guardian authority, payer responsibility, enrollment, membership, agreement, payment, or conversion fact. The command never updates/deletes CRM leads, attribution, trial appointments, or their history.

## Closed result and exclusions

The only response-backed success is `REGISTERED`, with source lead/contact identity, selected path, resulting student-profile ID, nullable family ID, and timestamp. The only ambiguity result is `{ "outcome": "NEEDS_STAFF_REVIEW" }`; it intentionally contains no unrelated IDs or match details.

This foundation creates **no** curriculum enrollment, membership, billing account, invoice, payment, consent, booking, attendance, testing, communication, notification, provider action, AI work, Action Engine request, automation, deployment, directory/search capability, merge, relationship linking, or contact correction. After a response has passed the closed `REGISTERED` receipt verifier, it may display two ordinary same-origin preparation links: one carries only the resulting `studentProfileId` UUID to the separate human curriculum-enrollment form; the other carries only the original `sourceContactPersonId` UUID to the separate human billing-account form. Both are untrusted form/reference text only: neither carries scope or another receipt field, loads nothing at the registration page, executes nothing, selects a payer, or creates financial work. Existing-record linking, multi-child convenience, and corrective actions require separate authorized/audited contracts.

## Validation

Use only the marked disposable local database commands and a fresh `/home/ubuntu/jobs/...` environment file:

```bash
HON_CRM_LEAD_REGISTRATION_VALIDATION_TARGET=postgresql://localhost:5432/hon_crm_registration_validation \
HON_CRM_LEAD_REGISTRATION_ENV_FILE=/home/ubuntu/jobs/<job>/crm-registration.env \
pnpm db:setup-crm-lead-registration
set -a; source /home/ubuntu/jobs/<job>/crm-registration.env; set +a
pnpm db:test-crm-lead-registration
```

The proof rejects remote/provider credentials, validates restricted-runtime ACL/RLS posture, direct-human scope, adult and guardian-child atomicity and identity separation, replay, ambiguity no-write behavior, rollback atomicity, attribution preservation, and absence of durable membership, billing, payment, messaging, Action Engine, automation, work, attendance, or AI effects. It leaves no fixture organization behind and restores the canonical immutable conversion triggers before commit.

Focused validation also runs the actual Nest global `ValidationPipe` against the decorated closed DTO, proving both valid paths reach the controller while unrecognized payload fields cannot. The dynamic noindex staff route and its opaque URL selector were checked as inert during server render; the route remains protected by the shared staff session layout and is declared in `manus-routes.json`.

The CRM-registration block in `infra/postgres/011_verify_supabase_hon_runtime.sql` verifies the exact function bodies, security-definer/volatility/search-path posture, return signatures, runtime-only execution grants, private conversion evidence ACL/RLS posture, immutable triggers, source/idempotency uniqueness and sensitive permission flag. That block passed against the fresh restricted local runtime. The full historical monolithic verifier currently stops earlier in an unrelated existing public-form provenance check for `lead_attributions_immutable`; this registration evidence does **not** claim that unrelated baseline has passed.

Final implementation validation passed the focused API coverage (3 tests), CRM/curriculum browser coverage (17 tests after the selector-only handoff), CRM/billing browser coverage (17 tests after the source-contact candidate handoff), `pnpm db:check`, root `pnpm test` (403 tests), root `pnpm check`, root `pnpm build`, and `git diff --check`. Each new link has an exact one-key URL assertion; the curriculum target verifies no automatic I/O/key allocation or scope/curriculum/rank prefill, while the billing target verifies no payer selection, lookup, command or key allocation from the candidate. No remote database, provider, payment, deployment, shared visual source, or asset was used.
