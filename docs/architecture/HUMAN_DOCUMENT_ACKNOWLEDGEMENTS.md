# Human Document Templates, Publication and Internal Acknowledgements

## Scope and explicit non-goals

This is a **tenant-scoped internal document and human acknowledgement foundation**, not a legal e-signature-provider integration. It makes **no ESIGN/UETA compliance claim**, does not legally verify signatures or identities, and does not capture raw signature images. A normalized verified HON human session authenticates an application principal; it is not legal signer-identity proof or proof of physical human presence. The browser command marker is CSRF defense, not legal evidence of identity.

There are **no external provider/network calls**, SDKs, credentials, signature envelopes, provider signing/verification, payments, Billing agreement activation, automatic communication delivery, AI/Action Engine execution, automation/integration execution, or document-event consumers in this slice. Internal outbox metadata does not authorize any such effect. A document acknowledgement alone changes none of those domains.

**Deferred decision:** legal/compliance requirements and whether to use a reviewed external e-signature provider require separate product, legal, privacy/security, retention and provider due diligence. Do not promote this evidence model as legally compliant signing, a waiver enforcement decision, notarization, consent to financial charges, or a legal-signature verification product. Future work must independently address jurisdiction, signer capacity/minors/guardian authority, disclosure/consent and intent, identity assurance, tamper evidence/retention/export, revocation/reconciliation, accessibility and provider custody. None is silently enabled here.

## Supported audiences and permissions

Each template has an immutable **single-school, single-audience** scope. `STAFF` is visible to explicitly authorized staff at that school. `PARENT` targets **one active school-owned family** selected by an authorized staff author; parents never submit a family/person/signer ID. Parent visibility uses the existing `hon.resolve_parent_family_scope` resolver exclusively, with additional fresh effective-grant and active-family checks. Viewers may read; only currently authorized PRIMARY/SECONDARY guardians may acknowledge. A co-parent cannot read another signer's receipt even within the same family.

`STUDENT` is **not supported**: this repository has student profiles but no verified student-principal scope resolver. It is rejected, not inferred from a parent grant, student person ID, family relationship or staff role. Broader distribution, multiple-family audience expansion, cross-school templates and student signing need a separately reviewed scope boundary.

| Permission / command | Authority | Minimum tier |
| --- | --- | --- |
| `document.template.create` | Sensitive explicit staff permission; create template and immutable content version 1 | Essential (all tiers) |
| `document.template.version` | Sensitive explicit staff permission; append new immutable bytes | Essential (all tiers) |
| `document.publish` | Separate sensitive explicit staff permission; publish the exact latest version | Essential (all tiers) |
| `document.read` | Sensitive explicit staff permission; scoped template/version/publication reads | Essential (all tiers) |
| `document.acknowledge` | Explicit staff permission for STAFF; verified live family guardian resolver for PARENT | Essential (all tiers) |
| `document.evidence.read` | Separate sensitive staff evidence permission; parents only their own resolver-authorized receipt | Essential (all tiers) |

The closed `DOCUMENT_PERMISSION_CODES`, `DOCUMENT_ACTION_CODES` and `DOCUMENT_COMMAND_REGISTRY` encode this boundary. Baseline conventional access is available across all tiers, not a paid/provider execution entitlement. Commands are deliberately **absent from `ACTION_CATALOG` and Tool Gateway executors**: even Complete/AUTO Action Engine authority cannot propose or execute them. Existing canonical system OWNER roles gain these six explicit permission mappings; no mass principal grants or non-OWNER role upgrades occur. Existing staff-role administration may assign these sensitive permissions only within the actor's live permitted subset. HQ provisioning continues to create one OWNER role/grant using the current permission registry.

## Storage and publication lifecycle

Additive migrations **0062–0064** introduce:

- `document_templates`: immutable tenant/audience/family ownership, latest-content pointer, current-publication pointer and optimistic `version` token.
- `document_versions`: append-only title/content, sequential content `version_number`, author and timestamp. All bytes are immutable, including drafts; editing always inserts a new version.
- `document_publications`: append-only version/hash/audience/family snapshot, human publisher and server timestamp. Only the latest content version can be published. Publishing a new version changes only the template's current-publication pointer; old publications remain immutable history.
- `document_acknowledgements`: append-only publication/version/hash, signer principal, audience/derived family, server timestamp, explicit `ACKNOWLEDGE` choice, optional bounded typed attestation, canonical evidence JSON/hash and request/correlation IDs.
- `document_command_requests`: private document-domain idempotency namespace, scoped by organization/school/principal/key. Full content and evidence responses **never remain in the shared tenant-wide operational idempotency table**. 0063 moves any earlier document responses into this deny-all private store before removing them from shared storage.

All five tables have **enabled and forced deny-all RLS with no client/runtime policies or direct grants**. There are no generic table/client mutation APIs. Composite keys/FKs enforce school/organization/template/version/publication/hash ownership; immutable triggers reject UPDATE/DELETE of content, publication and acknowledgement, and prevent template scope changes. Privileged migration/test-fixture cleanup can intentionally disable triggers; this is not an end-user erase API or a claim of protection against database administrators.

`contentHash` is SHA-256 of the exact UTF-8 bytes of **`title + "\n" + content`**. Titles cannot contain control characters/newlines, so the separator is unambiguous. Plain-text content is 1–100,000 characters (newlines/tabs allowed; unsafe controls prohibited); title is 1–200. No HTML interpretation occurs in the UI. `evidenceHash` is SHA-256 of PostgreSQL's canonical `jsonb::text` UTF-8 representation of the stored evidence, excluding the hash itself. It is internal consistency/tamper-detection metadata, **not a cryptographic legal signature, external timestamp certificate or public verification service**. Server evidence records schema/kind, IDs, exact content hash, signer, choice/attestation, human source and time, request/correlation. Attestation is optional but, if present, 1–500 nonblank characters without controls. Client timestamps and signature image/person/family/principal fields are rejected.

Creating/appending a content version does **not** publish it and does not hide the existing current publication. Both version append and publish advance the template concurrency token; stale `expectedVersion` fails without effect. Republishing the same version and publishing an older version fail. A new version needs a deliberate publisher command; no automatic publication occurs.

## Human command and replay boundary

`HonIdentityGuard` supplies the verified subject. Controllers derive staff scope from the exact permission or parent scope from the existing verified family resolver; parent routes accept no organization/family/person/signer input and have no staff fallback. HUMAN_USER/HUMAN_UI-only service and fixed SQL gates reject action requests, delegation, AI, automation, integration and other sources.

Sensitive POSTs require a configured exact `HON_PUBLIC_ORIGIN`, same-origin JSON, `X-HON-Human-Command: document-acknowledgement`, and bounded `Idempotency-Key`. Missing trusted origin fails closed. Read/write success responses use the standard `{data, meta: {requestId, correlationId, replayed?}}` shape and `Cache-Control: private, no-store`. Closed DTO and service validation reject extra fields even outside normal HTTP validation. SQL error codes map to stable permission/not-found/validation/version/idempotency failures; no directory or hidden document content is returned on failure.

Transactions bind local tenant/principal/request context, take organization/school and actor/grant/role or family/grant locks, re-resolve live authority, and lock the exact scoped template. Locks share IAM's organization serialization boundary. Fresh clock checks after lock waits enforce revocation/expiry; cached controller resolution is never mutation authority. A parent acknowledgement's family comes **only from the immutable publication**, then is checked against the existing verified parent resolver and live guardian grant.

Acknowledgement requires the **currently published** exact publication/version/hash, correct audience and live authorized human. The pointer is checked before any replay: superseded publication acknowledgements, even an old successful key, fail. Reading the parent's own historical receipt remains possible while the family grant is authorized. Concurrent identical keys serialize to one result; key reuse for different content fails. A second identical acknowledgement with a new key returns the original evidence without another audit/outbox. A changed attestation after acknowledging fails; there is no mutable signature/evidence update endpoint.

Business row, immutable evidence, private idempotency response, audit and outbox insert commit **atomically**. Audit/outbox include only IDs/version/content hash and `internalOnly: true`, never raw content, typed attestation, contact/directory or family PII. Outbox events `document.template.created`, `document.version.created`, `document.published`, `document.acknowledged` are inert metadata; no delivery/execution consumer is activated.

## Conventional API and UI

Staff base: `/v1/organizations/:organizationId/schools/:schoolId/documents`.

| Method / suffix | Purpose |
| --- | --- |
| POST `/templates` | Create audience-scoped template + immutable version 1 |
| POST `/templates/:id/versions` | Append `{expectedVersion,title,content}` |
| POST `/templates/:id/publish` | Publish `{expectedVersion,versionId}` |
| GET `/templates/:id` | Latest immutable content plus template concurrency/publication pointers |
| GET `/versions/:id` | Historical immutable version (staff only) |
| GET `/publications` | Bounded current-publication list |
| GET `/publications/:id` | Authorized publication, including historical staff reads |
| POST `/publications/:id/acknowledgements` | Explicit choice/hash/optional typed attestation |
| GET `/acknowledgements/:id` | Separate sensitive scoped staff evidence read |

Parent base: `/v1/parent/schools/:schoolId/documents`. Only GET `/publications`, GET `/publications/:id`, POST `/publications/:id/acknowledgements` and GET `/acknowledgements/:id` exist. The projection exposes **only current PARENT content for verified families**, never drafts, STAFF/private documents, publisher/directory identities or family/signer lists. Parents may retrieve only their own receipt, never another family or co-parent's evidence. Lists default to 50 and SQL is capped at 100; broad search/export, template discovery pagination and bulk evidence are deferred.

`/staff/documents` provides explicit author/append/publish/read forms and staff acknowledgement. `/parent/documents` provides a parent-safe known-publication read then explicit checkbox/optional attestation. No mutation or fetch occurs on render. Content is rendered as escaped plain text. An uncertain identical retry reuses the same in-memory key; changed commands get a new key. Human acknowledgement controls appear only after current content is loaded. Known identifiers in these foundation interfaces are lookup inputs, never authorization.

## Deployment and validation

Apply migrations through `pnpm db:migrate` using the migration-only admin connection. The fixed functions must be owned by a trusted forced-RLS-bypassing migration role; **hon_runtime must not bypass RLS or be a superuser**. Canonical Supabase 010 setup and 011 verifier grant only `mutate_document` and `read_documents` EXECUTE, revoke PUBLIC/other-grantee access and deny internal helper/table/directory access. Existing deployments receive additive grants; do not rerun role creation or grant any document table permissions.

Run `pnpm check`, `pnpm test`, `pnpm build`, `pnpm db:check`, `pnpm db:verify-rls`, `pnpm db:test-documents`, and the existing full DB suite. Tests exercise the actual restricted runtime and a separate non-bypass probe role with temporary table privileges: direct forced RLS denies all rows/inserts even with tenant GUCs. Fixtures cover cross-school/organization/family/audience denial, author-not-publisher, unsupported STUDENT, immutable content/publications/evidence, stale/replay/concurrency, same-family private evidence, live guardian expiry after waits, source/delegation/action prohibition, closed raw-image/actor/family inputs, directory/helper denial, canonical OWNER provisioning, atomic rollback on injected outbox failure, private replay storage and **zero AI/financial/communication/provider effects**. Test-only privileged fixture cleanup re-enables guards before commit and leaves no records or probe grants behind.
