#!/usr/bin/env bash
# Runs a focused set of HON PostgreSQL security/integrity proofs against a DISPOSABLE local
# PostgreSQL on localhost:5432. It reuses the repository's own guarded setup scripts unchanged:
# each one creates a marked, dedicated database and least-privilege owner/runtime roles, applies
# every migration, and writes generated credentials to a private mode-0600 file.
#
# Safety:
# - Runs only on an ephemeral GitHub-hosted runner, or locally with HON_DB_PROOFS_LOCAL=1.
# - Never reads or accepts a DATABASE_URL; the setup scripts refuse anything but localhost:5432.
# - Every setup/proof runs under `env -i` with only PATH/HOME/LANG, so no token, provider key,
#   or CI credential is visible to it (the scripts also refuse such variables themselves).
set -euo pipefail

if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  [[ "${RUNNER_ENVIRONMENT:-}" == "github-hosted" ]] || { echo "Refusing: database proofs run only on ephemeral GitHub-hosted runners." >&2; exit 1; }
elif [[ "${HON_DB_PROOFS_LOCAL:-}" != "1" ]]; then
  echo "Refusing: set HON_DB_PROOFS_LOCAL=1 to run against your own disposable localhost:5432 PostgreSQL." >&2
  exit 1
fi
if [[ -n "${DATABASE_URL:-}" || -n "${HON_RUNTIME_DATABASE_URL:-}" ]]; then
  echo "Refusing: unset DATABASE_URL/HON_RUNTIME_DATABASE_URL; fixtures generate their own disposable credentials." >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
scripts="$repo_root/packages/database/scripts"
# The setup scripts only write credentials beneath this private job root.
job_dir="/home/ubuntu/jobs/ci_db_proofs"
if [[ ! -d "$job_dir" ]]; then
  sudo mkdir -p "$job_dir"
  sudo chown "$(id -u):$(id -g)" /home/ubuntu /home/ubuntu/jobs "$job_dir"
fi
chmod 700 "$job_dir"
rm -f "$job_dir"/*.env
# Remove generated disposable credentials on every exit path, including failures.
# The adult CRM draft fixture owns a nested private cluster, so also clean its
# mode-0600 environment file and stop its process even when its proof fails.
adult_draft_dir=''
cleanup() {
  rm -f "$job_dir"/*.env "$job_dir"/*/*.env
  if [[ -n "$adult_draft_dir" && -d "$adult_draft_dir/pgdata" ]]; then
    /usr/lib/postgresql/16/bin/pg_ctl -D "$adult_draft_dir/pgdata" -m fast -w stop >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

clean_env=(env -i "PATH=$PATH" "HOME=$HOME" "LANG=C.UTF-8")
passed=0
summary=()

setup() { # name, target-variable, database, env-file-variable
  local name="$1" target_var="$2" database="$3" file_var="$4"
  echo "::group::Provision disposable fixture: $name"
  "${clean_env[@]}" "$target_var=postgresql://localhost:5432/$database" "$file_var=$job_dir/$name.env" \
    node "$scripts/setup-$name-validation.mjs"
  echo "::endgroup::"
}

proof() { # fixture, script, description
  local fixture="$1" script="$2" description="$3"
  echo "::group::$description ($script)"
  # shellcheck disable=SC2016 # positional parameters are expanded by the inner shell on purpose
  "${clean_env[@]}" bash -c 'set -a; . "$1"; set +a; cd "$2" && node "scripts/$3"' _ "$job_dir/$fixture.env" "$repo_root/packages/database" "$script"
  echo "::endgroup::"
  passed=$((passed + 1))
  summary+=("| $description | \`$script\` | pass |")
}

# Public lead forms use the uniquely marked marketing fixture. Keep its descriptor
# separate from every other proof and invoke the package's existing db:test-public-forms
# command so it builds the current contracts/config/database/API before both proofs.
public_forms_fixture='public-lead-forms'
echo "::group::Provision disposable fixture: $public_forms_fixture"
"${clean_env[@]}" \
  HON_CAMPAIGN_VALIDATION_TARGET=postgresql://localhost:5432/hon_campaign_validation \
  HON_CAMPAIGN_ENV_FILE="$job_dir/$public_forms_fixture.env" \
  node "$scripts/setup-marketing-validation.mjs"
echo "::endgroup::"
echo "::group::Public lead forms: current-school monitor, signed session, lifecycle and ingress integrity"
# shellcheck disable=SC2016 # descriptor is sourced only inside the clean subprocess.
"${clean_env[@]}" \
  HON_CAMPAIGN_VALIDATION_TARGET=postgresql://localhost:5432/hon_campaign_validation \
  bash -c 'set -a; . "$1"; set +a; cd "$2" && pnpm --filter @hon/database db:test-public-forms' _ "$job_dir/$public_forms_fixture.env" "$repo_root"
echo "::endgroup::"
passed=$((passed + 1))
summary+=("| Public lead forms: current-school monitor, signed session, lifecycle and ingress integrity | \`db:test-public-forms\` | pass |")

setup class-sessions-read HON_CLASS_SESSIONS_READ_VALIDATION_TARGET hon_class_sessions_read_validation HON_CLASS_SESSIONS_READ_ENV_FILE
proof class-sessions-read test-security-boundaries.mjs "Tenant isolation, restricted runtime role, parent-family boundaries"
proof class-sessions-read test-outbox-leases.mjs "Outbox leases never treat UNKNOWN as published"
proof class-sessions-read test-class-sessions-read-integrity.mjs "Class Sessions current-school read boundary"

setup crm-lead-close HON_CRM_LEAD_CLOSE_VALIDATION_TARGET hon_crm_close_validation HON_CRM_LEAD_CLOSE_ENV_FILE
proof crm-lead-close verify-rls.mjs "Forced RLS on every tracked operational table"
proof crm-lead-close test-crm-lead-close-integrity.mjs "CRM lead close authority, atomicity and replay"

setup champions-club HON_CHAMPIONS_VALIDATION_TARGET hon_champions_validation HON_CHAMPIONS_ENV_FILE
proof champions-club test-a2p-preparation-integrity.mjs "A2P-1: read-only exact-school owner-confirmed registration preparation, live IAM/entitlement checks, signed-session API/database, no public fetching or provider/consent/message effects"
proof champions-club test-champions-club-integrity.mjs "Champions Club authority, attribution, qualification gates and evidence"
proof champions-club test-champions-club-rewards-integrity.mjs "Champions Club reward accounting: liabilities, approvals, reversals, no billing effect"
proof champions-club test-champions-club-leaderboard-integrity.mjs "Champions Club leaderboards: qualified-only standings, privacy, holds, statistics"
proof champions-club test-champions-club-contests-integrity.mjs "Champions Club contests: HQ lifecycle, frozen standings, winner review, liabilities"
proof champions-club test-champions-club-journey-integrity.mjs "Champions Club end-to-end journey: code to winner, automatic reward reconciliation, audit"
proof champions-club test-saas-subscription-integrity.mjs "HON subscription catalog (B1): owner-only offers, atomic founder inventory, entitlement-linked records, no billing effect"
proof champions-club test-saas-invoicing-integrity.mjs "HON invoices and payment evidence (B2): gapless numbering, verified tax before issue, HQ attestation only, no collection or reward effect"
proof champions-club test-saas-credits-integrity.mjs "HON premium credits (B3): owner-gated program, verified-cost pricing, reserve/finalize/release/expire ledger, concurrency-safe balance"
proof champions-club test-saas-refunds-rewards-integrity.mjs "HON refunds and Champions rewards (B4): 30-day first-purchase guarantee records, owner-gated reward application, alerts block fulfillment, no execution or payout"
proof champions-club test-saas-payments-integrity.mjs "HON payments (B5, test mode, simulated Stripe): hosted checkout, signature-verified idempotent webhooks, provider-verified accounting, renewals, refunds, recovery"
proof champions-club test-saas-school-billing-integrity.mjs "HON school billing reads (B5.1) and inactive paid-access foundation: exact-school billing.hon.view, organization billing, stable pagination, verified vs recorded, dry run with enforcement NONE"
proof champions-club test-language-preferences-integrity.mjs "Interface language persistence: self-only personal preference, exact-school audited default, precedence, idempotent race-safe updates"
proof champions-club test-saas-paid-access-integrity.mjs "HON paid access B6A (program INACTIVE; ACTIVE simulated in the disposable DB only): awaiting first payment, server-decided tier and allowance on verified payment, replay/out-of-order/tampering/refund safeguards, HQ review and retry"
proof champions-club test-saas-hon-os-offers-integrity.mjs "HON OS commercial offers (0181): one product, HQ-priced versioned offers, owner-only digest-approved publication, immutable published offers, stop-sales, exact-school discovery, legacy billing untouched"
proof champions-club test-saas-hon-os-purchase-integrity.mjs "HON OS purchase binding (0182): six HQ-published offers bought end to end in TEST MODE through the simulated Stripe adapter at the exact accepted offer, sale limit and founder pool under contention, review paths, renewals, refunds and disputes"
proof champions-club test-saas-hon-os-new-school-onboarding.mjs "HON OS new-school onboarding (0183, D7; paid access ACTIVE simulated in the disposable DB only): private registration awaiting first payment, HON OS purchase without an active entitlement, verified activation for every offer kind, failed/cancelled/expired/out-of-order/replayed payments, HQ retry with sale-limit and founder rechecks"
proof champions-club test-saas-hon-os-only-new-sales.mjs "HON OS-only new sales (0184, D8; legacy sales pinned CLOSED, reopened only to build the pre-closure fixture): every legacy sale path refused for new customers (school/HQ checkout, replayed keys, provider sessions, HQ records and founder holds, direct writes), stale legacy payments held for review, HON OS-only first purchases, legacy customers' renewals, refunds, disputes and lifetime rights unchanged"
proof champions-club test-saas-secure-hq-provisioning.mjs "Secure HQ provisioning (0185, D9): provisioned schools get no access, capability or credits; only a current HQ owner grants a scoped, 90-day-capped, audited, idempotent exception (operators, support, school owners, AI/delegated contexts, forged fields and direct writes refused); revocation, expiry, scheduling and closing; revoke-first pilot conversion (awaiting-first-payment refused while an exception is active or scheduled, then D7 after revocation or expiry); never a purchase basis or widened by a tier change; existing customers, D7 first purchase and D8 closure unchanged"
proof champions-club test-saas-subscription-generation-integrity.mjs "Commercial B1 0189: immutable A2 generation lineage, zero provider binding, human authorization, race-safe exact retries and inert billing gates"
proof champions-club test-saas-schedule-billing-integrity.mjs "Commercial B2 0191: TEST-only deterministic schedule binding, exact paid-period evidence/reconciliation, lifecycle exclusion, forced RLS and no checkout/access effect"
proof champions-club test-saas-price-acceptance-integrity.mjs "Commercial A2: immutable schedules/disclosures, signed-session acceptance, authorization/lock races, no billing"
proof champions-club test-saas-trial-governance-integrity.mjs "D11-A: isolated trial policy/campaign metadata, owner-only bounded publication, immutable decisions, concurrency and no activation"
proof champions-club test-saas-exception-policy-integrity.mjs "D10 exception-only approval: no policy means no grant; validity, owner authority, immutable binding, atomic evidence, concurrent withdrawal, no credits or payment activation"
proof champions-club test-saas-access-exception-hardening.mjs "Access exception hardening (0185, D9 review corrections): revocations and grants that wait while HQ-owner authority is revoked or expires commit nothing, later authority changes wait without deadlock, same-key retries; closing works through more than 200 open exceptions without closing live ones; Champions contest eligibility and freeze require the entitlement window"
proof champions-club test-entitlement-enforcement-coverage.mjs "B6A behavioural entitlement coverage: every runtime-callable function called for ACTIVE vs SUSPENDED organizations; reviewed allowlist, recorded gaps, no cross-organization access"

# CRM adult registration to membership DRAFT (Manus PR #27 lineage, migrations 0159, 0160, 0162, 0163).
setup flexible-billing-accounts HON_FLEXIBLE_BILLING_ACCOUNTS_VALIDATION_TARGET hon_flexible_billing_accounts_validation HON_FLEXIBLE_BILLING_ACCOUNTS_ENV_FILE
proof flexible-billing-accounts test-flexible-billing-account-integrity.mjs "Flexible billing accounts: deterministic canonical backfill, explicit audited additional accounts, direct-human authority"
proof flexible-billing-accounts test-billing-account-crm-draft-compatibility-integrity.mjs "Billing account vs adult CRM DRAFT: both lock arrival orders without deadlock or duplicates; pre-0159 idempotency replay preserved"
proof flexible-billing-accounts test-crm-owner-launch-lock-order-integrity.mjs "Owner Launch / CRM / billing canonical lock order: every workflow paused at every lock stage against every other; pre-0169 deadlocks reproduced, none with 0169"
proof flexible-billing-accounts test-crm-lead-registration-recovery-integrity.mjs "CRM lead registration recovery (0174): read-only session recovery, historical receipt vs current DRAFT, stale/revoked/duplicate/cross-school refusal, zero effects"
proof flexible-billing-accounts test-school-membership-plan-catalog-integrity.mjs "School membership plan catalog (0175): per-school versioned plans, immutable terms, AVAILABLE-only staff options, plan-bound adult DRAFT with exact version binding, no schedule/invoice/payment effect"
proof flexible-billing-accounts test-crm-guardian-child-enrollment-integrity.mjs "CRM guardian/child enrollment (0176): separate guardian/child identities, explicit payer designation through the canonical account, additional children with staff-review ambiguity, one plan-bound DRAFT per child, no schedule/invoice/payment effect"
proof flexible-billing-accounts test-membership-activation-gate-integrity.mjs "Membership activation gate (0177): two-step human preview and confirmation, runtime UPDATE revoked and settings-free transition trigger, school-scoped activate/override/cancel authority with live re-checks, identity-review override, school-local inclusive dates across DST, exact idempotency and concurrency, no payment or entitlement effect"
proof flexible-billing-accounts test-membership-date-revision-integrity.mjs "Membership date revisions (0178): two-step human date revisions bound to immutable history by the extended settings-free trigger, owner-only retroactive authority with live re-checks, school-local inclusive dates, legacy confirmation queue and exact status totals, no-deadlock races with invoices, cancellation, renewal and retention, no payment or financial effect"
setup crm-lead-registration HON_CRM_LEAD_REGISTRATION_VALIDATION_TARGET hon_crm_registration_validation HON_CRM_LEAD_REGISTRATION_ENV_FILE
proof crm-lead-registration test-crm-lead-registration-integrity.mjs "CRM lead registration: direct-human scope, adult/guardian-child identity separation, idempotency, rollback, no payment or membership effect"

# Owner Launch regression (registration, booking, membership DRAFT and confirmations) over the full
# migration chain, including 0169's re-created confirmation body. Its test loads the generated
# descriptor itself and refuses inherited database URLs, so it is not sourced like the others.
setup owner-launch HON_OWNER_LAUNCH_VALIDATION_TARGET hon_owner_launch_validation HON_OWNER_LAUNCH_ENV_FILE
echo "::group::Owner Launch regression (test-owner-launch-integrity.mjs)"
"${clean_env[@]}" "HON_OWNER_LAUNCH_ENV_FILE=$job_dir/owner-launch.env" bash -c 'cd "$1" && node scripts/test-owner-launch-integrity.mjs' _ "$repo_root/packages/database"
echo "::endgroup::"
passed=$((passed + 1))
summary+=("| Owner Launch regression: registration, booking, membership DRAFT and confirmations unchanged | \`test-owner-launch-integrity.mjs\` | pass |")

# This proof needs an isolated PostgreSQL cluster because the application-wide
# local PostgreSQL service can already contain developer-created roles. It still
# refuses every non-local target and uses a private 0700 runner job directory.
adult_draft_fixture='crm-adult-membership-draft'
adult_draft_dir="$(mktemp -d "$job_dir/$adult_draft_fixture.XXXXXX")"
chmod 700 "$adult_draft_dir"
echo "::group::Provision disposable fixture: $adult_draft_fixture"
"${clean_env[@]}" \
  HON_CRM_ADULT_MEMBERSHIP_DRAFT_VALIDATION_TARGET=postgresql://127.0.0.1:55435/hon_crm_adult_membership_draft_validation \
  HON_CRM_ADULT_MEMBERSHIP_DRAFT_ENV_FILE="$adult_draft_dir/$adult_draft_fixture.env" \
  HON_CRM_ADULT_MEMBERSHIP_DRAFT_PGDATA="$adult_draft_dir/pgdata" \
  node "$scripts/setup-crm-adult-membership-draft-validation.mjs"
echo "::endgroup::"
echo "::group::Adult CRM registration to one membership DRAFT"
# shellcheck disable=SC2016 # positional parameters are expanded by the inner shell on purpose
"${clean_env[@]}" bash -c 'set -a; . "$1"; set +a; cd "$2" && node scripts/test-crm-adult-membership-draft-integrity.mjs' _ "$adult_draft_dir/$adult_draft_fixture.env" "$repo_root/packages/database"
echo "::endgroup::"
passed=$((passed + 1))
summary+=("| Adult CRM registration to one membership DRAFT | \`test-crm-adult-membership-draft-integrity.mjs\` | pass |")
/usr/lib/postgresql/16/bin/pg_ctl -D "$adult_draft_dir/pgdata" -m fast -w stop >/dev/null
rm -f "$adult_draft_dir/$adult_draft_fixture.env"

echo "All $passed disposable-database proofs passed (8 fixtures, all migrations applied)."
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### Disposable PostgreSQL proofs"
    echo "| Proof | Script | Result |"
    echo "| --- | --- | --- |"
    printf '%s\n' "${summary[@]}"
  } >> "$GITHUB_STEP_SUMMARY"
fi
