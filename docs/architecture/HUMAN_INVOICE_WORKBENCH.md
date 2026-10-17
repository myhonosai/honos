# Human invoice workbench

## Delivered boundary

`/staff/billing/invoices` is a **direct-human, exact-known-ID command workbench**, not an invoice/account/payer browser. It inherits the existing fail-closed signed-session `/staff` layout, is `force-dynamic`, carries `robots: { index: false, follow: false }`, and is declared once in `apps/web/public/manus-routes.json`.

The page starts **blank and idle**. No query prefill, persisted scope, initial lookup, list, directory, search, payer view, polling, background action or automatic retry is provided. It reuses the established staff form/receipt styling; no decorative asset or additional navigation capability is introduced.

Only the existing `InvoiceController.createDraft` / `InvoiceService.createDraft` and `InvoiceController.issue` / `InvoiceService.issue` are called. There is **no new endpoint, service, migration, model, permission, invoice lifecycle or historical issue UI**. The service, DTOs and shared contracts remain byte-identical to the starting revision.

## Exact command contracts

### Explicitly create one DRAFT

The operator supplies an already-known exact organization UUID, school UUID, billing-account UUID, optional known linked membership UUID, uppercase supported ISO 4217 currency, subtotal **0–2,147,483,647 minor units**, and a bounded **timezone-qualified ISO 8601** due timestamp (`Z` or numeric offset; at most 40 characters). Blank optional membership is omitted, not inferred. Local syntax validation rejects names, URLs, query/path additions, money fractions, signed/exponent/whitespace numeric input, unqualified dates and invalid calendar/time components. No school/account/membership facts are looked up by the browser.

After local validity and a separate create confirmation, exactly one fresh `crypto.randomUUID()` v4 idempotency key is generated and the unchanged canonical endpoint receives:

```text
POST /api/v1/organizations/{knownOrganizationId}/schools/{knownSchoolId}/billing/invoices
```

```json
{
  "billingAccountId": "<known UUID>",
  "membershipId": "<optional known linked UUID; otherwise omitted>",
  "currency": "USD",
  "subtotalMinor": 1250,
  "dueAt": "2030-05-01T09:15:30-07:00"
}
```

The body never contains total, discount, status, actor, authoritative scope, invoice ID, version, audit, outbox, delegation or source fields. Organization/school path values are **untrusted selectors**, not tenant context; the controller derives context from its existing current authorization.

The response must be a closed `{data, meta}` envelope with closed `{requestId, correlationId, replayed}` metadata, equal valid request/correlation UUIDs and boolean replay status. New create is `201` / `replayed: false`; exact replay is `200` / `replayed: true`. The entire HTTP/envelope contract must verify before draft provenance is registered.

The receipt must be the exact canonical **DRAFT**, version **1**, matching account, optional membership, currency, subtotal and due instant; discount must be **0** and total equal subtotal. Receipt timestamps must be canonical UTC millisecond strings. Any extra payer, contact, payment-method, provider, scope or other field quarantines the whole response. Only canonical minimal invoice facts are rendered: invoice/account/optional membership UUIDs, status, currency, subtotal/discount/total minor units, due/created timestamps and returned version. Metadata, personal identity and payment/provider details are not rendered.

### Separately issue only that receipt

Only a fully verified immutable **in-memory DRAFT receipt** exposes the issue confirmation and submit control. A private weak-map provenance link binds the receipt to its exact create scope/input; copied, fabricated or issued receipts cannot prepare an issue. This browser guard is not a server authorization capability.

The issue UI has **no invoice-ID, expected-version, scope or body editor**. A separate explicit issue confirmation generates a new v4 key, distinct from the create key. The route uses only that receipt's invoice UUID and the body only that receipt's version:

```text
POST /api/v1/organizations/{receiptBoundOrganizationId}/schools/{receiptBoundSchoolId}/billing/invoices/{receiptInvoiceId}/issue
```

```json
{ "expectedVersion": 1 }
```

Issue accepts only `200` with a closed canonical **ISSUED** receipt. ID, account, membership, currency, subtotal, discount, total, due and creation facts must match the verified DRAFT, and returned version must increment by exactly one. The screen shows only those returned facts, never a locally inferred ISSUED state. An issued receipt has no further issue action.

## Transport and authoritative server checks

Both operations use only one relative same-origin POST transport with `credentials: 'same-origin'`, `mode: 'same-origin'`, `cache: 'no-store'`, `redirect: 'error'`, `referrerPolicy: 'no-referrer'`, JSON accept/content type, a generated `Idempotency-Key` and `X-HON-Human-Command: billing-invoice`. Responses are limited to 4,000 characters and JSON only; raw network, SQL and problem details never appear in the UI.

The pre-existing invoice HTTP edge lacked the adjacent human/trusted-origin convention. Only `InvoiceHumanUiGuard`, a transport-only subclass of the existing `CurriculumHumanUiGuard`, was added and registered after `HonIdentityGuard`. It requires configured exact trusted public origin, POST, the fixed marker, JSON and no cross-site fetch metadata. Origin configuration failure is closed (`503`). No scope resolution, permission, idempotency contract, DTO or command behavior was replaced.

The unchanged controller resolves `billing.invoice.create` or `billing.invoice.issue` for the current verified identity and compares both organization and school. The unchanged runtime/service retain live human/scope/entitlement and tenant-transaction RLS authority. Draft creation checks account visibility/currency and optional membership visibility/account ownership inside the canonical transaction. Issue checks the RLS-visible locked invoice, DRAFT state, optimistic version and idempotency. Existing server-generated human attribution, audit and canonical outbox facts remain unchanged; no subscriber/worker or downstream executor is added.

## Memory lifecycle and failures

| Outcome/action | Browser behavior |
| --- | --- |
| Blank/mount/reload | No I/O or key generation; all input and receipt state starts empty. |
| Valid confirmed create | One immutable path/body/key; rapid submits are synchronously deduplicated. |
| Verified DRAFT | Separate unchecked issue confirmation; create cannot repeat without an edit/discard. |
| Confirmed issue begins | Hide the old DRAFT/action; the exact prior binding remains private to this command. |
| Verified ISSUED | Show only returned facts; no issue or automatic downstream action. |
| Network/server/redirect/unverified success envelope | No receipt is assumed; only the identical command may be explicitly retried. |
| Exact closed `409 IDEMPOTENCY_IN_PROGRESS` | Retain only the identical command for an explicit retry; never generate a replacement key. |
| Definite `400/404/409/413/415/422` rejection/conflict | Clear receipt/retry/confirmations; no version refresh or issue recovery. Require an edit or discard and a new explicit confirmed draft attempt. |
| `401/403`, including an exact retry | Clear every input, receipt, confirmation and retry. |
| Any input edit/discard | Clear receipt, both confirmations and retained retry; stale issue/retry handlers cannot execute. |
| Pending/unmount | Inputs/actions lock while pending; generation/mounted/ref guards prevent stale receipts and post-unmount state changes. |

**Clearing memory never cancels or undoes an already created or issued invoice.** A lost/uncertain outcome needs a separately authorized staff process before another draft attempt. This page deliberately cannot recover a historic invoice or refresh a version. It uses no local/session storage, cookies, URLs, timers or automatic requests to store/recover command facts.

## No-effect promise

> Issuing is an invoice-record transition, **not delivery or collection**.

Neither create nor issue implies or creates payment authorization/attempt, checkout/card capture, recurring schedule, provider execution/reconciliation, financial adjustment/refund/credit/discount, agreement, membership change, communications, schedule/attendance change, provider/AI/Action Engine/automation execution, or an external outcome. The prominent warning remains visible before every command and after both receipts. Existing canonical audit/outbox evidence is a record, not a delivery/payment claim.

## Validation evidence

Implemented against `main` **ff632d3**, initially with only the invoice-workbench TODO outcome uncommitted. No commit, push or deployment was performed.

- Focused new web suite: **3 files / 21 tests passed** (`invoice-workbench-http`, `invoice-workbench-ui`, `invoice-workbench-route`). It tests closed inputs/envelopes, permitted boundaries/optional membership, immutable command/receipt provenance, exact create/issue route/body/keys, replay HTTP semantics, every input edit, stale handlers, uncertainty-only retries, definite conflicts, access loss, malformed/private facts, pending/unmount safety and no forbidden transport/UI behavior.
- New API current HTTP-edge suite: **5 tests passed**. Combined with the existing class-booking edge and entitlement boundary suite: **22 tests passed**. The loopback Nest fixture tests real routing, guards, pipes, closed DTOs, exact permissions/context and response semantics using mocked identity/scope/services only; it never connects to a database or payment/provider.
- Root `pnpm test`: **343 API**, **92 web files / 484 tests**, **91 auth**, **22 domain files / 188 tests** passed. Root `pnpm check` and `pnpm build` passed; the build identifies the new page as dynamic. Final focused web/type checks also passed after the final warning-text/test refinements.
- Exact source-derived manifest comparison: **65 page routes**, unique and matching the complete manifest. Anonymous read-only local and temporary public HTTPS requests to `/staff/billing/invoices` both returned **307 `/auth/login`**, `Cache-Control: no-store, must-revalidate`; the manifest returned JSON with the invoice route once.
- `git diff --check`, changed/new-file newline/trailing-whitespace checks and byte comparisons confirm unchanged `InvoiceService`, both invoice DTOs and shared invoice contracts, and **no database/schema/migration changes**.

### Review concerns / deliberately unperformed work

1. **No database-backed invoice/RLS integration proof was run.** Both configured database URLs resolve to a remote Supabase pooler, not a recognized disposable localhost configuration. The existing invoice draft/issue integrity scripts are write fixtures and were not invoked. Loopback HTTP and mocked-service tests are not a substitute for a future isolated canonical database proof.
2. The new human HTTP guard intentionally denies legacy callers that omit the exact trusted origin/JSON/marker. Review deployment's existing `HON_PUBLIC_ORIGIN` and any direct HTTP callers before rollout; do not weaken server authorization to make a browser page work. Server idempotency still accepts its existing bounded-string contract; only this browser generates v4 UUID keys.
3. Strict receipt checking intentionally quarantines unexpected future canonical response changes instead of widening the projection or authoring missing financial facts. Lost receipt, stale version, uncertain result and historical recovery remain separate authorized staff responsibilities.
4. Root build reported warnings in **unchanged** `hon-reference-suite.module.css`, `parent-billing.module.css`, and `revenue-planning-workbench.module.css` (autoprefixer start/end support and webpack warning-cache serialization). No new invoice type/build error remained. The initial host diagnostic about an existing owner-launch guard export did not reproduce in API check/build.
5. No authenticated live-school browser mutation, database migration, provider call, real payment, communication, automation, deployment or Git publication was tested or performed. An independent review subagent was not exposed in this execution environment; self-review and the recorded automated/HTTP checks are the evidence, not an invented independent approval.
