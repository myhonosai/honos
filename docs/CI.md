# HON OS — Continuous Integration (GitHub Actions)

**Workflow:** [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) · **Database proof runner:** [`.github/scripts/run-db-proofs.sh`](../.github/scripts/run-db-proofs.sh)

CI is verification only. It never deploys, never uses repository secrets, never contacts a payment, messaging, AI, or ad provider, and never connects to a shared or remote database.

## What runs

| Job | Steps | Time limit |
| --- | --- | --- |
| **Test, typecheck, build, migrations** | `pnpm install --frozen-lockfile` → `pnpm test` → `pnpm check` → `pnpm build` → `pnpm db:check` → `git diff --exit-code` (the build must not change tracked files) | 25 min |
| **Disposable PostgreSQL security proofs** | Builds the packages the proofs need, starts the runner's preinstalled PostgreSQL 16 on `localhost:5432`, then runs `run-db-proofs.sh` | 15 min |

`run-db-proofs.sh` reuses the repository's own guarded fixture scripts **unchanged**. Each one creates a dedicated, marked database and least-privilege `*_owner` / `*_runtime` roles on localhost, applies **all** migrations, and writes generated credentials to a private mode-0600 file that is deleted on exit.

| Fixture | Proof | What it demonstrates |
| --- | --- | --- |
| `class-sessions-read` | `test-security-boundaries.mjs` | Restricted runtime privileges, permission revocation, parent-family resolution, transaction-bound RLS isolation, composite tenant references |
| `class-sessions-read` | `test-outbox-leases.mjs` | Expired/late outbox leases become UNKNOWN/DEAD_LETTER, never PUBLISHED or auto-retried |
| `class-sessions-read` | `test-class-sessions-read-integrity.mjs` | Current-school Class Sessions read boundary |
| `crm-lead-close` | `verify-rls.mjs` | Forced RLS on **all 244** tracked operational tables, append-only audit/outbox, AI ledger tenant isolation |
| `crm-lead-close` | `test-crm-lead-close-integrity.mjs` | CRM close authority, denial matrix, atomicity, replay |
| `champions-club` | `test-champions-club-integrity.mjs` | Champions Club authority, attribution fraud rules, qualification gates, transitions, immutable evidence, API service on real output |
| `champions-club` | `test-champions-club-rewards-integrity.mjs` | Champions Club reward accounting: ladder accrual, reversal review, owner approvals, liabilities, no billing or entitlement effect |
| `champions-club` | `test-champions-club-leaderboard-integrity.mjs` | Champions Club leaderboards: QUALIFIED-only standings, ties, holds, privacy opt-in, school statistics |
| `champions-club` | `test-champions-club-contests-integrity.mjs` | Champions Club contests: HQ lifecycle and gates, pause-exact standings, frozen results, winner review, liabilities |
| `champions-club` | `test-champions-club-journey-integrity.mjs` | Champions Club end-to-end journey through the API service with automatic reward reconciliation and audit consistency |
| `champions-club` | `test-saas-subscription-integrity.mjs` | HON subscription catalog (B1): owner-only publication, atomic founder inventory under concurrency, entitlement-linked records, undecided policies refused, no billing effect |
| `champions-club` | `test-saas-invoicing-integrity.mjs` | HON invoices and payment evidence (B2): gapless numbering under concurrency, owner-verified tax before issue, HQ attestation never provider-verified, refunds and chargebacks reduce standing, no collection or reward effect |
| `champions-club` | `test-saas-payments-integrity.mjs` | HON payments (B5, **test mode, simulated Stripe**): HQ-registered school to hosted checkout, signature-verified idempotent webhooks (tampered/unsigned/live/conflicting refused), subscription + invoice + PROVIDER_VERIFIED evidence in one transaction, founder contention, expiry/cancel/async failure/late payment, unknown-outcome retry, renewals and PAST_DUE, provider refunds/disputes, missed-webhook recovery |
| `champions-club` | `test-saas-school-billing-integrity.mjs` | HON school billing reads (B5.1): `billing.hon.view` at the exact school only (HQ, support, other organizations, staff without the permission, family-named roles and revoked grants refused); organization-level billing across a two-school organization; complete keyset pagination stable under a concurrent invoice and a shared issue millisecond; drafts, HQ notes and internal references hidden; provider-verified versus HQ-recorded payments; refunds and chargebacks; entitlement, activation and B3 allowance from canonical records; HQ dry run of the PROPOSED paid-access terms with enforcement NONE; the access program cannot be activated; reads write nothing |
| `champions-club` | `test-language-preferences-integrity.mjs` | Interface language persistence: personal preference bound to the verified user (no browser-supplied id) and portable across schools; school default only with `settings.language.manage` at the exact school, audited and never overwriting personal preferences; precedence personal > named school default > English; idempotent, version-checked, race-safe updates; append-only evidence; tenant/action context refused |
| `champions-club` | `test-saas-paid-access-integrity.mjs` | HON paid access B6A: the program ships INACTIVE and every B6A command is refused; ACTIVE is simulated only inside the disposable database and restored. HQ-owner-only, versioned, idempotent placement awaiting first payment (entitlement held SUSPENDED, no capabilities; billing, plan and checkout stay open); the school picks Core or Complete at a server-frozen price; a signature-verified payment activates the purchased tier, the access state and the full 12,000/5,000 allowance once in one transaction under six concurrent deliveries and an out-of-order invoice; Core lacks the Complete capabilities; tampered amounts, late payments, an inactive program and a forced failure become HQ review states with no partial grant; HQ-owner retry completes held or failed activations and refuses refunded payments; simultaneous purchases isolated; provisioned schools untouched |
| `champions-club` | `test-entitlement-enforcement-coverage.mjs` | B6A behavioural entitlement coverage: every runtime-callable function is called by an all-permission school owner for an ACTIVE and a SUSPENDED organization (rolled back); unreviewed open functions, a broken billing-recovery path, a changed recorded gap or an un-gated function fail the proof; no cross-organization access |
| `champions-club` | `test-saas-refunds-rewards-integrity.mjs` | HON refunds and Champions rewards (B4): first-purchase 30-day eligibility (regular, founder, lifetime), approve/deny/evidence, refund reserve, duplicate refusal under contention, ladder application once per entry, credit capped and restored on void, free months never invoiced with full allowance, alerts block fulfillment without reversal |
| `champions-club` | `test-saas-credits-integrity.mjs` | HON premium credits (B3): owner-gated activation, verified-cost-linked pricing, one allowance per period, idempotent reserve, finalize/release/unknown/resolve, exact balance under 8-way contention, thresholds and hard stop, plan capabilities, suspension, expiry without rollover |
| `flexible-billing-accounts` | `test-flexible-billing-account-integrity.mjs` | Flexible school-to-family billing accounts (0159): deterministic canonical backfill of pre-existing rows, one canonical account per payer under concurrency, explicit audited additional accounts, direct-human authority, no payment/membership effect |
| `flexible-billing-accounts` | `test-billing-account-crm-draft-compatibility-integrity.mjs` | Billing-account command vs adult CRM DRAFT held deterministically in both lock arrival orders (no deadlock, duplicate account/membership or partial transaction); pre-0159 billing-account idempotency records replay their original receipt, different requests under the same key refused |
| `flexible-billing-accounts` | `test-crm-owner-launch-lock-order-integrity.mjs` | Lock-order matrix for 11 Owner Launch, CRM registration/DRAFT, confirmation, billing-account and membership workflows: each paused at every lock stage by a blocker transaction while every other workflow arrives (both orders of every pair). Re-installs the pre-0169 bodies in the disposable database and must observe the reported deadlock, then requires zero failures with 0169; same-key, same-adult and replay-vs-activation races |
| `owner-launch` | `test-owner-launch-integrity.mjs` | Owner Launch regression over the full migration chain: registration, guardian/child, first-class booking, membership DRAFT and both confirmations (authority, RLS, replay, drift, no external effect) |
| `crm-lead-registration` | `test-crm-lead-registration-integrity.mjs` | CRM lead registration (0160): direct-human scope, adult/guardian-child identity separation, idempotency, rollback, no payment/membership/messaging/AI effect |
| `crm-adult-membership-draft` | `test-crm-adult-membership-draft-integrity.mjs` | Adult registered CRM conversion to one membership DRAFT (0162/0163): canonical payer relation proof, replay/race/authority/no-effect coverage. Runs in its own mode-0700 loopback cluster (`127.0.0.1:55435`) |

## Safety controls

- **Triggers:** pull requests targeting `main` (opened, updated, reopened, marked ready) and manual **Run workflow**. Draft PRs are skipped. A PR whose **entire** diff is docs (`docs/**`, `*.md`) is skipped. GitHub evaluates the filter against the whole PR, so a docs-only push to a PR that also changes code still runs CI. **No schedule. No push-to-main trigger** until the owner approves the minutes (see below).
- **Permissions:** `contents: read` only; checkout does not persist the token.
- **Concurrency:** a newer push to the same PR cancels the older run.
- **Database isolation:** the runner refuses to run unless it is on an ephemeral GitHub-hosted runner (or `HON_DB_PROOFS_LOCAL=1` locally), refuses any inherited `DATABASE_URL`, and runs every fixture and proof under `env -i` with only `PATH`, `HOME`, `LANG`. The fixture scripts also refuse provider, payment, messaging or credential variables and accept only exact `localhost:5432` targets.
- **No secrets** are configured or read.

## Cost estimate (verify against your plan)

These are **estimates**, not billing data. Check **GitHub → Settings → Billing and plans** for the account's actual included minutes and spending limit.

| | Estimate |
| --- | --- |
| **Measured on GitHub, run #1** ([39090185996](https://github.com/myhonosai/honos/actions/runs/39090185996), 2026-10-18) | Verify job **4m36s** (install 9s · test 2m09s · check 39s · build 1m27s · db:check 1s); database job **54s** (proofs 8s). Wall clock 4m43s; jobs run in parallel |
| Per CI run | about **6 billed minutes** (GitHub rounds each job up to the whole minute: 5 + 1). The run's usage API reported 0 billable ms, which may mean these minutes are not charged on this account; confirm in Billing |
| 100 PR runs / month | ~600 minutes |
| GitHub Free private-repo allowance | 2,000 Linux minutes / month (Pro and Team plans include more) |

**Why push-to-main is off:** `main` currently receives many direct commits per day (for example, 29 on 2026-10-17). At ~6 minutes each, running CI on every push could use roughly 4,000–5,500 minutes per month, beyond the Free allowance. Options for the owner:

1. Keep CI on PRs only (current) and move agent work to PRs.
2. Add `push: branches: [main]` once the plan's minutes are confirmed; superseded runs are already cancelled.
3. Use **Run workflow** manually on `main` at milestones.

## Running it yourself

- Standard checks: `pnpm install --frozen-lockfile && pnpm test && pnpm check && pnpm build && pnpm db:check`.
- Database proofs on your own **disposable** machine with PostgreSQL 16 on `localhost:5432` (socket `/var/run/postgresql`) and passwordless `sudo -u postgres`:
  `pnpm prepare:workspace && pnpm --filter @hon/api build && HON_DB_PROOFS_LOCAL=1 .github/scripts/run-db-proofs.sh`.
  Never point it at a shared database. The setup scripts drop and recreate their own marked databases.
- Manually on GitHub: **Actions → CI → Run workflow**.

## Known limitations

- **25 of 89** `db:test-*` proofs run in CI. Most of the others need their own fixture (25 setup scripts with different databases/roles, some on a separate port such as `localhost:55432`). Add them incrementally, measuring minutes as you go.
- CI does not run browser end-to-end tests, and it does not deploy or smoke-test a deployed environment (there is no deployment pipeline).
- Actions are referenced by major version tag (`@v4`). Pinning to commit SHAs is a recommended hardening follow-up.
- Making CI a **required** status check (branch protection) is an owner decision. It would block Manus's direct pushes to `main`, so coordinate first.
