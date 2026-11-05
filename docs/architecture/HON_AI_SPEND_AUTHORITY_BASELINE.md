# HON AI spend-authority baseline (AI-0)

Status: test-only regression baseline, measured on main `b234be7`. **AI-0 is a regression baseline, not the security fix.** It changes no migration, function, grant, policy, program, provider route or deployment. The fixes belong to **S4** (and, for UNKNOWN holds, a separate slice after owner decision AI-D3).

## What AI-0 is for

Today three AI employees can spend provider money: Marcus (marketing drafts), Claire (teaching outlines) and Chad (CRM follow-up drafts). Each one reserves credits, calls the provider, then records usage in `ai_usage_ledger`. B3 premium credits exist but their program is INACTIVE.

AI-0 locks down what exists so nothing changes silently before S4:

1. A strict inventory of every AI spend path, grant and budget ceiling, collected from the database and compared exactly.
2. Proof that no trial, exception, allowance or paid-access authority has been added quietly.
3. Known-failure probes that reproduce the open problems on purpose and fail CI if they change without review.

## How it runs

| Piece | File |
|---|---|
| Disposable fixture | `packages/database/scripts/setup-ai-spend-baseline-validation.mjs` (database `hon_ai_spend_baseline_validation`, roles `hon_ai_spend_baseline_owner` / `hon_ai_spend_baseline_runtime`, all migrations plus the canonical runtime grants) |
| Inventory | `packages/database/scripts/ai-spend-entrypoints.json` |
| Proof | `packages/database/scripts/test-ai-spend-authority-baseline.mjs` |
| CI | `.github/scripts/run-db-proofs.sh` (regular `ci.yml` disposable PostgreSQL job) |
| Local | `pnpm --filter @hon/database db:test-ai-spend-baseline` with the fixture env file sourced, or `HON_DB_PROOFS_LOCAL=1 .github/scripts/run-db-proofs.sh` |

Safety rails in the proof:

- It accepts only the exact localhost owner and runtime roles of this fixture, and checks the database name, owner and fixture marker before anything else.
- Before any client is constructed, both URLs must use a PostgreSQL scheme, exact `localhost:5432`, the exact database and role, and a non-empty password, with **no query string or fragment** (node-postgres lets query parameters such as `host`, `user`, `port` and `sslmode` override the URL). libpq `PG*` environment variables are refused. After connecting, the owner and the runtime connections each verify `current_database()`, `current_user` and the marker. The guard is a pure module (`ai-spend-baseline-target.mjs`) with socket-free negative cases (`test-ai-spend-baseline-target.mjs`) that run at the start of every AI-0 run.
- It refuses to start if any provider, payment, Supabase, AWS or execution variable is present.
- `fetch` is replaced with a counter that throws; the run must end with zero network calls.
- Providers are in-process fakes. The real provider runtime is never built.
- The single synthetic exception-policy approval exists only inside the disposable database and says so in its reason text.

**Single-use fixture, no row cleanup.** The fixture is dropped and recreated before every run, and INV-4 refuses a database that is not pristine. Instead of deleting rows afterwards, INV-12 asserts that every AI row is confined to the proof's own synthetic organizations and that program rows are unchanged.

## Checked universe (what AI-0 does and does not cover)

AI-0 pins only what it actually collects and asserts. It does **not** claim completeness beyond this list.

- **Covered:** the three agent runtimes (Marcus, Claire, Chad) end to end through their real services with fake providers; their spend tables, record/fail/prepare functions and runtime grants; `ai_usage_ledger` writers; `saas_credit_reservations` writers; literal `12000` ceilings; spend-table triggers; the B3 premium reservation refusal while the credit program is inactive; credit, trial, paid-access and payment program posture; the exception end-of-access path (INV-9).
- **Not covered (review separately; candidates to extend INV-1/INV-2):** B3 allowance and credit-ledger internals beyond the writer list, pricing and provider-cost evidence helpers, generic helper functions that spend paths call, and restricted Supabase-shaped roles other than the disposable runtime role (anon/authenticated/service_role are checked only for grants, not exercised).
- **Exception and post-lapse probes:** the former KF-AI14 probe asserted per agent the exact `*_PERSISTENCE_UNKNOWN` code, one provider call, no ledger row and the agent's estimate still held (now replaced by INV-13 in S4-a, which covers all three agents and three lapse kinds); KF-AI2 asserts the per-agent split (6 + 6 + 3 at used 11,990). KF-AI9 exercises Marcus only; S4-c must prove all three agents.

## Invariants (must pass; any failure blocks CI)

| # | What is locked |
|---|---|
| INV-1 | Exact inventory: spend tables, spend functions, ledger, reservation, allowance and credit-ledger writers, every `12000` ceiling literal, every function referencing spend columns or tables, and spend-table triggers. |
| INV-2 | Grant matrix: runtime execute rights exactly as pinned; nothing executable by PUBLIC or the Supabase client roles; no direct runtime writes to spend tables. |
| INV-3 | Credit, trial, paid-access and payment programs closed (checked before and after). |
| INV-4 | Nothing seeded: no allowance, reservation, credit ledger, AI usage, trial, exception or access-state rows; AI policy records pinned with actions disabled. |
| INV-5 | Trial metadata is read only by trial-governance functions and never by a spend path or spend writer. |
| INV-6 | No spend function reads paid-access state or access exceptions (S4 changes this list on purpose). |
| INV-7 | Agent and B3 spend paths stay separate (no double debit). |
| INV-8 | For all three agents, 11 gate scenarios refuse before the provider: no entitlement, CORE, Essential, suspended, expired, not yet effective, school suspended, organization suspended, missing `ai.invocation.plan`, AI source, delegated context. |
| INV-9 | After an exception is revoked, expires, or is CORE scope, agents are refused. |
| INV-10 | B3 premium reservations are refused with `SAAS_CREDITS_NOT_ACTIVE`. |
| INV-11 | An allowed call records exactly one ledger row with provider cost; a replay records none; a provider rejection releases the hold. |
| INV-13 | (S4-a) A charged result records exactly one ledger row after a mid-flight lapse, ends `RESULT_HELD` with no proposal, and binds once after access returns; usage survives a failed proposal; duplicate ledger rows per invocation are refused. |
| INV-14 | (S4-b) One organization agent budget: at used 11,990 every arrival order of Marcus 6, Claire 6, Chad 3 is admitted greedily against 12,000; refusals are durable `BLOCKED` / `CUSTOMER_BUDGET_EXCEEDED` with no provider call; committed never exceeds the ceiling. |
| INV-15 | (S4-b) Deterministic serialization: with `ai.budget:<org>` held by a blocker, both prepares of each same-agent and cross-agent pair are blocked (pg_locks); after release exactly one reaches the provider and the other is `BLOCKED`. |
| INV-16 | (S4-c) A live COMPLETE HQ exception refuses begin for all three agents and prepare for requests begun before the grant (`AI_EXCEPTION_NO_AI`, no provider call); calls already in flight at grant time still record. |
| INV-17 | (S4-c) Every paid-access state maps to a documented decision for both entitlement conditions; unknown states refuse; trial spend only through the unapproved funding hook; a real `AWAITING_FIRST_PAYMENT` row refuses; legacy organizations are unchanged. |
| INV-18 | (S4-c) HQ emergency pause: human HQ owner only, organization or platform scope, per spend class or ALL, idempotent per key, one active pause per scope, append-only; agents refused while paused and resume afterwards. |
| INV-19 | (S4-d) UNKNOWN and stale SENDING holds count only in the window in which they were held; in-flight calls always count; late agent evidence stays refused; the HQ queue lists open lost outcomes. |
| INV-20 | (S4-d) Human HQ owner resolution with closed provider evidence: one ledger row in the original window, none, or a zero-credit write-off; idempotent, once per call; immutable record, audit and inert outbox. |
| INV-12 | Zero network calls, programs unchanged, AI rows confined to synthetic organizations, no allowance, trial or access-state writes. |

## Known failures (intentionally vulnerable probes)

Each probe prints `KNOWN-FAILURE (open, replaced by <slice>) <id>: reproduced | not reproduced: <detail>` and is listed in `knownFailures` in the inventory with status `OPEN`. It **passes while it reproduces exactly as recorded**. If the behavior changes while the entry still says `OPEN`, the proof fails with "behavior changed silently", so a fix can never land without review. If the entry is no longer `OPEN`, the proof also fails until the probe is replaced by its invariant.

| Probe | Plain-language problem | Today (reproduced) | Replaced by |
|---|---|---|---|
| **KF-AI2-CROSS-AGENT-OVERCOMMIT** (FIXED_BY_S4B, INV-14) | Each agent checks the monthly ceiling against the shared ledger but only its own open holds, so three agents together can exceed the ceiling. | Used 11,990, then Marcus 6 + Claire 6 + Chad 3 all reach the provider: 12,005 committed against 12,000. | S4 org-wide committed credits and budget lock |
| **KF-AI9-EXCEPTION-SPEND** (FIXED_BY_S4C, INV-16) | A D9/D10 HQ access exception with COMPLETE scope sets the entitlement to COMPLETE ACTIVE. The exception receipt says `aiCredits: NONE`, but the agent gate only reads the entitlement. | Unpaid school, COMPLETE exception: Marcus reaches the provider once and writes a ledger row. | S4 explicit exception refusal |
| **KF-AI14-MIDFLIGHT-LAPSE-EVIDENCE** | Found while building AI-0. `record_*` and `fail_*` re-run the entitlement gate through the agent owner check. If the entitlement lapses while a call is in flight, the provider has already answered but nothing can be written. | For all three agents: provider called once, service returns `*_PERSISTENCE_UNKNOWN`, no ledger row, invocation stuck `SENDING` with its hold still reserved (6, 6, 3). Provider cost goes unrecorded and the stuck hold keeps counting against the agent's budget. | S4 (evidence steps never guarded). **FIXED_BY_S4A**: replaced by INV-13. |
| **KF-AI8-UNKNOWN-HOLD** (FIXED_BY_S4D, INV-19/INV-20) | An UNKNOWN provider outcome keeps its hold forever, across months, and no function can resolve it. | A last-month UNKNOWN Marcus hold still blocks Marcus at used 11,990 while Claire passes; late fail and late record are both refused `MARKETING_OUTCOME_REPLAY`; no ledger row. | Separate slice after owner decision AI-D3 |
| **KF-AI3-SAME-AGENT-RACE** (FIXED_BY_S4B, INV-15) | Two concurrent prepares of the same agent could both pass the ceiling check. | **Not reproduced** on `b234be7`: the second Marcus prepare waits on a `transactionid` ShareLock held by the first and is refused by the per-agent ceiling after the first commits (12,000 committed). Recorded each run; "not reproduced" never fails CI. | S4 budget lock (makes serialization explicit for every agent and B3) |

## How S4 replaces the known failures

S4 needs its own owner approval (AI-D1 stays open) and a migration number from the owner. AI-0 does not assign one.

### Unpaid HQ exceptions (KF-AI9)

Exception schools have **no** paid-access state row, so an S4 decision that only reads access state would still let them spend. S4 must add an explicit check:

- In the S4 spend decision (`hon.ai_spend_allowed(org, at)` in the S4 design): if a `saas_access_exceptions` row for the organization is `GRANTED`, `starts_at <= at < expires_at`, and the entitlement version equals `granted_entitlement_version` (the exception currently owns the entitlement), refuse with `AI_EXCEPTION_NO_AI`, unless a future owner-approved per-exception AI cap exists (not built).
- The check runs before the legacy branch, in the start and reserve guards, and in the B3 guard.
- In the S4 PR: KF-AI9 becomes `FIXED_BY_S4`, its probe is replaced by an invariant (prepare refused, provider calls 0), and INV-9 stays.
- **Done in S4-c (migration 0195):** KF-AI9 is `FIXED_BY_S4C`, replaced by INV-16 for all three agents. See `HON_AI_ACCESS_DECISION_S4C.md`.

### Shared cross-agent budget (KF-AI2, KF-AI3)

- **Done in S4-b (migration 0194):** KF-AI2 and KF-AI3 are `FIXED_BY_S4B`, replaced by INV-14 and INV-15. See `HON_AI_ORG_BUDGET_LOCK_S4B.md`.

- One function computes organization committed credits: current-month ledger credits plus reserved credits across all three agent tables plus open B3 reservations.
- A reserve guard (`BEFORE UPDATE` when `reserved_credits` increases) takes an advisory lock `ai.budget:<org>` last, then refuses with `AI_ORG_BUDGET_EXCEEDED` (SQLSTATE 42501, already mapped to 403 by the three services) if the new total would exceed the ceiling.
- The ceiling comes from one function instead of the pinned `12000` literals.
- In the S4 PR: KF-AI2 and KF-AI3 become `FIXED_BY_S4`; new invariants prove three agents never exceed the ceiling and concurrent same-agent prepares are serialized with one refused; INV-1 and INV-6 expected lists gain the new S4 functions and triggers.

### Evidence after a mid-flight lapse (KF-AI14)

- `record_*` and `fail_*` must not depend on the start gate. They should check only that the invocation is the caller's own `SENDING` row in the current tenant, so a result or UNKNOWN/FAILED outcome is always recorded once the provider has been called. Start and reserve stay gated.
- **Done in S4-a (migration 0193):** KF-AI14 is `FIXED_BY_S4A` and its probe is replaced by INV-13 (exactly one ledger row after a lapse, hold released, result held until access returns). See `HON_AI_SPEND_DURABLE_EVIDENCE_S4A.md`.

### What stays open after S4

- KF-AI8 stays `OPEN` until the owner decides AI-D3 and a resolution slice is approved.
- Dollar backstop, rate limits, alerts and reconciliation remain separate work.

## Updating the inventory

`ai-spend-entrypoints.json` changes only in a reviewed, owner-approved PR that intentionally changes AI spend authority.

1. Provision the fixture and run the proof with `--print-inventory`. It prints the collected inventory and runs nothing else.
2. Review every difference by hand. A new spend path, grant, ceiling or trigger needs an explanation in the PR.
3. Copy the reviewed lists into the JSON. Keep `knownFailures` and the metadata fields.
4. When a PR fixes a known failure, set its status to `FIXED_BY_<slice>` and replace the probe with the invariant in the same PR.

## Collection patterns (for reviewers extending INV-1)

The inventory is collected from `pg_proc`, `pg_trigger` and ACLs in schema `hon`:

- Spend functions: the begin, prepare, record and fail functions of the three agents plus B3 reserve, finalize, release and expire.
- Ledger writers: functions whose body inserts into `ai_usage_ledger`.
- Reservation writers: functions whose body updates `reserved_credits` on an agent table or writes `saas_credit_reservations`.
- Allowance and credit-ledger writers: functions writing `saas_credit_allowances` or `saas_credit_ledger`.
- Ceiling literals: function bodies containing `12000`.
- Spend references: any function body referencing `reserved_credits`, `customer_credits`, `ai_usage_ledger` or `saas_credit_`.
- Grants: `has_function_privilege` for the runtime role, `aclexplode` of the function ACL for PUBLIC, and the Supabase client roles when they exist.

## Local mutation checks performed when AI-0 was built

Each mutation was applied only to the disposable database (or to a temporary copy of the inventory) and never committed. Every one failed the proof:

| Mutation | Caught by |
|---|---|
| Remove one inventory entry | INV-1 |
| `GRANT EXECUTE` on a spend function to PUBLIC | INV-2 |
| Set the credit program ACTIVE | INV-3 |
| Seed one credit allowance row | INV-4 |
| Scratch ledger writer that reads `saas_trial_program` (inventory updated to accept it) | INV-5 |
| Scratch trigger refusing Chad's reservation near the ceiling (inventory updated to accept it) | KF-AI2 "behavior changed silently" |

Without the inventory update, the last two are caught earlier by INV-1 (new spend reference) and INV-2 (default PUBLIC execute).
