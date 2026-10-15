# Public lead-form intake

## Scope

This slice adds **human-configured public enquiry intake**, not a website builder, advertising publisher, appointment scheduler, consent collector or automation tool. It follows the human campaign/immutable attribution foundation (`c8e8b68`) without changing the Lead Import, Action Engine, provider, payment or AI execution boundaries.

- Staff UI: `/staff/marketing/forms`.
- Public UI: `/forms/:publicId` (an opaque 192-bit random identifier, not a tenant or CRM identifier).
- Staff API: `GET /v1/marketing/forms`, `POST /v1/marketing/forms`, and `POST /v1/marketing/forms/:formId/{configuration,publish,disable}`.
- Public API: `GET /v1/public/forms/:publicId` and `POST /v1/public/forms/:publicId/submissions`.

The browser uses the existing same-origin `/api/v1` rewrite. No client database credentials, anonymous Supabase execution grants, provider adapters or external hosting deployment are added.

## Human configuration and lifecycle

Verified external identity must resolve to **one exact live authorized school**. The request cannot supply an actor, tenant, school, delegated principal or Action Request. Each command requires its own `marketing.form.read`, `.configure`, `.publish` or `.disable` permission. Family and HQ authority alone do not confer staff form permission. Essential, Core and Complete must have an active entitlement, organization and school.

Configuration is a closed schema: expected version, a 1–120-character title, 0–500-character description, existing current-school pipeline and non-terminal stage, optional active current-school campaign ID, and a unique subset of `ageBand`, `experience`, `preferredTime`. Optional answers are vetted choice codes, not arbitrary medical, family or custom free-text fields. Attaching a campaign and publishing a campaign-linked form also require `marketing.campaign.attribute`.

A form begins at `DRAFT` v1. Publication increments the version; a published form must be disabled before configuration changes. Disable and later publication preserve its opaque public identifier. Versions, scope, identity, hash secret, creation timestamp and immutable history are guarded in SQL. A form's deferred current-version constraint requires coherent immutable version evidence at commit.

Commands are serialized under ordered organization → school → form / authorization locks. Live principal, role, grant, entitlement and permission checks run again after waiting. Actor-scoped retry fingerprints bind operation, form ID and exact input. Changed input under the same key conflicts; revoked authority cannot replay a prior successful staff command.

**A command receipt is historical.** Staff UI never installs a mutation/replay response as editable current form state. It clears selected forms/counts and refreshes the authorized list; if that read fails or denies permission, the old snapshot stays hidden and further lifecycle controls are disabled. An uncertain command retains its exact body/key behind an explicit unchanged-retry control. Request paths/methods are allowlisted, redirects are rejected, reads have a ten-second deadline and bounded UTF-8 response bytes, and success envelopes and form schemas are checked before rendering. No PII or retry state is written to browser persistent storage.

## Public transport and results

Public middleware runs before the ordinary JSON parser. It catches case-insensitive Express route variants but permits only canonical lower-case fixed public paths. Query parameters, body-bearing GETs, trailing command paths and non-POST submission methods are rejected. Public POSTs require uncompressed `application/json`, optional UTF-8 charset, valid UTF-8, an object JSON body with no duplicate decoded keys, and **1–8,192 bytes**. The retry header is 16–100 ASCII letters/digits/underscore/hyphen. A fixed-memory per-process POST budget is a first-line bound, not an IP-based security claim.

Closed submission fields:

| Field | Rule |
| --- | --- |
| `name` | Required nonempty normalized string, at most 120 characters |
| `email` | Optional valid bounded email, at most 254 characters; normalized lower-case |
| `mobile` | Optional international `+` number, 7–15 digits following a nonzero first digit |
| `interest`, `source` | Optional single-line strings, at most 80 characters each |
| `website` | Required empty honeypot |
| `acknowledged` | Required boolean fact, not communication permission |
| Vetted optional answers | Only configured fields and their fixed choice codes |

At least one email/mobile is required. Unknown fields, authority selectors, nested values, control/bidi/zero-width characters, newline and spreadsheet-formula prefixes are rejected. React renders presentation text as escaped text, not HTML. Parameterized SQL does not interpret quotes or SQL-looking text as executable instructions.

Both HTTP/service and SQL validate input. SQL derives the organization, school, pipeline, stage, optional schema, campaign and actor solely from the live published form. Unknown, draft, disabled, inactive tenant/entitlement, paused/archived campaign and terminal-stage forms do not intake, including retries of formerly successful submissions. Public GET returns only title, description, optional field names and public ID. No internal scope, campaign, counts, hash, receipt or contact state is exposed.

POST returns exactly one generic result, never a lead/contact identifier or raw PostgreSQL detail:

| HTTP | Body | Meaning |
| --- | --- | --- |
| 202 | `{"result":"accepted"}` | Atomic intake or bounded exact replay accepted |
| 400 | `{"result":"invalid"}` | Invalid input or unavailable/inactive form; no reason disclosed |
| 429 | `{"result":"rate-limited"}` | Retry later; bounded ingress/contact/form limits reached |
| 503 | `{"result":"unavailable"}` | Outcome uncertain; retry unchanged |

Public GET unknown/inactive response is the same generic 404 `{"result":"invalid"}`. All public responses use `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. Browser submits omit credentials and only recognize exact status/result pairs, retaining unchanged retry bodies/keys when acceptance is uncertain.

## Fixed SQL ingress and immutable CRM provenance

Five public-form private tables are trusted-owner-only, **ENABLE + FORCE RLS with no policies**: forms, versions, staff command requests, public receipts and hourly rates. Runtime, PUBLIC and Supabase client roles have no direct table/column permissions. Public HTTP calls only the fixed parameterized `hon.read_published_form(text)` or transactional `hon.submit_public_form(text,jsonb,text)` boundary, using the existing non-superuser/non-bypass runtime pool. It does not grant PUBLIC EXECUTE or allow a client to choose SQL/functions.

The other three runtime form entry points are the exact human scope resolver, staff read and staff mutation. Validators, actor/lock helpers, staff summary, rate helper, private CRM creation and trigger functions are not runtime-callable. Definers have a fixed `pg_catalog, hon` search path and a trusted migration owner. A fixed `SYSTEM_SERVICE` principal (`00000000-0000-4000-8000-000000000075`) has no user, role, HQ or family grants. It is not a general integration/service identity and is rejected if this posture drifts.

A fresh transaction-bound private receipt reserves the exact new lead and attribution before `hon.create_public_form_lead` can insert an ordinary new person and CRM lead. The attribution trigger requires the current transaction's receipt, matching tenant/form version/pipeline/campaign facts and code-owned service context. Caller-set GUCs alone cannot manufacture provenance; runtime has neither helper execution nor receipt writes. CRM source/form/campaign snapshots are immutable and never rewritten after campaign/form changes.

The receipt stores keyed hashes of retry key and normalized payload, plus necessary attribution; never raw names, email/mobile, plaintext retry keys or raw submitted bodies. Receipt aliases do not inflate `acceptedCount`. Exact normalized enquiries deduplicate across keys for 24 hours; expired records are removed on next intake for that form. Different enquiries with an existing matching contact always create independent new people/leads—**no merge or contact lookup**.

Persistent limits serialize under the form row lock: 500 valid-form attempts/hour, 200 new accepts/hour, and five new enquiries/hour for each email and mobile identity separately. Rotating the other identity does not evade a contact limit. Hour-old contact buckets are removed on intake. These are abuse bounds, not proof that a submitter is a human or controls a contact address; infrastructure/DDoS controls remain a rollout prerequisite.

Person, lead, attribution, receipt, count, redacted audit and **inert internal-only** `marketing.form.lead_received` outbox append commit atomically. Failed audit/outbox insertion rolls back all effects. This event is not a communication message/delivery command. Human lifecycle events are also redacted/internal-only. There is no raw submission/receipt API.

## Consent and no-effect caveat

> **Saving an enquiry and recording an acknowledgement does not establish lawful consent to send marketing—or any other communication.** A contact address is not proof of ownership, age/guardian authority or communication permission. `acknowledged: true` is only an immutable source fact; `false` is accepted as a fact too. Neither value creates or changes `communication_consents`, including `OPTED_IN`.

Form submission and staff configuration do **not** create communication message queues, deliveries, appointments/trials/class bookings, students/memberships, billing accounts/invoices/payment schedules/attempts, work items, AI ledger/plans/provider calls, Action Requests/Approvals, ad/social/email/SMS publication or spending. Necessary redacted audit/outbox events are evidence only. Existing CRM/communication workflows must separately verify current permission, lawful purpose and consent through their own reviewed boundaries.

Before production rollout, the operator must separately review notice/legal basis, retention/deletion policy for CRM PII and attribution, contact verification/minor/guardian requirements, abuse infrastructure and monitoring, and explicit configured `HON_PUBLIC_ORIGIN` for human UI commands. Schema and UI availability are not approval to activate providers or publish externally. No production/remote database or hosting deployment is performed by this slice.

## Files and validation

Contracts: `packages/contracts/src/public-lead-forms.ts`; API: `apps/api/src/marketing/public-form*`; UI/transport: `apps/web/src/components/{public-form-client,public-form-workbench,published-lead-form}`. Migrations `0075`–`0076` add private forms/provenance and coherent identity/version guards. Canonical `infra/postgres/010_supabase_hon_runtime.sql` reconciles exact grants; `011_verify_supabase_hon_runtime.sql` and `packages/database/scripts/verify-rls.mjs` verify private ACLs, forced RLS, definer posture/search paths, denied directory/HQ access and enabled immutable provenance guards.

`pnpm db:test-public-forms` runs guarded local integration and dual-verifier drift/behavioral RLS tests. It requires `HON_CAMPAIGN_VALIDATION_TARGET=postgresql://localhost:5432/hon_campaign_validation` plus exact localhost:5432 `/hon_campaign_validation` migration/runtime aliases; credentials must be sourced only in a test subshell, never logged or committed. Tests deliberately deny thirteen ACL/RLS/path/trigger drifts in both fresh canonical alias and JS verifiers, restore every probe, then prove forced deny-all RLS against temporary non-bypass table owners. Local peer admin is used for rollback-only ownership proofs, not to elevate the runtime or disposable migration owner.

API tests use actual loopback HTTP (with production middleware ordering) and unit-fixed-boundary tests. Web tests exercise transport limits/allowlists, actual component event/hook state, replay/list-refresh failure, revoked permission, unchanged retries, escaped content, optional choices, generic inactive forms and route-change clearing. No package installation or remote services are needed.

**Final checkpoint:** a fresh reset through all 76 migrations/canonical 010, `db:migrate`, `db:verify-rls`, `db:test-public-forms`, affected `db:test-marketing-campaigns` and `db:test-lead-import`, plus clean URL-unset root `check`, `test`, `db:check` and `build` are required before completing TODO or committing. No pg single-client parallel-query deprecation warning is permitted; only separate pooled command transactions are raced.
