# Deterministic Staff Search

## Delivered boundary

`GET /v1/organizations/:organizationId/schools/:schoolId/search?q=...&types=...` is conventional **find/navigate only**. `HonIdentityGuard` verifies the session; the server forwards only its external subject, current route scope, bounded query and closed type list to the fixed database projection. No actor, permission, tier, table, column, SQL, routing name, limit or provider is accepted from the client. `search.global` is sensitive and explicitly staff-assignable through the existing subset-controlled human role administration. Migration 0065 backfills **only existing canonical system OWNER roles**, never principals or school grants. Existing HQ provisioning/bootstrap selects registered permissions for a new OWNER; no extra provisioning authority is added.

Search has **no commercial entitlement lookup or plan upgrade gate**. Essential, Core and Complete receive identical behavior when the exact effective permission is granted. HQ status, family/parent access and unrelated people/reporting permissions never imply `search.global`. A dual-role human may use the staff endpoint only through a real active staff grant, never through Parent/Eian family scope. No Parent/Eian search route is introduced.

## Sources and display

| Kind | Match input | Returned display |
| --- | --- | --- |
| `STUDENT` | School-owned student profile's person's given/family name | Student profile ID, normalized name, fixed student status |
| `LEAD` | School-owned lead's person's given/family name, email or E.164 phone | Lead ID, normalized name, fixed lead status; **no contact values** |
| `CLASS_SESSION` | Session name | Session ID, normalized name, fixed status |
| `PROGRAM` | Program name | Program ID, normalized name, fixed status |
| `CURRICULUM` | Curriculum name | Curriculum ID, normalized name, fixed lifecycle |

Results are exactly `{kind, entityId, title, subtitle, route}` inside `{organizationId, schoolId, results}` and the existing request/correlation envelope. No total count, principal/user/person/family/pipeline IDs, raw source rows, emails, phones, dates of birth, attribution, descriptions or notes are returned. Archived/cancelled/draft operational records remain findable with their fixed status shown. People without a linked student or lead are excluded: this is **not a people or staff directory**.

No matching or result source includes private notes/activity details, billing/payment/membership fields, document content/evidence, knowledge articles, AI plans/prompts/outputs/ledger/work metadata, credentials or HQ/control-plane data. Display names are treated as untrusted text: controls/bidi format characters are removed, common spaces collapsed, names bounded at 160 characters and empty names replaced with `Unnamed record`. React escapes display strings. No rich HTML, snippet rendering or highlights are used.

Additive migration 0066 trims again after display truncation, so a clip exactly on a word separator still satisfies the normalized response contract. Migration 0065 remains unchanged after its development application.

## Determinism and security

`hon.search_school(text,uuid,uuid,text,text[],uuid)` is code-owned, `STABLE`, `SECURITY DEFINER`, with exactly `search_path = pg_catalog, hon`, all relations schema-qualified and PUBLIC revoked. Its controlled migration owner must have RLS bypass; only that owner and `hon_runtime` may execute. No new table grants, RLS policy, extension or external search store is introduced. The canonical Supabase provisioning and verifiers include the exact signature and closed ACL check.

One statement snapshot resolves one unambiguous active `HUMAN_USER`, active organization/school, matching organization-owned role (including custom role management school), non-revoked effective grant and exact `search.global`. All operational branches and person joins explicitly bind both organization and school. Client-selected UUIDs and forged tenant/principal GUCs do not authorize access. Each new request, including known-ID navigation, revalidates live IAM; revocation observed by a subsequent statement takes effect immediately. There is no cached permission/result/index or stale materialized directory. In-flight reads use normal PostgreSQL statement-snapshot semantics.

Queries are required, bounded at **120 Unicode characters before normalization**, nonempty after common-space normalization, and reject controls/bidi format characters. Optional `types` is a strict, comma-separated, unique list of the five exact uppercase kinds. Omission means all known kinds; empty, duplicate, unknown, repeated-array or malformed filters fail. API DTO whitelisting rejects unregistered parameters. SQL separately validates scalar one-dimensional arrays, bounds and known kinds.

Matching is literal case-insensitive substring (`strpos`, parameter binding), not SQL/LIKE/regex supplied by the client. `%`, `_`, quotes and SQL-like text are ordinary characters. Ranking is exact normalized display-title match, prefix display-title match, then other matches; ties use lowercased title with `C` collation, kind with `C` collation and scoped entity UUID. At most **20** cards are emitted. School-leading existing indexes bound the operational scans; execution has a runtime **2-second statement timeout**. This deliberately starts without fuzzy matching, pagination, query analytics or new derived infrastructure. Reconsider indexing/rate limiting only against measured school-scale load, without broadening sources.

The runtime opens an explicit `BEGIN READ ONLY`, sets only a transaction-local timeout, executes one fixed parameterized function and commits/rolls back/releases the connection. Search writes no operational rows, audit, outbox, idempotency, Action Engine requests, provider/config state or AI usage. It invokes no LLM, embedding, vector/search service or provider. `STAFF_SEARCH_READ_REGISTRY` is separate from `ACTION_CATALOG`; there is no executable search action/tool.

## Conventional web route

`/staff/search` uses only same-origin GETs through the existing `/api/v1` proxy, with current known organization/school IDs, literal query and checkboxes for fixed kinds. Scope input never grants authority. The page has explicit initial, loading, no-match, permission-denied, sign-in and unavailable states. Query and names are not stored in browser storage or page navigation URLs. Requests/results use no-store; search responses and page metadata disable referrers and indexing. Deployments must also configure access logs to **omit/redact query strings**: GET queries can otherwise enter standard reverse-proxy logs.

Routes are server-composed as `/staff/search/:organizationId/:schoolId/:kind/:entityId`. This route opens a redacted card through `GET .../search/results/:kind/:entityId`, a known-ID-only lookup using the same fixed projection and live permission. It cannot expose expanded profile/content or execute anything; nonexistent/wrong-school records return a safe 404 after authorization. The function's known-ID mode requires one known kind and a mandatory server-owned bounded query token. This avoids dead links while keeping independently authorized broader operational detail pages deferred. The web also validates kind, UUID, scope and exact route before rendering a link.

The static `/manus-routes.json` is synchronized with all existing source pages, including nested staff/document pages and this dynamic route. Core's fake search affordance now links to the real staff page rather than claiming an unimplemented directory/keyboard action.

## Validation and operations

Run `pnpm check`, `pnpm test`, `pnpm build`, `pnpm db:check`, `pnpm db:migrate`, `pnpm db:verify-rls` and `pnpm db:test-search`. The live test requires both protected migration `DATABASE_URL` and restricted `HON_RUNTIME_DATABASE_URL`; it refuses missing configuration. It creates unique isolated fixtures and removes only those IDs in `finally`, never customer records. It verifies actual runtime flags/denied directory/HQ/document reads, definer ACL/path, cross-school/org/family/HQ denial, exact permissions and expiry/revocation, all-tier parity, mandatory bounded SQL/API query, forbidden-source/display canaries, literal injection, stable ranking/20 cap, known-ID navigation, forged-GUC independence, READ ONLY execution and before/after operational/HQ hashes. New API HTTP tests also prove guard, UUID/DTO validation, read-only routing and no-cache headers. Web tests prove escaped display contracts, safe same-origin paths, empty/failure states, read-only registry separation and manifest parity.

HON Command remains a **future, separately authorized explanation/action layer**. Parent/Eian search, richer detail navigation, reviewed additional kinds, fuzzy search/indexing, exports/pagination and query rate controls remain separate scope. This slice makes no AI or action-execution claim and spends no AI credits.
