# Migration Center: human-reviewed CSV lead import

This is a lead-only production slice, **not a final whole-school migration**. The conventional UI is `/staff/migration/leads`; its same-origin API is `/api/v1/staff/migration/leads` (Nest `/v1/staff/migration/leads`). No provider, external storage, AI/LLM matching or Action Engine tool is used.

## Scope and authority

Exact sensitive staff-assignable permissions are `migration.lead_import.upload`, `.read`, `.review`, and `.finalize`. Canonical OWNER provisioning already selects the permission directory; existing OWNER roles receive these four explicitly, without seeding principal grants. The human-only command registry starts at Essential. Mutations require a currently active entitlement of any tier, live active human identity, active school/organization, and post-lock unrevoked/unexpired authority. Finalization additionally requires live `.review`. Revocation is checked **before replay**.

The server resolves exactly one authorized school from the verified session subject and permission. No organization, school, actor, automation, integration, delegation, or action request parameter is accepted. Ambiguous multi-school permission scope fails closed; a trusted active-school session design is deferred. Only a scoped non-terminal CRM stage is selectable. Trusted `HON_PUBLIC_ORIGIN`, JSON, `X-HON-Human-Command: lead-import`, and non-cross-site browser requests protect every POST, including private row reads. Headers are a CSRF boundary, not proof of human presence independent of the authenticated session.

## Source and mapping

Pinned local `csv-parse@6.1.0` enforces strict quoting/column count, comma delimiter, CRLF/LF, UTF-8 BOM support, 16 KiB record size, 256 KiB source, 1–1,000 data rows, and at most 16 headers. Blank/repeated/formula/control headers, invalid Unicode, unknown/repeated/missing mappings, and structural CSV failures reject staging. Every header maps exactly once to a closed field; there is no implicit ignored column or heuristic inference. File input decodes locally with fatal UTF-8 and sends the exact text as bounded JSON. Source SHA-256 is computed on original UTF-8 text, including BOM; the file is not externally stored.

| Mapped field | Existing destination and rule |
| --- | --- |
| givenName, familyName | `people.given_name/family_name`, both required together, 200 chars each |
| displayName | Display-only fallback is stored unsplit as given name with empty family name; original display name also retained in lead JSON attribution |
| email | Trimmed, lowercase exact match; conservative address syntax, 254 chars |
| mobile | International E.164 required; removes only spaces, parentheses and hyphens; no country guessing |
| source | `crm_leads.source_code`, original trimmed source, 200 chars |
| note | `crm_leads.attribution.note`, 2,000 chars; not a CRM activity or communication |
| campaign, medium, sourceDetail | Existing lead attribution JSON, 200 chars each |

All mapped cells are independently SQL-validated from the private raw row, not a caller-provided validity flag. Formula-leading `=`, `@`, `-`, `+`, controls and invisible/bidi characters are invalid. The sole plus-prefix exception is a numeric international mobile; it still must pass E.164. Quoted CSV newline is parsed correctly but rejected as a control-containing cell, never executed. Invalid rows and their field/error codes are retained; they cannot produce leads. The authenticated server CSV parser is the source-to-row structural boundary; the fixed DB function recomputes checksum and validates raw mapped values, scopes and selections.

## Private evidence and review

`lead_import_batches`, `lead_import_rows`, `lead_import_evidence`, and `lead_import_requests` have **forced deny-all RLS**, no policies and no runtime/client table grants. Only three fixed runtime functions are granted: scope resolver, mutation command, and bounded read projection. Internal validator, applier, summary and trigger helpers have no runtime EXECUTE. Raw rows, logical data row index (1-based, header excluded), exact headers/mapping, normalized values, errors, suggestion snapshot, choices and applied lead reference remain private. Original source bytes are represented by SHA-256 rather than retaining a second whole-file PII blob.

LIST/BATCH/OPTIONS are redacted metadata and scoped stage labels; no filename, headers, contact or raw source values. Explicit version/idempotency-controlled POST review opens a reviewer-owned **15-minute token**, returning no row PII until the fixed POST review/rows is called. That function rechecks the scoped human, live `.review`, actor ownership, token, expiry and REVIEW status. Tokens/rows are never URLs, shared idempotency responses, audit payloads or browser local storage. The page renders escaped text only. All responses are private/no-store and no-referrer. Opening review is audited; source/evidence columns reject mutation and deletion, and decision/APPLIED evidence is append-only.

Preview suggestions use exact lowercase trimmed email and normalized E.164 phone against existing school leads (all lifecycle statuses) and other source rows. They record IDs/reasons only, without altering any existing record. Suggestions are a snapshot at review-open, not a uniqueness guarantee; unrelated concurrent CRM creation may add another match. Renewing review refreshes suggestions and invalidates its prior token. There is no auto merge, mark, or skip.

## State and failure semantics

STAGED → REVIEW → FINALIZED. Each open/decision/finalize advances batch version. Every staged row requires explicit IMPORT/SKIP (invalid rows SKIP only). Finalize repeats the exact saved selected indices, expected version and active token. Empty selection is allowed only when every row was explicitly skipped. Internal applier inserts a **new** person and OPEN lead; OPEN is the existing schema lifecycle, not a new invented status. It preserves source and attribution plus `attribution.migration.batchId/rowIndex/sourceChecksum`.

Up to 1,000 rows are applied **all-or-nothing** in one transaction. Batch-row unique keys and applied lead IDs prevent a second apply. Batch/evidence, people/leads, redacted audit, inert outbox and private replay receipts commit together. Any unexpected error rolls them all back, preserving the prior REVIEW state and original request retryability; there is no partially completed or ambiguous final batch. Versions serialize racing reviewers. Organization/school then principal/grant/role locks follow IAM lock ordering, with fresh clock checks after waits. Idempotency is permanent private storage, fingerprinted over operation/batch/input; a different request with the same key conflicts. Identical requests return historical redacted receipts after live authority checks. An uncertain HTTP result is not success; refresh metadata or retry unchanged with the original key.

Exactly one audit + outbox pair is appended per successful batch command, plus one pair per applied new lead. Events are `migration.lead_import.*` with `internalOnly: true`, **not `crm.lead.created`**, preventing automatic operational consumers. Payloads contain IDs, operation, version and row index only. No shared idempotency response, membership, payment, invoice, billing account, consent, message, CRM activity, AI usage/plan, work item or Action Engine effect is created. No import/export/raw evidence endpoint exists outside active review.

## Validation and provisioning

Run `pnpm check`, `pnpm test`, `pnpm build`, `pnpm db:check`, `pnpm db:verify-rls`, and `pnpm db:test-lead-import` with protected admin/runtime database URLs. The additive migration and canonical Supabase setup grant only the three fixed functions; both verifiers track forced RLS, exact ACL and private helper denial. Tests use uniquely named synthetic tenant fixtures and privileged cleanup, never customer data. Broader migrations, corrections after finalization, retention/purge policy, multi-school active sessions, exports and provider adapters remain future reviewed work.

The implementation comprises additive migrations **0067–0069**: private storage/domain functions, review replay/20-suggestion hardening, and composite lead/application evidence keys. At most **20 ordered suggestions per row** are returned; the list is intentionally a bounded suggestion sample, not a complete duplicate report. Statement and lock waits are bounded to 30 seconds / 5 seconds; timeout never implies success. The integration suite also exercises the full 1,000-row atomic application cap, reviewer-token renewal/expiry, conflicting-version races, destination-stage drift, direct SQL source/principal denial, composite evidence integrity and canonical new-school OWNER provisioning.
