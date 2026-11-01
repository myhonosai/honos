# HON commercial staging rehearsal — disposable local only

This prepares **isolated validation**, not a staging deployment or permission to use real schools. Baseline: `b49cfc33b32def303bc05c41c17dd92c46d448a2` (0185/D9). The runner accepts **no database URL**. No migration, runtime route, commercial policy, customer-checkout control or activation switch is changed.

D10 extends the reviewed migration ceiling through additive 0186. The original 0181–0185 hashes remain pinned unchanged. The exception-only decision ledger must be empty in shipped posture before and after each proof. Explicit APPROVED decisions are synthetic test fixtures only; full PAID_ACCESS terms remain PROPOSED.

## What is exercised

`packages/database/scripts/run-commercial-staging-validation.mjs` reuses the canonical Champions disposable setup, unmodified migrations, existing security registries and eleven proofs (including D10 and D11-A governance). Each proof gets a newly migrated database; each database is destroyed and its roles removed before the next proof. The repeated cycles verify repeatability without sharing synthetic state.

| Proof | Coverage | Explicit disposable simulation |
| --- | --- | --- |
| `test-saas-hon-os-offers-integrity.mjs` | 0181 whole-set offers, revision/digest publication, immutable terms | Legacy fixture reopening, restored CLOSED |
| `test-saas-hon-os-purchase-integrity.mjs` | 0182 accepted prices, D6 ordinary retirement versus explicit emergency stop, expiry, founder contention, legacy continuity | Legacy fixtures and in-memory Stripe simulator |
| `test-saas-hon-os-new-school-onboarding.mjs` | 0183 first purchase, pending/failed/replayed payments, no AI credits even when the credit program is enabled | Paid access and the credit program temporarily ACTIVE; no AI grants; simulator |
| `test-saas-hon-os-only-new-sales.mjs` | 0184 legacy sales closure, stale checkout/replay guards, HON OS-only purchases, existing customer continuity | Pre-closure fixtures and paid-access simulation |
| `test-saas-secure-hq-provisioning.mjs` | 0185 SUSPENDED provisioning, explicit owner exceptions, tenant denial, revoke-first conversion | Paid access temporarily ACTIVE; simulator |
| `test-saas-exception-policy-integrity.mjs` | 0186 policy validity, owner authority, immutable evidence/binding, rollback, real policy/grant lock races | Synthetic exception-only decisions; paid access INACTIVE |
| `test-saas-access-exception-hardening.mjs` | Live authority during waits/replay, concurrency, rollback, >200 cleanup batches, contest evaluation/freeze windows | Paid access remains INACTIVE |
| `test-entitlement-enforcement-coverage.mjs` | Runtime-callable functions for ACTIVE/SUSPENDED/expired/future windows, reviewed recovery allowlist, cross-tenant denial | Paid access remains INACTIVE |
| `test-champions-club-contests-integrity.mjs` | Contest lifecycle, winner evidence, liabilities, immutable frozen results | Paid access remains INACTIVE |
| `test-champions-club-journey-integrity.mjs` | Referral through contest/reward accounting regression | Paid access remains INACTIVE |

These are actual API-service/PostgreSQL proofs, **not browser tests or signed-session HTTP verification**. Existing proof limitations (generic inputs that do not reach every entitlement decision, controlled pre-D9 fixtures, simulated provider evidence) remain limitations. No real Stripe sandbox proof or populated persistent-database upgrade certification is claimed.

## Guards and evidence

- Linux, explicit `--confirm-disposable-local`, and a fresh private report file are required. CI additionally requires an ephemeral GitHub-hosted runner. No inherited DB URL, PG connection override, provider credential, execution switch or Node preload is accepted. The CI launcher first refuses caller DB URLs, then uses the existing proof workflow's `env -i` allowlist; inherited CI metadata/credentials never enter the rehearsal process. Refusals may name environment keys but never their values or application database names.
- Only the fixed local maintenance socket `/var/run/postgresql` at port 5432 is used for setup. PostgreSQL must listen on loopback. Before **any setup/drop**, the instance must have only its three default databases, no custom roles, and no application objects in `postgres`. Even an old marked fixture is refused at entry. **Never run on a shared/local application database service.**
- A mode-0600 exclusive lock under the mode-0700 owned `/home/ubuntu/jobs` prevents concurrent rehearsals. Symlinked directories, descriptors, locks and existing report files are refused. Existing setup uses its secure exclusive descriptor writer; credentials are parsed as closed data, never sourced/evaluated by this runner.
- Canonical migrations are applied in sorted order, and the actual migration ledger is checked for the exact full sequence and application order. All **179** files are SHA-256 pinned as one chain; individual 0181–0187 hashes are in `commercial-staging-manifest.json` and the report. Reserved 0179/0180 remain absent. Changes or a later migration ceiling require a reviewed manifest update. This is a clean-database sequencing rehearsal; persistent/old-history baselines remain a separate gate.
- Before and after each proof, both existing SaaS and Champions security registries run. The runner verifies INACTIVE paid access, `mutations_enabled=false`, INACTIVE AI credits/rewards, DISABLED payment program, pinned CLOSED legacy new sales, unchanged PROPOSED records/terms, restored CHECK definitions and enabled security triggers.
- Test-only `hon_validation` tripwires refuse AI allowance/reservation/ledger/usage inserts or updates. Their existence and zero ledger counts are verified. A zero-row insert proves the tripwire fires without a grant. The credit program is additionally pinned INACTIVE in every fixture **except the existing D7 proof**, whose explicit purpose is to demonstrate zero grants even with that program temporarily ACTIVE. That sole fixed-plan exception is unit-tested and recorded in the report; D7 must restore INACTIVE before it passes. The AI-write tripwires remain enabled throughout every proof. These guards are never migrations or runtime services.
- Each proof has a preload that permits only canonical loopback PostgreSQL sockets, checks DNS results, and refuses HTTP/fetch, TLS, UDP, external DNS, child processes and workers. Even a caught attempt makes the proof fail. Sanitized counters are retained. This is an accidental-egress tripwire for the **fixed, reviewed proof scripts**, not a sandbox for malicious arbitrary code. No untrusted proof names or target URLs are accepted.
- All provider outcomes use existing in-memory simulators. No provider credentials/worker switches are passed. No external delivery worker, real checkout, Stripe webhook registration, live payment or real-school operation runs.
- Each successful simulation must restore **the same fixture's** complete shipped posture before cleanup. A missing restoration fails the run. An unsuccessful run stays failed; failure recovery attempts to destroy only the owned, marked fixture, re-create and verify canonical shipped posture, then destroy it. This is separately labelled as fresh-fixture recovery, never a passing original simulation.
- Cleanup checks exact DB/role markers before destruction, then verifies the server is empty again. Some older proofs deliberately retain synthetic audit-bound school rows; deleting the whole owned fixture removes them without rewriting historical audit. Hard process/host destruction can leave a stale lock/marked fixture; the next run refuses it. Inspect and recover only on the dedicated throwaway host, rather than adding a force/bypass option.

The sanitized report contains the source SHA, all migration hashes, proof labels/results, shipped-versus-simulated states, policy gap, zero-grant counts, network counters, failures and cleanup evidence. It contains no connection strings or keys. Only that JSON is uploaded as a private seven-day Actions artifact; credential files never leave the job and are removed during cleanup.

## Reproduce on a fresh throwaway Linux VM

Use patched Node **22.23.4**, pnpm **10.18.0**, PostgreSQL **16**, `sudo`, `psql`, Python 3 and Git. The VM must have no customer data, provider credentials or existing application databases/roles. Dependency installation/build uses normal supported network configuration; rehearsal itself requires no Internet.

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm prepare:workspace
corepack pnpm --filter @hon/api build
node --test packages/database/scripts/commercial-staging.test.mjs
sudo systemctl start postgresql.service
sudo mkdir -p /home/ubuntu/jobs
sudo chown "$(id -u):$(id -g)" /home/ubuntu /home/ubuntu/jobs
chmod 700 /home/ubuntu/jobs
hon_staging_report_dir=$(mktemp -d /tmp/hon-commercial-report.XXXXXX)
node packages/database/scripts/run-commercial-staging-validation.mjs \
  --confirm-disposable-local --report "$hon_staging_report_dir/report.json"
```

Run the final command again with a **new** private report directory to repeat. No old report, fixture, lock or caller DB URL is reused. In GitHub, the narrowly scoped `Commercial staging rehearsal (disposable only)` workflow runs on this same-repository draft PR; it has contents-read permission, no deployment event, no secrets, and separate repository-check/rehearsal jobs. The ordinary repository CI intentionally skips draft PRs; a skip is not a pass. Exact final-head results belong on the draft PR.

## Exact policy-recording gap — remains unresolved

There are distinct records; they must not be conflated:

1. `hon.saas_policy_decisions` still has an **UNDECIDED** `PAID_ACCESS` projection. Its latest append-only `hon.saas_policy_records` entry is version **2**, **PROPOSED**, `HON_RECOMMENDED_TERMS_V1` (0170). Source-design approval is not a persisted policy approval.
2. `hon.saas_access_policy_terms` version **1** is **PROPOSED**, constrained by `CHECK (status = 'PROPOSED')` and immutable UPDATE/DELETE/TRUNCATE triggers. It cannot simply be updated to APPROVED. It includes the entire proposed paid-access policy, not just exceptions.
3. In 0185, `grant_saas_access_exception` and `guard_saas_access_exception_grant` read the latest terms' version, `exception_authority='HQ_OWNER'` and 90-day maximum, and revalidate live human HQ-owner authority/window/scope. They **do not require approved policy status or a separate approval record**. Therefore a database grant can succeed while the paid-access policy/terms remain PROPOSED and the paid-access program remains INACTIVE. The D9 proof demonstrates this using synthetic schools; the runner verifies that the policy records remain unchanged.

**Release gate:** do not use exceptions for real schools merely because these tests or the source review pass. The current enforcement does not implement a policy-approval gate. This PR reports that fact; it does not claim to fix it or record approval. Paid access and AI credits stay INACTIVE.

## Proposed exception-only approval design — later owner/backend review

Proposal only; **no table, route, permission, approval record or migration is implemented here**:

- A separate private append-only **EXCEPTION_ONLY** approval record could reference the exact immutable terms-v1 exception subset and canonical digest: purposes, HQ-owner/direct-human authority, maximum 90 days, scheduling bound, no open-ended grants, no AI credits, no grant to an awaiting school and revoke-first conversion.
- Bind it to an explicit owner decision reference, authenticated approving owner, approval time, effective window and version. Record revocation/supersession as immutable evidence. Revalidate current authority; never accept a browser label, GUC or caller-provided approver as approval.
- A later reviewed additive migration/contract must gate **both** the command and insertion backstop on a current, matching exception-only approval. Grants bind its ID/digest. Share-lock approval/authority in the canonical IAM → request → organization lock order; review revocation, expiry, retry and concurrent policy-change semantics.
- Leave `PAID_ACCESS` records/terms PROPOSED, paid-access INACTIVE and credits INACTIVE. Approving exception administration must not approve first-payment activation, B6B, collection, refunds, lifecycle automation or AI-credit economics.
- Owner decisions still needed: who records/revokes approval, whether any additional confirmation is required, whether revocation affects existing exceptions or only new grants, and how future versions supersede old approvals. Future tests must cover missing/proposed/revoked/expired approval, digest mismatch, stale/replayed grants, direct writes and concurrent revocation with no partial effects.

## Remaining gates

Independent review of this draft and its exact-head evidence; exception-only policy approval design and implementation; real-school usage approval; persistent-database backup/history/checksum review and migration rehearsal; approved paid-access activation milestone; AI-credit economics/policy; separate customer-checkout frontend checkpoint; real Stripe sandbox validation; deployment/monitoring/rollback approval. Nothing in this runner opens those gates.

## D10 closes the historical gap for new grants

The gap described above is the 0185 baseline, not D10 behavior. Migration 0186 requires an explicit current APPROVED exception-only decision for every new grant or renewal. No decision is seeded and no actual policy is approved. Prior exceptions are not retroactively approved or repriced; revocation/expiry cleanup remain available. See [D10 architecture](HON_ACCESS_EXCEPTION_POLICY_D10.md). D9 proofs now create explicitly labelled synthetic decisions via the guarded test-only helper and remove them before shipped-posture verification. Full policy records/terms remain PROPOSED.

## D11-A governance-only extension

Additive 0187 adds no seeded approval or campaign. Its closed trial program is INACTIVE with signup, enrollment and promotional issuance false. The additional guarded proof uses synthetic HQ trial-policy/publication metadata only, independently tests D9/D10 scope separation, and checks all pre-existing domain tables for no effects. Every rehearsal cycle verifies empty trial-governance records and the same immutable closed program before/after. See [D11-A](HON_CUSTOMER_TRIAL_GOVERNANCE_D11A.md). The program has no activation API; PUBLISHED campaign definitions are not active trials or public links.
