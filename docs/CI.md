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
| `crm-lead-close` | `verify-rls.mjs` | Forced RLS on **all 185** tracked operational tables, append-only audit/outbox, AI ledger tenant isolation |
| `crm-lead-close` | `test-crm-lead-close-integrity.mjs` | CRM close authority, denial matrix, atomicity, replay |

## Safety controls

- **Triggers:** pull requests targeting `main` (opened, updated, reopened, marked ready) and manual **Run workflow**. Draft PRs are skipped. Docs-only changes (`docs/**`, `*.md`) are skipped. **No schedule. No push-to-main trigger** until the owner approves the minutes (see below).
- **Permissions:** `contents: read` only; checkout does not persist the token.
- **Concurrency:** a newer push to the same PR cancels the older run.
- **Database isolation:** the runner refuses to run unless it is on an ephemeral GitHub-hosted runner (or `HON_DB_PROOFS_LOCAL=1` locally), refuses any inherited `DATABASE_URL`, and runs every fixture and proof under `env -i` with only `PATH`, `HOME`, `LANG`. The fixture scripts also refuse provider, payment, messaging or credential variables and accept only exact `localhost:5432` targets.
- **No secrets** are configured or read.

## Cost estimate (verify against your plan)

These are **estimates**, not billing data. Check **GitHub → Settings → Billing and plans** for the account's actual included minutes and spending limit.

| | Estimate |
| --- | --- |
| Measured locally (4 vCPU) | test 58s · check 31s · build 72s · db:check 1s · DB proofs 9s |
| Per CI run on GitHub-hosted Linux runners | about **8–12 billed minutes** in total across both parallel jobs (dependency install and repeated workspace builds included; private-repo standard runners are slower than the local machine) |
| 100 PR runs / month | ~800–1,200 minutes |
| GitHub Free private-repo allowance | 2,000 Linux minutes / month (Pro and Team plans include more) |

**Why push-to-main is off:** `main` currently receives many direct commits per day (for example, 29 on 2026-10-17). At ~10 minutes each, running CI on every push could use roughly 6,000–9,000 minutes per month, beyond the Free allowance. Options for the owner:

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

- **5 of 70** `db:test-*` proofs run in CI. Most of the others need their own fixture (25 setup scripts with different databases/roles, some on a separate port such as `localhost:55432`). Add them incrementally, measuring minutes as you go.
- CI does not run browser end-to-end tests, and it does not deploy or smoke-test a deployed environment (there is no deployment pipeline).
- Actions are referenced by major version tag (`@v4`). Pinning to commit SHAs is a recommended hardening follow-up.
- Making CI a **required** status check (branch protection) is an owner decision. It would block Manus's direct pushes to `main`, so coordinate first.
