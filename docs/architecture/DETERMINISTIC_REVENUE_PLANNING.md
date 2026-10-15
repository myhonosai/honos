# Deterministic School Revenue Planning

## Scope and non-advisory boundary

The `/staff/planning/revenue` workbench is a **human-only, conventional scenario calculator**, available to active Essential, Core and Complete schools with exact `planning.revenue.manage`. It is **not financial advice, a revenue guarantee, an AI recommendation, a forecast of collected receipts, or an execution system**. It does not assess market demand, acquisition feasibility, churn, timing of acquisition, collections, taxes, costs, profit or return on spend. The target window describes the planning horizon; the monetary target remains **monthly** recurring schedule value, not total revenue across that horizon.

The model holds the captured eligible baseline constant, applies a serial lead → trial appointment → completed trial → membership funnel, and treats the eligible schedule average as a **conventional new-member price proxy** unless explicitly overridden. The proxy is visible as `CURRENT_ELIGIBLE_AVERAGE` with its exact fraction and limitation; it is not observed new-member pricing. There is no presumption that recorded CRM `WON` status constitutes membership conversion. No provider, AI, payment, CRM mutation, Action Engine, campaign, message, work item, budget spend or publishing integration is called or enabled.

## Evidence and source semantics

Migration `0072_school_revenue_planning.sql` creates three private, forced-RLS tables with **no policies**: current `revenue_plans`, append-only `revenue_plan_versions` and immutable `revenue_plan_requests`. Revisions save exact input, algorithm version, aggregate evidence and capture timestamp plus a SHA-256 over the canonical PostgreSQL JSONB plan/evidence serialization. The hash is an internal reproducibility identifier, **not a signature or authorization token**; browser JSON serialization is not its canonical hash representation.

All aggregate evidence is collected by **one SQL statement**. It exposes no contact names, emails, phone numbers, people/payer identifiers, account references, invoice/payment rows, provider references, private appointment notes, CRM attribution or principal directory records.

| Signal | Eligible evidence and explicit limits |
| --- | --- |
| Baseline | ACTIVE membership at capture; term started and not ended; exactly one ACTIVE schedule; MONTHLY frequency; auto-renew enabled; both schedule and scoped billing account currency equal the plan currency. No normalization of annual/weekly/custom schedules. Excluded ACTIVE memberships are counted explicitly. |
| New-member price proxy | Exact eligible aggregate minor-unit sum / eligible membership count, **minimum 5**. Below that threshold, unavailable unless a human price is supplied. |
| Lead → booked trial appointment | Distinct leads created in `[historyFrom, historyTo)`; one terminal TRIAL appointment starting at or after lead creation and within the same half-open window. Minimum **20 leads**, no repeated or unresolved trial ambiguity anywhere in the cohort. CANCELLED and NO_SHOW are terminal bookings, not completed trials. |
| Appointment → completed trial | Completed trial lead count / booked terminal-trial lead count; minimum **20 booked leads**, same no-ambiguity rule. |
| Trial → membership | **Unavailable from the current schema**: no trial/lead-to-membership lineage. Requires a bounded human assumption. CRM `WON` is deliberately ignored. |
| Activities per lead | **Unavailable from the current schema**: CRM activity records do not establish an unambiguous acquisition unit. Requires a human quantity assumption; no activities/tasks/messages are created. |

`CURRENT` reads return `evidenceState: LIVE`: current plan version with newly captured aggregates and timestamp. They do not append history or rewrite saved evidence. `SAVED` reads and successful saves/replays return `evidenceState: SAVED`: immutable revision evidence. Source labels refer to data **at capture**, not today's data when viewing a saved revision. Historical cohorts use **current recorded outcomes** for the selected window, not reconstructed immutable transition history. Changing source data changes live evidence; reading an older saved revision remains reproducible.

Human assumptions take explicit precedence over observed signals, are listed in stable sorted order, and use source `HUMAN_ASSUMPTION`. Their sample/minimum metadata is zero because no observed sample is required for an explicit assumption. Blank is not zero. `ZERO_BASELINE` is separately and visibly labeled `HUMAN_ZERO_ASSUMPTION`; the actual captured eligible baseline remains visible. Observed signals retain their sample sizes/minima, including when unavailable. The API emits trusted algorithm validation metadata (`validation`) from versioned constants; it is not request-controlled.

## Exact algorithm: `school-revenue-v1`

Inputs use nonnegative **integer currency minor units**, one three-uppercase-letter currency code, canonical UTC millisecond instants and half-open windows. No currency conversion, minor-unit-to-major-unit rounding, or ISO currency exponent lookup is performed. Currency cannot change within a plan. Canonical numeric serialization is validated by both shared contracts and SQL; numeric strings, nonfinite values, fractional quantities and rates beyond six decimal places are not accepted.

- Target and explicit new-member price: `0..1,000,000,000,000` minor units.
- Target window: 1–366 days; history window: 1–92 days and ending no later than database capture time.
- Rates: `0..1`, at most six decimal places. A validated decimal literal is converted to an exact integer-millionth rational, **without floating-point multiplication or tolerance**.
- Manual activities per lead: integer `0..1000`.
- At most 50 plans per school; versions 1–999,999,999. Expected request version is 0 for create or the exact current version for update, bounded so it cannot overflow a new revision.
- Evidence aggregates must fit a nonnegative JavaScript safe integer; invalid currency/window/count relationships and invalid timestamp/hash/version/algorithm metadata are rejected before output.
- Every required funnel quantity is capped at **1,000,000,000**. Outputs over the cap are `OUTPUT_LIMIT`, never unsafe integers or unbounded suggested execution.

```text
gapMinor = max(0, targetMonthlyMinor - selectedBaseline)
memberships = ceil(gapMinor / priceProxyOrExplicitPrice)
trials = ceil(memberships / trialToMembership)
appointments = ceil(trials / appointmentToTrial)
leads = ceil(appointments / leadToAppointment)
activity = leads * activitiesPerLead
```

Each division uses **BigInt integer/rational arithmetic** and rounds up only at that funnel step. The visible numerator/denominator drives calculations; the displayed decimal ratio is informative and never reused for arithmetic. Zero gap makes the entire funnel `NOT_REQUIRED` / zero even when signals are unavailable. Missing positive-gap inputs are `ASSUMPTION_REQUIRED`; explicit/observed zero divisors are `ZERO_DENOMINATOR`; dependent steps are `UPSTREAM_BLOCKED`. A valid explicit zero activity multiplier yields zero manual activity units, not an invented outreach obligation.

`projectRevenuePlan` is pure: no clock, random value, network or mutation is consulted. It validates the actual stored version rather than overwriting caller-supplied version metadata, rejects unexpected snapshot/plan/input/evidence fields, and builds detached safe output. Clients cannot submit plan version, algorithm version, validation metadata, evidence snapshots, hashes, actor/principal/source/delegation or financial/PII fields to bypass state. The only version input is the optimistic **expectedVersion**. Stored plan input excludes that request metadata. Changes to algorithm semantics require a new algorithm version and an explicitly reviewed compatibility path; existing v1 saved evidence must not silently be interpreted by a different algorithm.

## Authority, concurrency and atomicity

The API uses verified server identity, the exact school resolver and a trusted-origin JSON `revenue-planning` command marker; user-selected organization/school UUIDs **are selectors, not authority**. Every read and save revalidates live HUMAN_USER/HUMAN_UI, unique active human principal, active organization/school, exact current school role grant/permission and active entitlement. Parent family access, legacy school permissions and HQ grants confer no planning permission. AI, integration, automation, public API, HQ source, Action request and delegation contexts are denied.

The database locks organization → school → user/principal → grant → role/permission → entitlement in the established IAM order, then rechecks authority. Lock wait time and expired/revoked permission cannot bypass checks. Replays are checked **after live authorization**, not used as a stale permission cache. API transactions set local scope/source and bounded statement/lock timeouts; pooled scope is cleared afterward.

Only `hon.save_revenue_plan(text,uuid,jsonb,text,uuid,uuid)` and `hon.read_revenue_plan(text,text,uuid,integer)` are new runtime-callable functions. Their trusted owner can cross forced RLS; their `search_path` is exactly `pg_catalog, hon`. Validation, trigger, actor/lock and raw snapshot helpers are owner-only. Tables/columns are owner-only, no PUBLIC/client or direct runtime grants, no broad execute grants or runtime grant option. Existing RLS-bound data-plane permissions for other domains are unchanged; this slice adds no directory/HQ/table access.

School locking serializes the cap and concurrent updates. Each save uses exact optimistic version and a principal/school-scoped key plus a canonical fingerprint. Unchanged duplicate keys replay the original saved revision; reused keys with changed inputs conflict. Distinct keys racing on one version produce one revision and one conflict. Plan, immutable revision, replay receipt, redacted audit event and inert `planning.revenue.human_saved` outbox row commit **together**, or all roll back. Audit stores versions/algorithm/hash only, not targets/rates/PII. Outbox contains plan ID/version and `internalOnly: true`; it is not registered as an execution/provider event.

The same-origin UI uses only the fixed `/api/v1/organizations/.../schools/.../planning/revenue` route family, `no-store` and session credentials. It shows no invented default data. Exact UTC instants survive editing without truncation to dates. Retry keys are retained in memory for unchanged uncertain requests; no local/session-storage financial snapshots are persisted. Failed/malformed responses show no assumed success or raw SQL detail. A verified save followed by a list-refresh failure explicitly distinguishes those outcomes. Authorization failure clears visible scoped evidence.

## Provisioning and verification

Canonical `infra/postgres/010_supabase_hon_runtime.sql` reproduces the migration minima for a fresh runtime role. `011_verify_supabase_hon_runtime.sql` has executable revenue assertions as well as diagnostics. `packages/database/scripts/verify-rls.mjs` checks all **75** tracked operational forced-RLS tables, trusted-owner/owner-only revenue table and column ACLs, deny-all policies, exact callable/private function ACLs, fixed paths and denied PUBLIC/client/directory/HQ access. It accepts canonical `hon_runtime`; the only alternate `hon_revenue_runtime` role is allowed with explicitly guarded disposable-local revenue URLs.

Root/package command:

```sh
pnpm db:test-revenue-planning
```

This command requires explicitly supplied **localhost `/hon_revenue_validation`** administrator and restricted-runtime URLs; it refuses remote databases. It builds existing workspace packages, runs synthetic isolated fixture tests and cleans them, runs the canonical SQL verifier and performs seven restored negative JS/SQL verifier probes (PUBLIC command execution, helper execution, grant option, column SELECT, table SELECT, unforced RLS, accidental policy). It installs nothing and calls no providers.

The disposable database is rebuilt only through the existing guarded local setup script `/home/ubuntu/jobs/job_Ct9gl0vD/setup-revenue-db.sh`, using all 72 migrations and canonical 010 with only local database/role/password substitutions. That proof is **not a remote production/Supabase rollout**. Root `pnpm check`, `pnpm test`, `pnpm db:check` and `pnpm build` run with `DATABASE_URL` and `HON_RUNTIME_DATABASE_URL` removed.

## Test coverage

- API: closed DTO and live bound-function calls, server-derived context, honest private/no-store HTTP envelopes, origin/marker/JSON gates, malformed UUID/version, bounded literal input, safe output validation, deterministic ceilings/limits, source/sample/assumption semantics, nonhuman denial, redacted error mapping and inert registries.
- Web: no-data/blank-assumption states, saved-versus-live labeling, exact evidence ratios and limits, zero/missing-source rendering, same-origin credentials/keys, uncertain malformed/failed responses, exact timestamp preservation and route manifest.
- Local database: school/sibling/organization/real-guardian/HQ isolation; permission/principal/organization/school/entitlement revocation and expiry after waits; all tiers; window boundaries, exclusions/currency/ambiguity; stable saved snapshots versus changing live data; missing evidence and zero divisors; idempotency/version/concurrency and school cap; redacted financial/PII/audit/outbox; immutable history; audit/outbox injected rollback; direct restricted runtime ACL denial and forced-RLS SELECT/INSERT denial even after accidental grants; unchanged CRM/billing/payment/communication/AI/Action/family/task rows.

Production application, broader remote regressions and provider consumers remain separate, deliberately unperformed work.
