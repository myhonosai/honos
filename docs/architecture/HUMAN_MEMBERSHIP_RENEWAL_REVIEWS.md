# Human membership renewal review foundation

## Operating boundary

`/staff/billing/renewals` is a conventional **shared school finance/manager workbench** across active Essential, Core and Complete schools. A human saves a review record, not a renewal agreement, collection plan, customer promise or membership decision.

**No collection, notices or automatic renewal.** This slice never sends emails/texts, schedules reminders, charges a card, creates/refunds payments, changes/cancels/renews memberships, writes invoices/payment schedules, invokes AI/providers or Action Engine, or activates external billing processors. The internal event has no consumer/execution registration. A manual `reminderNeeded` boolean/null is only a fact for staff; `true` does not create a reminder job, message draft, consent decision or customer contact lookup.

## Inspected existing facts

- Memberships contain tenant-scoped billing-account and participant links, state/version and nullable term start/end. Draft creation, DRAFT→ACTIVE activation, and direct human cancellation are separate existing commands; none is called here. `CANCELLATION_PENDING` is a schema state, not implemented future cancellation scheduling.
- Membership payment schedules contain frequency, positive integer minor-unit amount, currency, optional next-charge timestamp, status and an observed `auto_renew` flag. Membership term is not payment frequency. A recorded flag is not evidence that billing is running, that consent exists, or that renewal is eligible.
- Invoices are separate draft/issuance facts; payment attempts contain provider references. Neither invoices nor payments are queried for this projection or touched by review commands. No processor-tokenized method or provider token is projected. No inferred paid status, debt, MRR or outstanding collection balance.
- The view intentionally omits plan text, payer/participant/account identity, contact information, payment-method/provider references and all directories. Already-known membership UUIDs are required; no membership/payer directory or schoolwide billing enumeration is added. All scoped account/payer/participant links are integrity facts, **not actor authorization**.

## Human authority

Both exact permissions are required: `billing.renewal.manage` and `billing.membership.read`, resolved from current staff-valid **school** grants. Owner system roles receive these additive staff-assignable permissions. Other finance/manager/custom staff roles must be assigned them explicitly through existing governed role management. No role-name-only allowlist, self/assignee shortcut or ownership shortcut. Ordinary front-desk, parent/guardian/family/student, HQ operators (even with dual school grants), public, AI, automation, integration, delegated and Action Engine contexts cannot enter the boundary.

The API uses only a verified external subject to derive one unambiguous eligible school/principal. Missing, inactive, expired, revoked or ambiguous scope fails closed. Organization-only grants cannot supply authority (current IAM school grants are non-null). An exact permission cannot be borrowed from a wrong-management-school role. Direct SQL boundaries independently verify `HUMAN_USER`/`HUMAN_UI`, identity/principal binding, no delegation/action request, active school/org, staff eligibility and an active entitlement in any of the three tiers.

## Record and workflow contract

`0080_human_membership_renewals.sql` adds immutable roots (`membership_renewal_reviews`), append-only snapshots (`membership_renewal_versions`) and permanent tenant/actor receipts (`membership_renewal_requests`). The membership foreign key is composite tenant-scoped and immutable. Multiple deliberate reviews for a membership are allowed; duplicate suppression is by exact retained command key, never a hidden time-based deduplication heuristic.

The closed input contains exactly:

| Field | Rule |
| --- | --- |
| `expectedVersion` | CREATE: 0; REVISE: 1–999,999,998, exact latest version |
| `membershipId` | Already-known school membership UUID; cannot change on revision |
| `reviewFrom`, `reviewTo` | Canonical millisecond UTC ISO strings in 2000–2099; half-open `[from,to)`; duration 1 minute–366 days; past and future accepted |
| `status` | CREATE is OPEN; revisions may be OPEN, REVIEWED, DEFERRED or CLOSED. A CLOSED latest record can only be explicitly reopened to OPEN. No clock-driven transition. |
| `note` | Required, 1–2,000 Unicode code points, trimmed plain text; internal line breaks allowed, controls/invisible bidi text rejected |
| `reason` | Required, 1–500 code points, trimmed single-line plain text; no control/bidi characters |
| `reminderNeeded` | Required closed field, boolean or null (optional fact represented by null) |

Every revision requires explicit human note/reason and captures **current** membership version/state/nullable terms and existing schedule facts. All schema membership states may be reviewed, including DRAFT, CANCELLED and open-ended memberships; OPEN is not an eligibility judgment. Current facts are read separately from captured facts and never rewrite historical snapshots. At most 20 schedules by ID are projected, with an exact count and explicit truncation flag; no amounts or dates are invented/aggregated across different currencies. Notes must not contain card details, payment tokens or provider secrets.

## API and UI

All routes are under `/v1/staff/billing/renewals`, same-origin web transport `/api/v1/staff/billing/renewals`. No body actor, school, organization or recipient fields.

| Method/path | Result |
| --- | --- |
| GET `?status=OPEN\|REVIEWED\|DEFERRED\|CLOSED\|ALL&after=<uuid>` | Current shared school queue; 50-item ID keyset page; no notes/reasons, payer/contact or global total |
| GET `/memberships/:knownMembershipId` | Safe current known-membership summary only |
| GET `/:renewalId` | Current review detail and separate current membership facts |
| GET `/:renewalId?version=<integer>` | Exact immutable saved revision, private note/reason and captured facts; separate current membership facts |
| GET `/:renewalId/history?before=<integer>` | 50-item descending version metadata page, no private notes/reasons or unbounded snapshots |
| POST `/` | Human CREATE, required `Idempotency-Key` and `X-HON-Human-Command: billing-renewals` |
| POST `/:renewalId/revisions` | Human REVISE, same headers and exact expected version |

Mutations require configured `HON_PUBLIC_ORIGIN`, exact Origin, JSON content type and same-origin fetch-site (if supplied). Identity and database authority still govern every read. Responses are `private, no-store`. No lifecycle execution, send, collect, charge, refund, renew, cancel, proposal or directory endpoint exists.

The UI starts empty without fetching or fabricated data, requires a human scope load, offers explicit known membership read and human status/notes/reason editing, and shows saved vs current facts separately. Historical detail is read-only. After a verified save, further edits require a fresh current read: a replay may be an older saved revision. Uncertain exact input/key is retained **in page memory only**, manually retried with no automatic resend. Access denial clears sensitive detail/queue/form state. No local/session storage of private notes or provider connectivity.

## Persistence, RLS and audit

Five public-runtime functions are the only new boundary: scope, mutate, read reviews (including exact version), read known membership and read history. Private helper/projection/guard functions are not runtime-callable. Every function pins `search_path=pg_catalog,hon` and trusted definer ownership; private tables have forced RLS, **no policies and no runtime/PUBLIC/client table or column grants**. Immutability and insert-invariant triggers protect scope, actor, version, state, fields and exact captured facts. Canonical runtime `010`, `011` and JS verifier reconcile/check exact ACLs, role membership/posture, function owner/definer/path/grant options, tables/policies and trigger configuration.

Stable organization→school→user/principal→grant/role/permission→entitlement locks serialize human commands/receipts and revalidate live authority with `clock_timestamp()` after waits and before replay/result. Membership/account/people/schedule SHARE locks provide scoped consistent observations and prevent conflicting billing changes while capturing facts; they do not create payer authority. Snapshot reads do not write any business domain. Serialization is deliberately conservative at school/org foundation level; fine-grained concurrency optimization is future work, not silent removal of locks.

The root/version, redacted audit, inert outbox and permanent receipt commit atomically. The fingerprint covers operation, ID and closed input using canonical JSONB and SHA-256. Same actor/school/key with unchanged input replays the original saved revision after live revalidation; changed input conflicts. Different actors have separate key namespaces. Current version mismatch and concurrent conflicting revisions return a conflict, never a lost update.

Audit `billing.renewal.manage` and event `billing.renewal.human_revised` carry review ID/version/operation/status plus `humanOnly:true`, `internalOnly:true`, `executionAllowed:false`. They contain **no private notes/reason, membership/payer IDs, terms, schedules, amounts, contact or provider fields**. No work/automation/message/action handler is registered. A future consumer must not reinterpret these review facts as execution authorization.

## Local validation and rollout

`pnpm db:test-billing-renewals` refuses anything except `localhost:5432/hon_renewal_validation` and exact `hon_renewal_owner`/`hon_renewal_runtime` fixture aliases. Migration and verifier alias handling is equally bounded. Local owner is deliberately privileged only to install trusted test definers; runtime is restricted. Do not use configured remote Supabase data for validation.

Coverage includes cross-school/org/parent/HQ/nonhuman/source denial, missing/revoked/expired/ambiguous/wrong-role permission, live post-lock revocation/expiry, canonical window/note/status validation in both API and SQL, termless/terminal memberships, captured vs current facts, versioned detail/history/pagination, replay/same-key/different-key concurrent requests, no runtime/private/directory access, actual-row non-bypass-owner forced RLS, 12 deliberate canonical/JS drift probes, atomic audit/outbox failure rollback and exact unchanged billing/payment/message/AI/action/provider tables. Unit/real local HTTP/UI projection tests and full workspace checks/tests/build complement these tests.

Deployment is not performed by this change. Apply reviewed migrations before re-running canonical runtime reconciliation/verification in an authorized deployment workflow. No remote migration, provider activation, unattended job or customer notification is implied.
